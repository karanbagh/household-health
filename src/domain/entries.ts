import { randomUUID } from "node:crypto";
import { and, eq, ilike, isNull, inArray } from "drizzle-orm";
import type { Db, TenantContext } from "../db/client.js";
import { allergies, appointments, medications, members, vitals } from "../db/schema.js";
import type { ExtractedItem } from "../agent/schemas.js";
import { normalizeVital, type NormalizedVital } from "./vitals.js";
import { formatLocal, localToUtc, todayIn } from "../lib/time.js";

export interface Household { id: string; timezone: string; unitSystem: "us" | "metric" }

interface Base { display: string; assumptions: string[] }
export type Proposal =
  | (Base & { kind: "vital"; rows: NormalizedVital[]; measuredAt: string })
  | (Base & { kind: "medication_start"; record: {
      name: string; doseValue: number | null; doseUnit: string | null; route: string | null; frequency: string | null;
      prescriber: string | null; reason: string | null; startDate: string; endDate: string | null } })
  | (Base & { kind: "medication_stop"; medicationId: string; endDate: string; stopReason: string | null })
  | (Base & { kind: "allergy"; record: { substance: string; reaction: string | null; severity: "mild" | "moderate" | "severe" | "unknown"; notedOn: string | null } })
  | (Base & { kind: "appointment"; record: { startsAt: string; providerName: string | null; specialty: string | null; location: string | null; reason: string | null } })
  | (Base & { kind: "profile_update"; changes: Partial<{ fullName: string; preferredName: string; dateOfBirth: string; sex: string; bloodType: string; eyeColor: string }> });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string | null | undefined): d is string => !!d && DATE_RE.test(d) && !Number.isNaN(Date.parse(d));
const joinBits = (bits: (string | null | undefined | false)[]) => bits.filter(Boolean).join(", ");

function medicationNameCheck(m: { name: string; original_name: string; name_resolution: "exact" | "corrected" | "uncertain" }) {
  if (m.name_resolution === "uncertain" || !m.name.trim()) {
    return { issue: `What is the exact medication name on the label for "${m.original_name}"? I couldn't identify it confidently.`, assumptions: [] };
  }
  const changed = m.name.trim().toLowerCase() !== m.original_name.trim().toLowerCase();
  return { issue: null, assumptions: changed ? [`Medication name corrected: "${m.original_name}" → "${m.name}". Check the name on the label before saving.`] : [] };
}

/**
 * Deterministic validation of what the LLM extracted. Anything uncertain becomes either an
 * assumption (shown on the confirm card) or an issue (asked back to the parent; nothing is proposed).
 */
