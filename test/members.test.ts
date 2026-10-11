// Runtime onboarding and member creation through the real HTTP routes and RLS role.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { apiRoutes } from "../src/routes/api.js";
import { onboardingRoutes } from "../src/routes/onboarding.js";
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
