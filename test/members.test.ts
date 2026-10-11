// Runtime onboarding and member creation through the real HTTP routes and RLS role.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { apiRoutes } from "../src/routes/api.js";
import { onboardingRoutes } from "../src/routes/onboarding.js";
import { recordRoutes } from "../src/routes/records.js";
import { pool } from "../src/db/client.js";

const app = Fastify();
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
const email = `owner-${randomUUID()}@example.com`;
const otherEmail = `other-${randomUUID()}@example.com`;
const viewerEmail = `viewer-${randomUUID()}@example.com`;
const editorEmail = `editor-${randomUUID()}@example.com`;
let householdId = "", userId = "", memberId = "";
const headers = { "x-dev-user": email };

before(async () => {
  await admin.connect();
  app.register(apiRoutes, { prefix: "/api" });
  app.register(onboardingRoutes, { prefix: "/api" });
  app.register(recordRoutes, { prefix: "/api" });
  await app.ready();
});
after(async () => { await app.close(); await admin.end(); await pool.end(); });

test("create a household at runtime and sign in without seeding", async () => {
  const res = await app.inject({ method: "POST", url: "/api/households", payload: {
    email, displayName: "Test Owner", name: "Runtime test household", timezone: "America/New_York",
  } });
  assert.equal(res.statusCode, 201, res.body);
  householdId = res.json<{ id: string }>().id;
  const me = await app.inject({ url: "/api/me", headers });
  assert.equal(me.statusCode, 200);
  const body = me.json<{ user: { id: string; role: string }; members: unknown[] }>();
  assert.equal(body.user.role, "owner");
  assert.deepEqual(body.members, []);
  userId = body.user.id;
});

test("existing accounts cannot be claimed through household creation", async () => {
  const res = await app.inject({ method: "POST", url: "/api/households", payload: {
    email: email.toUpperCase(), displayName: "Replacement", name: "Another household",
  } });
  assert.equal(res.statusCode, 409);
});

test("onboarding rejects invalid email and timezone", async () => {
  for (const payload of [
    { email: "invalid", displayName: "Owner", name: "Household" },
    { email: otherEmail, displayName: "Owner", name: "Household", timezone: "invalid" },
  ]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/households", payload })).statusCode, 400);
  }
});

test("an owner adds a member with profile details and an attributed audit record", async () => {
  const res = await app.inject({ method: "POST", url: "/api/members", headers, payload: {
    fullName: "  Test Child  ", preferredName: "Child", dateOfBirth: "2017-05-03", sex: "male", bloodType: "O+", eyeColor: "brown",
  } });
  assert.equal(res.statusCode, 201, res.body);
  memberId = res.json<{ id: string }>().id;
  const snapshot = await app.inject({ url: `/api/members/${memberId}/snapshot`, headers });
  assert.equal(snapshot.statusCode, 200);
  assert.deepEqual(snapshot.json<{ profile: Record<string, unknown> }>().profile, { id: memberId, name: "Child", fullName: "Test Child", dateOfBirth: "2017-05-03", sex: "male", bloodType: "O+", eyeColor: "brown" });
  const { rows } = await admin.query<{ actor_user_id: string; household_id: string; after: { created_by: string } }>("select actor_user_id, household_id, after from audit_log where entity_id = $1 and action = 'create'", [memberId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor_user_id, userId);
  assert.equal(rows[0]!.household_id, householdId);
  assert.equal(rows[0]!.after.created_by, userId);
});

test("member creation validates dates, names and server-owned tenant fields", async () => {
  for (const payload of [
    { fullName: " " }, { fullName: "Child", dateOfBirth: "2017-02-30" },
    { fullName: "Child", dateOfBirth: "2999-01-01" },
    { fullName: "Child", householdId: randomUUID() },
    { fullName: "Child", bloodType: "invalid" },
  ]) {
    const res = await app.inject({ method: "POST", url: "/api/members", headers, payload });
    assert.equal(res.statusCode, 400, res.body);
  }
});

test("viewers cannot add members, editors can, and unsigned callers are rejected", async () => {
  for (const [account, role] of [[viewerEmail, "viewer"], [editorEmail, "editor"]]) {
    const { rows: [u] } = await admin.query<{ id: string }>("insert into users(email, display_name) values($1, 'Runtime test user') returning id", [account]);
    await admin.query("insert into household_users(household_id, user_id, role) values($1, $2, $3)", [householdId, u!.id, role]);
  }
  for (const [account, status] of [[viewerEmail, 403], [editorEmail, 201]] as const) {
    const res = await app.inject({ method: "POST", url: "/api/members", headers: { "x-dev-user": account }, payload: { fullName: "Editor test member" } });
    assert.equal(res.statusCode, status, res.body);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/members", payload: { fullName: "Child" } })).statusCode, 401);
});

test("another runtime household cannot see the first household's members", async () => {
  const created = await app.inject({ method: "POST", url: "/api/households", payload: { email: otherEmail, displayName: "Other owner", name: "Other runtime test household" } });
  assert.equal(created.statusCode, 201, created.body);
  const otherHeaders = { "x-dev-user": otherEmail };
  const me = await app.inject({ url: "/api/me", headers: otherHeaders });
  assert.deepEqual(me.json<{ members: unknown[] }>().members, []);
  assert.equal((await app.inject({ url: `/api/members/${memberId}/snapshot`, headers: otherHeaders })).statusCode, 404);
});

test("old records remain editable and deletable, with history and household isolation", async () => {
  const { rows: [med] } = await admin.query<{ id: string }>(
    "insert into medications(household_id, member_id, name, dose_value, dose_unit, status, start_date, end_date, created_at) values($1,$2,'Test medicine',10,'mg','stopped','2010-01-01','2011-01-01','2010-01-01') returning id", [householdId, memberId]);
  const url = `/api/records/medications/${med!.id}`;
  const list = await app.inject({ url: `/api/members/${memberId}/records`, headers });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json<{ kind: string; record: { id: string } }[]>().some((row) => row.record.id === med!.id));
  for (const method of ["PATCH", "DELETE"] as const) {
    const payload = method === "PATCH" ? { name: "Another name" } : undefined;
    assert.equal((await app.inject({ method, url, headers: { "x-dev-user": viewerEmail }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method, url, headers: { "x-dev-user": otherEmail }, payload })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { household_id: randomUUID() } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { end_date: "2009-01-01" } })).statusCode, 400);
  const edit = await app.inject({ method: "PATCH", url, headers: { "x-dev-user": editorEmail }, payload: { name: "Correct medicine", dose_value: 20 } });
  assert.equal(edit.statusCode, 200, edit.body);
  const removed = await app.inject({ method: "DELETE", url, headers });
  assert.equal(removed.statusCode, 200, removed.body);
  const refreshed = await app.inject({ url: `/api/members/${memberId}/records`, headers });
  assert.ok(!refreshed.json<{ record: { id: string } }[]>().some((row) => row.record.id === med!.id));
  const { rows: [stored] } = await admin.query<{ deleted_at: Date | null; name: string }>("select deleted_at, name from medications where id=$1", [med!.id]);
  assert.ok(stored!.deleted_at);
  assert.equal(stored!.name, "Correct medicine");
  const { rows: history } = await admin.query<{ action: string; before: { dose_value: number }; after: { dose_value: number } }>("select action, before, after from audit_log where entity_id=$1 order by id", [med!.id]);
  assert.deepEqual(history.map((row) => row.action), ["create", "update", "delete"]);
  assert.equal(history[1]!.before.dose_value, 10);
  assert.equal(history[1]!.after.dose_value, 20);
});

