import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { withTenant, type Db, type TenantContext } from "../db/client.js";
import { allergies, appointments, auditLog, households, medications, members, pendingEntries, vitals } from "../db/schema.js";
import { authenticate } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { formatLocal } from "../lib/time.js";
import { VITALS, formatVital, type VitalStoredType } from "../domain/vitals.js";
import { commitProposals, undoRecords, EntryConflict, type CreatedRecord, type Household, type Proposal } from "../domain/entries.js";
import { runChat, type MemberRef } from "../agent/graph.js";
import { traceHandler } from "../agent/llm.js";

async function loadHousehold(db: Db): Promise<{ hh: Household & { name: string }; members: MemberRef[] }> {
  const [h] = await db.select().from(households); // RLS returns only the caller's household
  if (!h) throw new Error("Household not found");
  const ms = await db.select({ id: members.id, fullName: members.fullName, preferredName: members.preferredName, dateOfBirth: members.dateOfBirth })
    .from(members).where(isNull(members.deletedAt)).orderBy(asc(members.createdAt));
  return {
    hh: { id: h.id, name: h.name, timezone: h.timezone, unitSystem: h.unitSystem },
    members: ms.map((m) => ({ id: m.id, name: m.preferredName ?? m.fullName, dateOfBirth: m.dateOfBirth })),
  };
}

const canWrite = (ctx: TenantContext) => ctx.role === "owner" || ctx.role === "editor";

