import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { and, asc, desc, eq, gte, isNull, lt, lte, inArray } from "drizzle-orm";
import { withTenant, type TenantContext } from "../db/client.js";
import { allergies, appointments, medications, members, vitals } from "../db/schema.js";
import { VITAL_INPUT_TYPES, VITALS, formatDelta, formatVital, type VitalStoredType } from "../domain/vitals.js";
import { formatLocal, localToUtc } from "../lib/time.js";
import type { Household } from "../domain/entries.js";

/** A record the answer drew on. Returned to the UI as sources and written to the audit log. */
export interface Source { table: string; id: string; label: string }
export interface ToolCallLog { tool: string; args: unknown; recordIds: string[] }

/**
 * Tools are created per request. Household and member come from the closure (the authenticated
 * session and the resolved member), never from model arguments, so the model cannot reach another tenant.
 */
export function buildReadTools(ctx: TenantContext, hh: Household, memberId: string) {
  const sources: Source[] = [];
  const calls: ToolCallLog[] = [];
  const track = (name: string, args: unknown, found: Source[]) => {
    sources.push(...found.filter((s) => !sources.some((x) => x.id === s.id)));
    calls.push({ tool: name, args, recordIds: found.map((s) => s.id) });
  };
  const when = (d: Date, withTime = true) => formatLocal(d, hh.timezone, withTime);

  const getProfile = tool(async () => {
    const [m] = await withTenant(ctx, (db) => db.select().from(members).where(and(eq(members.id, memberId), isNull(members.deletedAt))));
    if (!m) return "No profile found.";
    track("get_profile", {}, [{ table: "members", id: m.id, label: "Profile" }]);
    return JSON.stringify({ id: m.id, full_name: m.fullName, preferred_name: m.preferredName, date_of_birth: m.dateOfBirth, sex: m.sex, blood_type: m.bloodType, eye_color: m.eyeColor });
  }, { name: "get_profile", description: "Biographic profile: name, date of birth, sex, blood type, eye color.", schema: z.object({}) });

  const getAllergies = tool(async ({ include_inactive }) => {
    const rows = await withTenant(ctx, (db) => db.select().from(allergies)
      .where(and(eq(allergies.memberId, memberId), isNull(allergies.deletedAt), include_inactive ? undefined : eq(allergies.status, "active"))));
    track("get_allergies", { include_inactive }, rows.map((r) => ({ table: "allergies", id: r.id, label: `Allergy: ${r.substance}` })));
    if (!rows.length) return "No allergies recorded.";
    return JSON.stringify(rows.map((r) => ({ id: r.id, substance: r.substance, reaction: r.reaction, severity: r.severity, status: r.status, noted_on: r.notedOn, recorded: when(r.createdAt, false) })));
  }, { name: "get_allergies", description: "Recorded allergies.", schema: z.object({ include_inactive: z.boolean() }) });

  const getMedications = tool(async ({ status }) => {
    const rows = await withTenant(ctx, (db) => db.select().from(medications)
      .where(and(eq(medications.memberId, memberId), isNull(medications.deletedAt), status === "all" ? undefined : eq(medications.status, status)))
      .orderBy(desc(medications.startDate)));
    track("get_medications", { status }, rows.map((r) => ({ table: "medications", id: r.id, label: `${r.name} (${r.status})` })));
    if (!rows.length) return `No ${status === "all" ? "" : status + " "}medications recorded.`;
    return JSON.stringify(rows.map((r) => ({
      id: r.id, name: r.name, dose: r.doseValue != null ? `${r.doseValue} ${r.doseUnit}` : null, route: r.route, frequency: r.frequency,
      prescriber: r.prescriber, reason: r.reason, status: r.status, start_date: r.startDate, end_date: r.endDate, stop_reason: r.stopReason,
    })));
  }, {
    name: "get_medications",
    description: "Medications. 'active' = currently taking; 'stopped' = past; 'all' = full history with start/end dates and stop reasons.",
    schema: z.object({ status: z.enum(["active", "stopped", "all"]) }),
  });

  const getVitals = tool(async ({ type, from_date, to_date }) => {
    const types: VitalStoredType[] = type === "blood_pressure" ? ["bp_systolic", "bp_diastolic"] : [type as VitalStoredType];
    const from = from_date ? localToUtc(from_date, hh.timezone) : null;
    const to = to_date ? localToUtc(to_date, hh.timezone) : null;
    const rows = await withTenant(ctx, (db) => db.select().from(vitals)
      .where(and(eq(vitals.memberId, memberId), isNull(vitals.deletedAt), inArray(vitals.vitalType, types),
        from ? gte(vitals.measuredAt, from) : undefined, to ? lt(vitals.measuredAt, new Date(to.getTime() + 86_400_000)) : undefined))
      .orderBy(asc(vitals.measuredAt)));
    track("get_vitals", { type, from_date, to_date }, rows.map((r) => ({ table: "vitals", id: r.id, label: `${VITALS[r.vitalType as VitalStoredType].name} ${when(r.measuredAt, false)}` })));
    if (!rows.length) return `No ${type.replace("_", " ")} readings recorded${from_date || to_date ? " in that period" : ""}.`;

    // Trend statistics are computed here, not by the model.
    const series = (t: VitalStoredType) => {
      const pts = rows.filter((r) => r.vitalType === t);
      if (!pts.length) return null;
      const vals = pts.map((p) => p.value);
      const first = pts[0]!, last = pts.at(-1)!;
      const fmt = (v: number) => formatVital(t, v, hh.unitSystem);
      const change = last.value - first.value;
      return {
        measure: VITALS[t].name,
        count: pts.length,
        first: { value: fmt(first.value), at: when(first.measuredAt) },
        latest: { value: fmt(last.value), at: when(last.measuredAt), as_entered: `${last.originalValue} ${last.originalUnit}` },
        min: fmt(Math.min(...vals)), max: fmt(Math.max(...vals)),
        change_first_to_latest: pts.length > 1 ? formatDelta(t, change, hh.unitSystem) : null,
        change_percent: pts.length > 1 && first.value !== 0 ? Math.round((change / first.value) * 1000) / 10 : null,
        readings: pts.slice(-30).map((p) => ({ id: p.id, at: when(p.measuredAt), value: fmt(p.value) })),
      };
    };
    return JSON.stringify(types.map(series).filter(Boolean));
  }, {
    name: "get_vitals",
    description: "Vital sign readings with precomputed trend statistics (first, latest, min, max, change). Use these numbers; do not recompute.",
    schema: z.object({
      type: z.enum(VITAL_INPUT_TYPES),
      from_date: z.string().nullable().describe("YYYY-MM-DD inclusive, household-local; null for no lower bound"),
      to_date: z.string().nullable().describe("YYYY-MM-DD inclusive; null for no upper bound"),
    }),
  });

  const getAppointments = tool(async ({ when: range, limit }) => {
    const now = new Date();
    const rows = await withTenant(ctx, (db) => db.select().from(appointments)
      .where(and(eq(appointments.memberId, memberId), isNull(appointments.deletedAt),
        range === "upcoming" ? gte(appointments.startsAt, now) : range === "past" ? lte(appointments.startsAt, now) : undefined))
      .orderBy(range === "past" ? desc(appointments.startsAt) : asc(appointments.startsAt)).limit(limit));
    track("get_appointments", { when: range, limit }, rows.map((r) => ({ table: "appointments", id: r.id, label: `Appointment ${when(r.startsAt, false)}` })));
    if (!rows.length) return `No ${range === "all" ? "" : range + " "}appointments recorded.`;
    return JSON.stringify(rows.map((r) => ({ id: r.id, at: when(r.startsAt), provider: r.providerName, specialty: r.specialty, location: r.location, reason: r.reason, status: r.status, outcome: r.outcomeNotes })));
  }, {
    name: "get_appointments",
    description: "Appointments. 'upcoming' sorted soonest first; 'past' most recent first.",
    schema: z.object({ when: z.enum(["upcoming", "past", "all"]), limit: z.number().int().min(1).max(50) }),
  });

  return { tools: [getProfile, getAllergies, getMedications, getVitals, getAppointments], getVitals, sources, calls };
}
