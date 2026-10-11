// Requires a migrated database (npm run db:migrate). Creates two throwaway households per run.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { pool, withTenant, type TenantContext } from "../src/db/client.js";
import { auditLog, medications, members, vitals } from "../src/db/schema.js";
import { buildProposals, commitProposals, undoRecords } from "../src/domain/entries.js";
import { audit } from "../src/lib/audit.js";
import { buildReadTools } from "../src/agent/tools.js";
import type { ExtractedItem } from "../src/agent/schemas.js";

const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
const hh = { id: "", timezone: "America/New_York", unitSystem: "us" as const };
let A: TenantContext, B: TenantContext, viewer: TenantContext, memberA = "", memberB = "";

async function makeHousehold(role: "owner" | "viewer" = "owner") {
  const tag = randomUUID().slice(0, 8);
  const { rows: [h] } = await admin.query<{ id: string }>("insert into households (name) values ($1) returning id", [`test-${tag}`]);
  const { rows: [u] } = await admin.query<{ id: string }>("insert into users (email, display_name) values ($1, $2) returning id", [`${tag}@test`, tag]);
  await admin.query("insert into household_users values ($1, $2, $3)", [h!.id, u!.id, role]);
  const { rows: [m] } = await admin.query<{ id: string }>("insert into members (household_id, full_name) values ($1, 'Test Kid') returning id", [h!.id]);
  return { ctx: { householdId: h!.id, userId: u!.id, role, requestId: randomUUID() } as TenantContext, memberId: m!.id };
}

const vitalItem = (value: number, unit: string | null): ExtractedItem => ({
  kind: "vital", vital: { type: "weight", value, value2: null, unit, measured_at_local: null },
  medication_start: null, medication_stop: null, allergy: null, appointment: null, profile_update: null,
});
const medItem = (name: string): ExtractedItem => ({
  kind: "medication_start", vital: null, medication_stop: null, allergy: null, appointment: null, profile_update: null,
  medication_start: { name, original_name: name, name_resolution: "exact", dose_value: 250, dose_unit: "mg", route: "oral", frequency: "twice daily", prescriber: null, reason: null, start_date: "2026-10-01", end_date: null },
});

/** Drizzle wraps driver errors; the Postgres message is on .cause. */
const pgError = (re: RegExp) => (err: unknown) => {
  const e = err as { message?: string; cause?: { message?: string } };
  return re.test(e.cause?.message ?? "") || re.test(e.message ?? "");
};

before(async () => {
  await admin.connect();
  ({ ctx: A, memberId: memberA } = await makeHousehold());
  ({ ctx: B, memberId: memberB } = await makeHousehold());
  const { rows: [u] } = await admin.query<{ id: string }>("insert into users (email, display_name) values ($1, 'viewer') returning id", [`${randomUUID()}@test`]);
  await admin.query("insert into household_users values ($1, $2, 'viewer')", [A.householdId, u!.id]);
  viewer = { householdId: A.householdId, userId: u!.id, role: "viewer", requestId: randomUUID() };
  hh.id = A.householdId;
});
after(async () => { await admin.end(); await pool.end(); });

test("a household cannot read another household's data (RLS)", async () => {
  const rows = await withTenant(B, (db) => db.select().from(members).where(eq(members.id, memberA)));
  assert.equal(rows.length, 0);
  const all = await withTenant(B, (db) => db.select().from(members));
  assert.deepEqual(all.map((m) => m.id), [memberB]);
});

test("a household cannot write into another household", async () => {
  await assert.rejects(withTenant(B, (db) => db.insert(vitals).values({
    householdId: A.householdId, memberId: memberA, vitalType: "weight", loinc: "29463-7", value: 30, unit: "kg", originalValue: 30, originalUnit: "kg", measuredAt: new Date(),
  })), pgError(/row-level security/));
});

test("viewers cannot write", async () => {
  const { proposals } = await withTenant(viewer, (db) => buildProposals(db, hh, memberA, [vitalItem(30, "kg")]));
  await assert.rejects(withTenant(viewer, (db) => commitProposals(db, memberA, viewer.userId, A.householdId, "weight 30 kg", proposals)), pgError(/row-level security/));
});

test("entry → confirm → undo, with every change in the audit trail", async () => {
  const { proposals, issues } = await withTenant(A, (db) => buildProposals(db, hh, memberA, [vitalItem(71.4, "lbs"), medItem("Amoxicillin")]));
  assert.deepEqual(issues, []);
  assert.equal(proposals.length, 2);

  const created = await withTenant(A, (db) => commitProposals(db, memberA, A.userId, A.householdId, "71.4 lbs, started amoxicillin", proposals));
  assert.equal(created.length, 2);
  const [w] = await withTenant(A, (db) => db.select().from(vitals).where(eq(vitals.memberId, memberA)));
  assert.equal(w!.unit, "kg");
  assert.equal(w!.originalUnit, "lb");

  const trail = await withTenant(A, (db) => db.select().from(auditLog).where(eq(auditLog.requestId, A.requestId)));
  assert.deepEqual(trail.map((t) => `${t.action}:${t.entity}`).sort(), ["create:medications", "create:vitals"]);
  assert.equal(trail[0]!.actorUserId, A.userId);

  await withTenant(A, (db) => undoRecords(db, created));
  const live = await withTenant(A, (db) => db.select().from(vitals).where(and(eq(vitals.memberId, memberA), isNull(vitals.deletedAt))));
  assert.equal(live.length, 0);
  const deletes = await withTenant(A, (db) => db.select().from(auditLog).where(and(eq(auditLog.requestId, A.requestId), eq(auditLog.action, "delete"))));
  assert.equal(deletes.length, 2);
});