export async function apiRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/me", async (req) => {
    const { hh, members: ms } = await withTenant(req.tenant, loadHousehold);
    return { user: { id: req.tenant.userId, name: req.userName, role: req.tenant.role }, household: hh, members: ms };
  });

  const MemberBody = z.object({
    fullName: z.string().trim().min(1).max(200),
    preferredName: z.string().trim().min(1).max(200).nullable().optional(),
    dateOfBirth: z.iso.date().refine((value) => value <= new Date().toISOString().slice(0, 10), "Date of birth cannot be in the future").nullable().optional(),
    sex: z.enum(["female", "male", "other", "unknown"]).nullable().optional(),
    bloodType: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).nullable().optional(),
    eyeColor: z.string().trim().min(1).max(100).nullable().optional(),
  }).strict();

  app.post("/members", async (req, reply) => {
    const ctx = req.tenant;
    if (!canWrite(ctx)) return reply.code(403).send({ error: "You have view-only access" });
    const body = MemberBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter a name and valid profile details", details: body.error.issues });
    const [m] = await withTenant(ctx, (db) => db.insert(members).values({
      ...body.data, householdId: ctx.householdId, createdBy: ctx.userId,
    }).returning());
    return reply.code(201).send({ id: m!.id, name: m!.preferredName ?? m!.fullName, dateOfBirth: m!.dateOfBirth });
  });

  // ───────────── conversation: questions and LLM-parsed entries ─────────────
  const ChatBody = z.object({
    message: z.string().trim().min(1).max(4000),
    memberId: z.string().uuid().nullable().optional(),
    conversationId: z.string().min(1).max(100),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(20).default([]),
  });

  app.post("/chat", async (req, reply) => {
    const body = ChatBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request", details: body.error.issues });
    const ctx = req.tenant;
    const { hh, members: ms } = await withTenant(ctx, loadHousehold);
    const handler = traceHandler({ userId: ctx.userId, householdId: ctx.householdId, conversationId: body.data.conversationId, requestId: ctx.requestId });

    const result = await runChat({
      ctx, hh, members: ms, defaultMemberId: body.data.memberId ?? null,
      message: body.data.message, history: body.data.history, callbacks: handler ? [handler] : [],
    });

    const traceId = handler?.last_trace_id ?? null;
    if (result.type === "proposal" && traceId) {
      await withTenant(ctx, (db) => db.update(pendingEntries).set({ traceId }).where(eq(pendingEntries.id, result.pendingId)));
    }
    return { ...result, requestId: ctx.requestId, traceId };
  });

  // ───────────── entry lifecycle: confirm, discard, undo ─────────────
  app.post<{ Params: { id: string } }>("/entries/:id/confirm", async (req, reply) => {
    const ctx = req.tenant;
    if (!canWrite(ctx)) return reply.code(403).send({ error: "You have view-only access" });
    try {
      return await withTenant(ctx, async (db) => {
        const [p] = await db.select().from(pendingEntries).where(eq(pendingEntries.id, req.params.id)).for("update");
        if (!p) return reply.code(404).send({ error: "Entry not found" });
        if (p.status !== "pending") return reply.code(409).send({ error: `This entry was already ${p.status}` });
        await db.execute(sql`select set_config('app.trace_id', ${p.traceId ?? ""}, true)`);
        const created = await commitProposals(db, p.memberId, ctx.userId, ctx.householdId, p.sourceText, p.proposals as Proposal[]);
        await db.update(pendingEntries).set({ status: "confirmed", createdRecords: created, resolvedAt: new Date() }).where(eq(pendingEntries.id, p.id));
        await audit(db, { ...ctx, traceId: p.traceId }, { action: "entry_confirmed", entity: "pending_entries", entityId: p.id, memberId: p.memberId, details: { records: created } });
        return { status: "confirmed", records: created.length };
      });
    } catch (err) {
      if (err instanceof EntryConflict) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/entries/:id/discard", async (req, reply) => {
    const ctx = req.tenant;
    return withTenant(ctx, async (db) => {
      const [p] = await db.update(pendingEntries).set({ status: "discarded", resolvedAt: new Date() })
        .where(and(eq(pendingEntries.id, req.params.id), eq(pendingEntries.status, "pending"))).returning();
      if (!p) return reply.code(409).send({ error: "Nothing to discard" });
      await audit(db, ctx, { action: "entry_discarded", entity: "pending_entries", entityId: p.id, memberId: p.memberId });
      return { status: "discarded" };
    });
  });

  app.post<{ Params: { id: string } }>("/entries/:id/undo", async (req, reply) => {
    const ctx = req.tenant;
    if (!canWrite(ctx)) return reply.code(403).send({ error: "You have view-only access" });
    return withTenant(ctx, async (db) => {
      const [p] = await db.select().from(pendingEntries).where(eq(pendingEntries.id, req.params.id)).for("update");
      if (!p || p.status !== "confirmed") return reply.code(409).send({ error: "Only saved entries can be undone" });
      if (p.createdBy !== ctx.userId && ctx.role !== "owner") return reply.code(403).send({ error: "Only the person who saved this can undo it" });
      const records = (p.createdRecords ?? []) as CreatedRecord[];
      for (const record of records) {
        if (!["members", "medications", "allergies", "vitals", "appointments"].includes(record.table)) continue;
        await db.execute(sql`select id from ${sql.identifier(record.table)} where id = ${record.id} for update`);
        const newer = await db.execute(sql`select 1 from audit_log changed join audit_log saved on saved.entity_id = ${p.id}
          and saved.action = 'entry_confirmed' where changed.entity_id = ${record.id}
          and changed.action in ('update', 'delete') and changed.id > saved.id limit 1`);
        if (newer.rows.length) return reply.code(409).send({ error: "This record has changed since it was saved. Use Records to edit or delete its current version." });
      }
      await undoRecords(db, records);
      await db.update(pendingEntries).set({ status: "undone" }).where(eq(pendingEntries.id, p.id));
      await audit(db, ctx, { action: "entry_undone", entity: "pending_entries", entityId: p.id, memberId: p.memberId });
      return { status: "undone" };
    });
  });

  // ───────────── at-a-glance snapshot for one member ─────────────
  app.get<{ Params: { id: string } }>("/members/:id/snapshot", async (req, reply) => {
    const ctx = req.tenant;
    return withTenant(ctx, async (db) => {
      const { hh } = await loadHousehold(db);
      const [m] = await db.select().from(members).where(and(eq(members.id, req.params.id), isNull(members.deletedAt)));
      if (!m) return reply.code(404).send({ error: "Member not found" });
      const id = m.id;
      const [meds, alls, appts, vs] = await Promise.all([
        db.select().from(medications).where(and(eq(medications.memberId, id), eq(medications.status, "active"), isNull(medications.deletedAt))).orderBy(asc(medications.name)),
        db.select().from(allergies).where(and(eq(allergies.memberId, id), eq(allergies.status, "active"), isNull(allergies.deletedAt))),
        db.select().from(appointments).where(and(eq(appointments.memberId, id), isNull(appointments.deletedAt), eq(appointments.status, "scheduled"), gte(appointments.startsAt, new Date()))).orderBy(asc(appointments.startsAt)).limit(5),
        db.selectDistinctOn([vitals.vitalType]).from(vitals).where(and(eq(vitals.memberId, id), isNull(vitals.deletedAt))).orderBy(vitals.vitalType, desc(vitals.measuredAt)),
      ]);
      const bySys = vs.find((v) => v.vitalType === "bp_systolic"), byDia = vs.find((v) => v.vitalType === "bp_diastolic");
      const latestVitals = vs.filter((v) => v.vitalType !== "bp_systolic" && v.vitalType !== "bp_diastolic").map((v) => ({
        id: v.id, name: VITALS[v.vitalType as VitalStoredType].name, value: formatVital(v.vitalType as VitalStoredType, v.value, hh.unitSystem), at: formatLocal(v.measuredAt, hh.timezone),
      }));
      if (bySys && byDia) latestVitals.push({ id: bySys.id, name: "Blood pressure", value: `${bySys.value}/${byDia.value} mmHg`, at: formatLocal(bySys.measuredAt, hh.timezone) });

      await audit(db, ctx, { action: "read", entity: "snapshot", memberId: id, details: {
        records: [...meds, ...alls, ...appts, ...vs].map((r) => r.id) } });
      return {
        profile: { id, name: m.preferredName ?? m.fullName, fullName: m.fullName, dateOfBirth: m.dateOfBirth, sex: m.sex, bloodType: m.bloodType, eyeColor: m.eyeColor },
        allergies: alls.map((a) => ({ id: a.id, substance: a.substance, reaction: a.reaction, severity: a.severity })),
        medications: meds.map((x) => ({ id: x.id, name: x.name, dose: x.doseValue != null ? `${x.doseValue} ${x.doseUnit}` : null, frequency: x.frequency, since: x.startDate })),
        upcoming: appts.map((a) => ({ id: a.id, at: formatLocal(a.startsAt, hh.timezone), with: [a.providerName, a.specialty].filter(Boolean).join(", "), location: a.location })),
        vitals: latestVitals.sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
  });

  // ───────────── audit trail (owners) ─────────────
  app.get<{ Querystring: { limit?: string } }>("/audit", async (req, reply) => {
    const ctx = req.tenant;
    if (ctx.role !== "owner") return reply.code(403).send({ error: "Only household owners can view the audit trail" });
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    return withTenant(ctx, async (db) => {
      const rows = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
      await audit(db, ctx, { action: "read", entity: "audit_log", details: { limit } });
      return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actorUserId, action: r.action, entity: r.entity, entityId: r.entityId, memberId: r.memberId, requestId: r.requestId, traceId: r.traceId, details: r.details, before: r.before, after: r.after }));
    });
  });
}