test("profile, allergy, appointment, and measurement edits validate and save", async () => {
  const patch = (kind: string, id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/records/${kind}/${id}`, headers, payload });
  assert.equal((await patch("members", memberId, { eye_color: "hazel" })).statusCode, 200);
  assert.equal((await patch("members", memberId, { date_of_birth: "2999-01-01" })).statusCode, 400);
  const { rows: [allergy] } = await admin.query<{ id: string }>("insert into allergies(household_id,member_id,substance) values($1,$2,'Test allergen') returning id", [householdId, memberId]);
  assert.equal((await patch("allergies", allergy!.id, { substance: "Updated allergen", severity: "mild" })).statusCode, 200);
  const { rows: [appointment] } = await admin.query<{ id: string }>("insert into appointments(household_id,member_id,starts_at) values($1,$2,'2010-01-01') returning id", [householdId, memberId]);
  assert.equal((await patch("appointments", appointment!.id, { status: "completed", outcome_notes: "Recorded outcome" })).statusCode, 200);
  const { rows: [vital] } = await admin.query<{ id: string }>("insert into vitals(household_id,member_id,vital_type,loinc,value,unit,original_value,original_unit,measured_at) values($1,$2,'weight','29463-7',30,'kg',66.1,'lb','2010-01-01') returning id", [householdId, memberId]);
  assert.equal((await patch("vitals", vital!.id, { value: 999 })).statusCode, 400);
  assert.equal((await patch("vitals", vital!.id, { value: 31 })).statusCode, 200);
  const { rows: [stored] } = await admin.query<{ value: string; original_value: string; original_unit: string }>("select value, original_value, original_unit from vitals where id=$1", [vital!.id]);
  assert.equal(Number(stored!.value), 31);
  assert.equal(Number(stored!.original_value), 31);
  assert.equal(stored!.original_unit, "kg");
});

test("undo works after 15 minutes but cannot overwrite subsequent record edits", async () => {
  const proposals = [{ kind: "allergy", record: { substance: "Undo test allergen", reaction: null, severity: "unknown", notedOn: null }, assumptions: [], display: "Allergy" }];
  const { rows: [entry] } = await admin.query<{ id: string }>("insert into pending_entries(household_id,member_id,created_by,source_text,proposals) values($1,$2,$3,'Test entry',$4) returning id", [householdId, memberId, userId, JSON.stringify(proposals)]);
  const confirm = await app.inject({ method: "POST", url: `/api/entries/${entry!.id}/confirm`, headers });
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.ok(!("undoUntil" in confirm.json<Record<string, unknown>>()));
  await admin.query("update pending_entries set resolved_at='2010-01-01' where id=$1", [entry!.id]);
  const undo = await app.inject({ method: "POST", url: `/api/entries/${entry!.id}/undo`, headers });
  assert.equal(undo.statusCode, 200, undo.body);

  const { rows: [second] } = await admin.query<{ id: string }>("insert into pending_entries(household_id,member_id,created_by,source_text,proposals) values($1,$2,$3,'Test entry',$4) returning id", [householdId, memberId, userId, JSON.stringify(proposals)]);
  assert.equal((await app.inject({ method: "POST", url: `/api/entries/${second!.id}/confirm`, headers })).statusCode, 200);
  const { rows: [p] } = await admin.query<{ created_records: { id: string }[] }>("select created_records from pending_entries where id=$1", [second!.id]);
  await app.inject({ method: "PATCH", url: `/api/records/allergies/${p!.created_records[0]!.id}`, headers, payload: { reaction: "Updated reaction" } });
  assert.equal((await app.inject({ method: "POST", url: `/api/entries/${second!.id}/undo`, headers })).statusCode, 409);
});
