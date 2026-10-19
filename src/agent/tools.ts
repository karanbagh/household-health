import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { and, asc, desc, eq, gte, isNull, lt, lte, inArray, sql } from "drizzle-orm";
import { searchLabs, LAB_COLUMNS, toLabReport, type StoredLab, type LabServices, ReportTypeSchema } from "../domain/labs.js";
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
export function buildReadTools(ctx: TenantContext, hh: Household, memberId: string, labServices?: LabServices) {
  const sources: Source[] = [];
  const calls: ToolCallLog[] = [];
  const track = (name: string, args: unknown, found: Source[]) => {
    for (const source of found) {
      if (!sources.some((existing) => existing.table === source.table && existing.id === source.id)) sources.push(source);
    }
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
    return JSON.stringify(rows.map((r) => ({ id: r.id, member_id: r.memberId, at: when(r.startsAt), provider: r.providerName, specialty: r.specialty, location: r.location, reason: r.reason, status: r.status, outcome: r.outcomeNotes })));
  }, {
    name: "get_appointments",
    description: "Appointments explicitly associated with the selected member by member_id. Every returned appointment belongs to that member, even if its notes do not repeat the patient's name. 'upcoming' sorted soonest first; 'past' most recent first.",
    schema: z.object({ when: z.enum(["upcoming", "past", "all"]), limit: z.number().int().min(1).max(50) }),
  });

  const searchLabResults = tool(async ({ query, from_date, to_date }) => {
    const hits = await searchLabs(ctx, memberId, query, { fromDate: from_date, toDate: to_date }, labServices);
    track("search_lab_results", { query, from_date, to_date }, hits.map((r) => ({ table: "reports", id: r.reportId, label: `${r.title} (${r.reportDate ?? "date not printed"})` })));
    return JSON.stringify({ matches: hits, note: "Ranked excerpts, not an exhaustive history. Use get_lab_reports for comparisons or all results. Empty matches mean no searchable reports for this period." });
  }, { name: "search_lab_results", description: "Semantic search of reviewed lab results, including synonyms. Use for questions about laboratory tests and findings.", schema: z.object({ query: z.string().min(1).max(2000), from_date: z.iso.date().nullable(), to_date: z.iso.date().nullable() }) });
  const getLabReports = tool(async ({ from_date, to_date }) => {
    const rows = await withTenant(ctx, (db) => db.execute<StoredLab>(sql`select ${LAB_COLUMNS} from reports where member_id=${memberId} and deleted_at is null and status='confirmed' and report_type='lab'
      and exists(select 1 from members m where m.id=member_id and m.deleted_at is null)
      ${from_date ? sql`and report_date >= ${from_date}::date` : sql``}
      ${to_date ? sql`and report_date <= ${to_date}::date` : sql``}
      order by report_date desc nulls last, created_at desc limit 21`));
    const reports = rows.rows.slice(0, 20).map(toLabReport);
    track("get_lab_reports", { from_date, to_date }, reports.map((r) => ({ table: "reports", id: r.id, label: `${r.data.title} (${r.data.reportDate ?? "date not printed"})` })));
    return JSON.stringify({ reports, truncated: rows.rows.length > 20, note: "Up to 20 most recent reports. Narrow the dates if truncated. Compare only compatible tests and units; do not infer absent flags or reference ranges." });
  }, { name: "get_lab_reports", description: "Reviewed structured lab reports for complete results and comparisons over time. Returns up to 20 reports, with an explicit truncation indicator.", schema: z.object({ from_date: z.iso.date().nullable(), to_date: z.iso.date().nullable() }) });
  const getLatestLabReport = tool(async () => {
    const rows = await withTenant(ctx, (db) => db.execute<StoredLab>(sql`select ${LAB_COLUMNS} from reports where member_id=${memberId} and deleted_at is null and status='confirmed' and report_type='lab'
      and exists(select 1 from members m where m.id=member_id and m.deleted_at is null)
      order by report_date desc nulls last, created_at desc, id desc limit 1`));
    const report = rows.rows[0] ? toLabReport(rows.rows[0]) : null;
    track("get_latest_lab_report", {}, report ? [{ table: "reports", id: report.id, label: `${report.data.title} (${report.data.reportDate ?? "date not printed"})` }] : []);
    return JSON.stringify({ report, note: "Complete reviewed results from the latest saved report. No date window or semantic top-k filter is applied. Missing results here mean absent from this report, not from all report history." });
  }, { name: "get_latest_lab_report", description: "Fetch the latest saved lab report with ALL reviewed test results, including HDL. Use for latest-report questions; no guessed date filters.", schema: z.object({}) });
  const searchReports = tool(async ({ query, report_type, from_date, to_date }) => {
    const hits = await searchLabs(ctx, memberId, query, { reportType: report_type === "all" ? null : report_type, fromDate: from_date, toDate: to_date }, labServices);
    track("search_reports", { query, report_type, from_date, to_date }, hits.map(r => ({ table: "reports", id: r.reportId, label: `${r.title} (${r.reportDate ?? "date not printed"})` })));
    return JSON.stringify({ matches: hits, note: "Ranked excerpts from reviewed reports, not exhaustive history. Quote recommendations as documented with report dates; do not present them as your own advice or current medication status. Use get_reports for full narrative context." });
  }, { name: "search_reports", description: "Semantic search across surgery reports, discharge summaries, recommendations, miscellaneous documents and labs. Use for questions about documented procedures, findings, instructions and follow-up.", schema: z.object({ query: z.string().min(1).max(2000), report_type: z.enum(["all", ...ReportTypeSchema.options]), from_date: z.iso.date().nullable(), to_date: z.iso.date().nullable() }) });
  const getReports = tool(async ({ report_type, latest, from_date, to_date }) => {
    const rows = await withTenant(ctx, db => db.execute<StoredLab>(sql`select ${LAB_COLUMNS} from reports where member_id=${memberId} and deleted_at is null and status='confirmed'
      and exists(select 1 from members m where m.id=member_id and m.deleted_at is null)
      ${report_type === "all" ? sql`` : sql`and report_type=${report_type}`}
      ${from_date ? sql`and report_date >= ${from_date}::date` : sql``}
      ${to_date ? sql`and report_date <= ${to_date}::date` : sql``}
      order by report_date desc nulls last, created_at desc, id desc limit ${latest ? 1 : 21}`));
    const reports = rows.rows.slice(0, 20).map(toLabReport);
    track("get_reports", { report_type, latest, from_date, to_date }, reports.map(r => ({ table: "reports", id: r.id, label: `${r.data.title} (${r.data.reportDate ?? "date not printed"})` })));
    return JSON.stringify({ reports, truncated: rows.rows.length > 20, note: "Full reviewed text and results. Preserve attribution and dates for documented diagnoses and recommendations. Empty date-filtered results do not imply no reports exist." });
  }, { name: "get_reports", description: "Complete reviewed reports and narrative sections. Filter by category; latest=true fetches the latest saved report in that category. Leave dates null unless the user specifies a period.", schema: z.object({ report_type: z.enum(["all", ...ReportTypeSchema.options]), latest: z.boolean(), from_date: z.iso.date().nullable(), to_date: z.iso.date().nullable() }) });
  return { tools: [getProfile, getAllergies, getMedications, getVitals, getAppointments, searchLabResults, getLabReports, getLatestLabReport, searchReports, getReports], getReports, getLatestLabReport, getVitals, sources, calls };
}