export async function buildProposals(db: Db, hh: Household, memberId: string, items: ExtractedItem[]) {
  const proposals: Proposal[] = [];
  const issues: string[] = [];
  const today = todayIn(hh.timezone);

  for (const it of items) {
    switch (it.kind) {
      case "vital": {
        const v = it.vital;
        if (!v) break;
        const r = normalizeVital({ type: v.type, value: v.value, value2: v.value2, unit: v.unit }, hh.unitSystem);
        let measuredAt = new Date();
        const assumptions = [...r.assumptions];
        if (v.measured_at_local) {
          const parsed = localToUtc(v.measured_at_local, hh.timezone);
          if (!parsed) { issues.push(`When was the ${r.display || v.type} taken? I couldn't read "${v.measured_at_local}".`); break; }
          if (parsed.getTime() > Date.now() + 5 * 60_000) { issues.push(`${r.display} is dated in the future (${formatLocal(parsed, hh.timezone)}). When was it taken?`); break; }
          measuredAt = parsed;
        } else {
          assumptions.push("Time not given; recorded as now");
        }
        if (r.issues.length) { issues.push(...r.issues); break; }
        proposals.push({ kind: "vital", rows: r.rows, measuredAt: measuredAt.toISOString(),
          display: `${r.display} · ${formatLocal(measuredAt, hh.timezone)}`, assumptions });
        break;
      }

      case "medication_start": {
        const m = it.medication_start;
        if (!m) break;
        const nameCheck = medicationNameCheck(m);
        if (nameCheck.issue) { issues.push(nameCheck.issue); break; }
        const assumptions = [...nameCheck.assumptions];
        let startDate = m.start_date;
        if (!startDate) { startDate = today; assumptions.push("Start date not given; used today"); }
        if (!validDate(startDate)) { issues.push(`When did ${m.name} start? I couldn't read "${m.start_date}".`); break; }
        if (m.end_date && (!validDate(m.end_date) || m.end_date < startDate)) { issues.push(`The end date for ${m.name} looks wrong. When does it end?`); break; }
        if (m.dose_value != null && !m.dose_unit) { issues.push(`${m.name} ${m.dose_value}: ${m.dose_value} what (mg, ml, tablets)?`); break; }
        const existing = await db.select({ id: medications.id }).from(medications)
          .where(and(eq(medications.memberId, memberId), eq(medications.status, "active"), isNull(medications.deletedAt), ilike(medications.name, m.name)));
        if (existing.length) assumptions.push(`${m.name} is already on the active list; this adds a second entry`);
        proposals.push({
          kind: "medication_start", assumptions,
          record: { name: m.name, doseValue: m.dose_value, doseUnit: m.dose_unit, route: m.route, frequency: m.frequency,
                    prescriber: m.prescriber, reason: m.reason, startDate, endDate: m.end_date },
          display: `Start ${joinBits([m.name, m.dose_value != null && `${m.dose_value} ${m.dose_unit}`, m.route, m.frequency])} from ${startDate}` +
                   (m.end_date ? ` until ${m.end_date}` : "") + (m.prescriber ? ` · prescribed by ${m.prescriber}` : ""),
        });
        break;
      }

      case "medication_stop": {
        const m = it.medication_stop;
        if (!m) break;
        const nameCheck = medicationNameCheck(m);
        if (nameCheck.issue) { issues.push(nameCheck.issue); break; }
        const matches = await db.select({ id: medications.id, name: medications.name, startDate: medications.startDate }).from(medications)
          .where(and(eq(medications.memberId, memberId), eq(medications.status, "active"), isNull(medications.deletedAt), ilike(medications.name, `%${m.name.replace(/[%_]/g, "")}%`)));
        if (matches.length === 0) { issues.push(`I can't find ${m.name} on the active medication list. Which medication was stopped?`); break; }
        if (matches.length > 1) { issues.push(`More than one active medication matches "${m.name}": ${matches.map((x) => `${x.name} (since ${x.startDate ?? "unknown"})`).join("; ")}. Which one?`); break; }
        const assumptions = [...nameCheck.assumptions];
        let endDate = m.end_date;
        if (!endDate) { endDate = today; assumptions.push("Stop date not given; used today"); }
        if (!validDate(endDate)) { issues.push(`When was ${m.name} stopped?`); break; }
        const med = matches[0]!;
        proposals.push({ kind: "medication_stop", medicationId: med.id, endDate, stopReason: m.stop_reason, assumptions,
          display: `Stop ${med.name} on ${endDate}` + (m.stop_reason ? ` · ${m.stop_reason}` : "") });
        break;
      }

      case "allergy": {
        const a = it.allergy;
        if (!a) break;
        if (a.noted_on && !validDate(a.noted_on)) { issues.push(`When was the ${a.substance} allergy noted?`); break; }
        const dup = await db.select({ id: allergies.id }).from(allergies)
          .where(and(eq(allergies.memberId, memberId), eq(allergies.status, "active"), isNull(allergies.deletedAt), ilike(allergies.substance, a.substance)));
        if (dup.length) { issues.push(`${a.substance} is already recorded as an allergy. Do you want to change its details instead?`); break; }
        proposals.push({ kind: "allergy", assumptions: a.severity === "unknown" ? ["Severity not given; recorded as unknown"] : [],
          record: { substance: a.substance, reaction: a.reaction, severity: a.severity, notedOn: a.noted_on },
          display: `Allergy: ${a.substance}` + (a.reaction ? ` · ${a.reaction}` : "") + ` · severity ${a.severity}` });
        break;
      }

      case "appointment": {
        const a = it.appointment;
        if (!a) break;
        if (!a.starts_at_local) { issues.push("When is the appointment (date and time)?"); break; }
        if (DATE_RE.test(a.starts_at_local)) { issues.push(`What time is the appointment on ${a.starts_at_local}?`); break; }
        const startsAt = localToUtc(a.starts_at_local, hh.timezone);
        if (!startsAt) { issues.push(`I couldn't read the appointment time "${a.starts_at_local}". When is it?`); break; }
        if (!a.provider_name && !a.specialty) { issues.push(`Who is the appointment on ${formatLocal(startsAt, hh.timezone)} with (doctor or specialty)?`); break; }
        proposals.push({ kind: "appointment", assumptions: [],
          record: { startsAt: startsAt.toISOString(), providerName: a.provider_name, specialty: a.specialty, location: a.location, reason: a.reason },
          display: `Appointment ${formatLocal(startsAt, hh.timezone)} · ${joinBits([a.provider_name, a.specialty, a.location, a.reason])}` });
        break;
      }

      case "profile_update": {
        const p = it.profile_update;
        if (!p) break;
        if (p.date_of_birth && (!validDate(p.date_of_birth) || p.date_of_birth > today)) { issues.push("What is the date of birth?"); break; }
        const changes: Extract<Proposal, { kind: "profile_update" }>["changes"] = {};
        if (p.full_name) changes.fullName = p.full_name;
        if (p.preferred_name) changes.preferredName = p.preferred_name;
        if (p.date_of_birth) changes.dateOfBirth = p.date_of_birth;
        if (p.sex) changes.sex = p.sex;
        if (p.blood_type) changes.bloodType = p.blood_type;
        if (p.eye_color) changes.eyeColor = p.eye_color;
        if (!Object.keys(changes).length) break;
        proposals.push({ kind: "profile_update", changes, assumptions: [],
          display: "Update profile: " + Object.entries(changes).map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()} ${v}`).join(", ") });
        break;
      }
    }
  }
  return { proposals, issues };
}

export interface CreatedRecord { table: string; id: string; action: "insert" | "update"; before?: Record<string, unknown> }

/** Write confirmed proposals. Runs inside withTenant, so RLS applies and triggers write the audit trail. */
export async function commitProposals(db: Db, memberId: string, userId: string, householdId: string, sourceText: string, proposals: Proposal[]) {
  const created: CreatedRecord[] = [];
  const common = { householdId, memberId, createdBy: userId, sourceText };

  for (const p of proposals) {
    switch (p.kind) {
      case "vital": {
        const panelId = p.rows.length > 1 ? randomUUID() : null;
        const rows = await db.insert(vitals).values(p.rows.map((r) => ({ ...common, ...r, measuredAt: new Date(p.measuredAt), panelId })))
          .returning({ id: vitals.id });
        rows.forEach((r) => created.push({ table: "vitals", id: r.id, action: "insert" }));
        break;
      }
      case "medication_start": {
        const [r] = await db.insert(medications).values({ ...common, ...p.record, status: "active" }).returning({ id: medications.id });
        created.push({ table: "medications", id: r!.id, action: "insert" });
        break;
      }
      case "medication_stop": {
        const [before] = await db.select().from(medications).where(and(eq(medications.id, p.medicationId), eq(medications.status, "active"), isNull(medications.deletedAt)));
        if (!before) throw new EntryConflict("That medication is no longer active. Nothing was saved.");
        await db.update(medications).set({ status: "stopped", endDate: p.endDate, stopReason: p.stopReason }).where(eq(medications.id, p.medicationId));
        created.push({ table: "medications", id: p.medicationId, action: "update",
          before: { status: before.status, endDate: before.endDate, stopReason: before.stopReason } });
        break;
      }
      case "allergy": {
        const [r] = await db.insert(allergies).values({ ...common, ...p.record, status: "active" }).returning({ id: allergies.id });
        created.push({ table: "allergies", id: r!.id, action: "insert" });
        break;
      }
      case "appointment": {
        const [r] = await db.insert(appointments).values({ ...common, ...p.record, startsAt: new Date(p.record.startsAt), status: "scheduled" })
          .returning({ id: appointments.id });
        created.push({ table: "appointments", id: r!.id, action: "insert" });
        break;
      }
      case "profile_update": {
        const [before] = await db.select().from(members).where(eq(members.id, memberId));
        if (!before) throw new EntryConflict("Member not found.");
        await db.update(members).set({ ...p.changes, updatedAt: new Date() }).where(eq(members.id, memberId));
        const prev: Record<string, unknown> = {};
        for (const k of Object.keys(p.changes)) prev[k] = before[k as keyof typeof before];
        created.push({ table: "members", id: memberId, action: "update", before: prev });
        break;
      }
    }
  }
  return created;
}

/** Reverse a confirmed entry: inserts are soft-deleted, updates restored. Each step is audited by trigger. */
export async function undoRecords(db: Db, records: CreatedRecord[]) {
  const now = new Date();
  for (const r of [...records].reverse()) {
    if (r.action === "insert") {
      const table = { vitals, medications, allergies, appointments }[r.table as "vitals"];
      if (!table) continue;
      await db.update(table).set({ deletedAt: now }).where(inArray(table.id, [r.id]));
    } else if (r.table === "medications") {
      await db.update(medications).set(r.before as Partial<typeof medications.$inferInsert>).where(eq(medications.id, r.id));
    } else if (r.table === "members") {
      await db.update(members).set({ ...(r.before as Partial<typeof members.$inferInsert>), updatedAt: now }).where(eq(members.id, r.id));
    }
  }
}

export class EntryConflict extends Error {}