test("stopping a medication finds it by name and records the stop", async () => {
  await withTenant(A, async (db) => commitProposals(db, memberA, A.userId, A.householdId, "started cetirizine",
    (await buildProposals(db, hh, memberA, [medItem("Cetirizine")])).proposals));
  const stop: ExtractedItem = { kind: "medication_stop", medication_stop: { name: "cetirizine", original_name: "cetirizine", name_resolution: "exact", end_date: null, stop_reason: "allergy season over" },
    vital: null, medication_start: null, allergy: null, appointment: null, profile_update: null };
  const { proposals, issues } = await withTenant(A, (db) => buildProposals(db, hh, memberA, [stop]));
  assert.deepEqual(issues, []);
  await withTenant(A, (db) => commitProposals(db, memberA, A.userId, A.householdId, "stopped cetirizine", proposals));
  const [m] = await withTenant(A, (db) => db.select().from(medications).where(and(eq(medications.memberId, memberA), eq(medications.name, "Cetirizine"))));
  assert.equal(m!.status, "stopped");
  assert.equal(m!.stopReason, "allergy season over");
});

test("ambiguous input produces a question, not a record", async () => {
  const { proposals, issues } = await withTenant(A, (db) => buildProposals(db, hh, memberA, [vitalItem(700, "kg")]));
  assert.equal(proposals.length, 0);
  assert.equal(issues.length, 1);
});

test("corrected medication spelling is shown, saved with original text, and used for stopping", async () => {
  const item = medItem("rosuvastatin");
  item.medication_start!.original_name = "rosuvast";
  item.medication_start!.name_resolution = "corrected";
  item.medication_start!.dose_value = 10;
  const source = "Test Kid is on rosuvast 10mg";
  const { proposals, issues } = await withTenant(A, (db) => buildProposals(db, hh, memberA, [item]));
  assert.deepEqual(issues, []);
  assert.match(proposals[0]!.display, /rosuvastatin, 10 mg/);
  assert.ok(proposals[0]!.assumptions.some((text) => text.includes('"rosuvast" → "rosuvastatin"')));
  await withTenant(A, (db) => commitProposals(db, memberA, A.userId, A.householdId, source, proposals));
  const [saved] = await withTenant(A, (db) => db.select().from(medications).where(eq(medications.name, "rosuvastatin")));
  assert.equal(saved!.doseValue, 10);
  assert.equal(saved!.sourceText, source);
  const stop: ExtractedItem = { ...item, kind: "medication_stop", medication_start: null, medication_stop: {
    name: "rosuvastatin", original_name: "rosuvast", name_resolution: "corrected", end_date: null, stop_reason: null,
  } };
  const result = await withTenant(A, (db) => buildProposals(db, hh, memberA, [stop]));
  assert.deepEqual(result.issues, []);
  assert.equal(result.proposals[0]!.kind, "medication_stop");
  assert.ok(result.proposals[0]!.assumptions.some((text) => text.includes('"rosuvast" → "rosuvastatin"')));
});

test("uncertain medication names require clarification for starts and stops", async () => {
  const start = medItem("unknown medicine");
  start.medication_start!.original_name = "unclear";
  start.medication_start!.name_resolution = "uncertain";
  const stop: ExtractedItem = { ...start, kind: "medication_stop", medication_start: null, medication_stop: {
    name: "unknown medicine", original_name: "unclear", name_resolution: "uncertain", end_date: null, stop_reason: null,
  } };
  for (const item of [start, stop]) {
    const { proposals, issues } = await withTenant(A, (db) => buildProposals(db, hh, memberA, [item]));
    assert.equal(proposals.length, 0);
    assert.match(issues[0]!, /exact medication name on the label/);
  }
});

test("read tools are scoped to the session and log what they returned", async () => {
  await withTenant(A, async (db) => commitProposals(db, memberA, A.userId, A.householdId, "weight 32 kg",
    (await buildProposals(db, hh, memberA, [vitalItem(32, "kg")])).proposals));
  const read = buildReadTools(B, hh, memberA); // B's session asking for A's member: RLS must hide it
  const leaked = await read.getVitals.invoke({ type: "weight", from_date: null, to_date: null });
  assert.match(String(leaked), /No weight readings/);
  const own = buildReadTools(A, hh, memberA);
  const out = JSON.parse(String(await own.getVitals.invoke({ type: "weight", from_date: null, to_date: null })));
  assert.equal(out[0].count, 1);
  assert.equal(own.calls[0]!.recordIds.length, 1);
});

test("audit log is append-only and its hash chain verifies", async () => {
  await withTenant(A, (db) => audit(db, A, { action: "read", entity: "snapshot", memberId: memberA }));
  await assert.rejects(pool.query("delete from audit_log"), /permission denied/);
  await assert.rejects(admin.query("update audit_log set action = 'read' where household_id = $1", [A.householdId]), /append-only/);
  const { rows: [v] } = await admin.query("select audit_verify($1) as broken", [A.householdId]);
  assert.equal(v!.broken, null);
});
