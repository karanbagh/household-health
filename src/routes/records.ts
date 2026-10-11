import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/client.js";
import { authenticate } from "../lib/auth.js";
import { VITALS, type VitalStoredType } from "../domain/vitals.js";
import { todayIn } from "../lib/time.js";
import { audit } from "../lib/audit.js";

const text = z.string().trim().max(500);
const name = text.min(1);
const date = z.iso.date().nullable();
const timestamp = z.iso.datetime({ offset: true });
const schemas = {
  members: z.object({ full_name: name, preferred_name: name.nullable(), date_of_birth: date, sex: z.enum(["female", "male", "other", "unknown"]).nullable(), blood_type: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).nullable(), eye_color: name.nullable() }).partial().strict(),
  allergies: z.object({ substance: name, reaction: text.nullable(), severity: z.enum(["mild", "moderate", "severe", "unknown"]), noted_on: date, status: z.enum(["active", "inactive"]) }).partial().strict(),
  medications: z.object({ name, dose_value: z.number().finite().positive().nullable(), dose_unit: name.nullable(), route: text.nullable(), frequency: text.nullable(), prescriber: text.nullable(), reason: text.nullable(), start_date: date, end_date: date, stop_reason: text.nullable(), status: z.enum(["active", "stopped"]) }).partial().strict(),
  vitals: z.object({ value: z.number().finite(), measured_at: timestamp }).partial().strict(),
  appointments: z.object({ starts_at: timestamp, provider_name: text.nullable(), specialty: text.nullable(), location: text.nullable(), reason: text.nullable(), status: z.enum(["scheduled", "completed", "cancelled"]), outcome_notes: text.nullable() }).partial().strict(),
};
const params = z.object({ kind: z.enum(["members", "allergies", "medications", "vitals", "appointments"]), id: z.uuid() });

export async function recordRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  app.get<{ Params: { id: string } }>("/members/:id/records", async (req, reply) => {
    if (!z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: "Invalid member" });
    return withTenant(req.tenant, async (db) => {
      const profile = await db.execute<{ data: Record<string, unknown> }>(sql`select to_jsonb(m) as data from members m where id = ${req.params.id} and deleted_at is null`);
      if (!profile.rows.length) return reply.code(404).send({ error: "Member not found" });
      const records = [{ kind: "members", record: profile.rows[0]!.data }];
      for (const kind of ["allergies", "medications", "vitals", "appointments"] as const) {
        const result = await db.execute<{ data: Record<string, unknown> }>(sql`select to_jsonb(r) as data from ${sql.identifier(kind)} r where member_id = ${req.params.id} and deleted_at is null order by created_at desc`);
        records.push(...result.rows.map(({ data }) => ({ kind, record: data })));
      }
      await audit(db, req.tenant, { action: "read", entity: "records", memberId: req.params.id });
      return records;
    });
  });

  for (const method of ["PATCH", "DELETE"] as const) {
    app.route<{ Params: { kind: string; id: string } }>({ method, url: "/records/:kind/:id", handler: async (req, reply) => {
      if (req.tenant.role === "viewer") return reply.code(403).send({ error: "You have view-only access" });
      const parsed = params.safeParse(req.params);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid record" });
      const { kind, id } = parsed.data;
      const body = method === "PATCH" ? schemas[kind].safeParse(req.body) : null;
      if (body && (!body.success || !Object.keys(body.data).length)) return reply.code(400).send({ error: "Enter valid record details" });
      return withTenant(req.tenant, async (db) => {
        const result = await db.execute<{ data: Record<string, unknown> }>(sql`select to_jsonb(r) as data from ${sql.identifier(kind)} r where id = ${id} and deleted_at is null for update`);
        const record = result.rows[0]?.data;
        if (!record) return reply.code(404).send({ error: "Record not found" });
        // Field names come only from the strict schema, never from unchecked input.
        const changes: Record<string, unknown> = body?.success ? { ...body.data } : { deleted_at: new Date() };
        const merged = { ...record, ...changes };
        if (method === "PATCH") {
          if (kind === "members") {
            const h = await db.execute<{ timezone: string }>(sql`select timezone from households`);
            if (typeof merged.date_of_birth === "string" && merged.date_of_birth > todayIn(h.rows[0]!.timezone)) return reply.code(400).send({ error: "Date of birth cannot be in the future" });
          }
          if (kind === "medications") {
            if (typeof merged.start_date === "string" && typeof merged.end_date === "string" && merged.end_date < merged.start_date) return reply.code(400).send({ error: "End date cannot be before start date" });
            if (merged.dose_value != null && !merged.dose_unit) return reply.code(400).send({ error: "Enter a dose unit" });
          }
          if (kind === "vitals" && changes.value !== undefined) {
            const def = VITALS[record.vital_type as VitalStoredType];
            const value = changes.value as number;
            if (value < def.range[0] || value > def.range[1]) return reply.code(400).send({ error: `Check the ${def.name.toLowerCase()} value (${def.canonicalLabel})` });
            changes.original_value = value; changes.original_unit = def.canonicalLabel;
          }
        }
        if (kind === "members") changes.updated_at = new Date();
        const assignments = Object.entries(changes).map(([key, value]) => sql`${sql.identifier(key)} = ${value}`);
        await db.execute(sql`update ${sql.identifier(kind)} set ${sql.join(assignments, sql`, `)} where id = ${id}`);
        return { status: method === "DELETE" ? "deleted" : "updated" };
      });
    } });
  }
}
