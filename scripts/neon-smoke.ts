import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { TLSSocket } from "node:tls";
import pg from "pg";
import { databaseConnectionString } from "../src/db/connection.js";

// Run only against a disposable branch and a separately started app using it.
// This seeds a synthetic server session; it never impersonates a real Google user.
const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8081";
if (!process.env.NEON_BRANCH?.startsWith("hh-neon-verification-")) throw new Error("Smoke writes require a disposable hh-neon-verification-* branch");
const runtimeUrl = process.env.APP_DATABASE_URL;
if (!runtimeUrl) throw new Error("APP_DATABASE_URL is required");
const db = new pg.Client({ connectionString: databaseConnectionString(runtimeUrl), connectionTimeoutMillis: 15_000 });
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const csrf = randomBytes(32).toString("base64url");
const tag = randomUUID();
const headers = { cookie: `hh_session=${token}`, "x-csrf-token": csrf };
async function request(path: string, status: number, method = "GET", body?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
  return response.json() as Promise<unknown>;
}
await db.connect();
try {
  const socket = (db as unknown as { connection: { stream: TLSSocket } }).connection.stream;
  assert.equal(socket.encrypted, true);
  assert.equal(socket.authorized, true);
  const role = (await db.query<{ rolsuper: boolean; rolbypassrls: boolean; elevated: boolean }>(
    "select rolsuper,rolbypassrls,pg_has_role(current_user,'neon_superuser','member') as elevated from pg_roles where rolname=current_user",
  )).rows[0]!;
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, elevated: false });
  console.log(`PASS Neon pooled connection: verified ${socket.getProtocol()}, hh_app has no elevated membership or RLS bypass`);
  await request("/health", 200);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in with Google/);
  console.log("PASS compiled server, bundled web assets, and database health endpoint");
  await db.query("select google_login($1,$2,$3,true,$4,$5)", [`smoke-${tag}`, `smoke-${tag}@gmail.com`, "Synthetic Neon Smoke User", hash, csrf]);
  const auth = await request("/api/auth/status", 200) as { needsHousehold: boolean };
  assert.equal(auth.needsHousehold, true);
  await request("/api/households", 201, "POST", { name: `Synthetic Neon Smoke ${tag}` });
  const member = await request("/api/members", 201, "POST", { fullName: "Synthetic Smoke Member" }) as { id: string };
  const me = await request("/api/me", 200) as { members: Array<{ id: string }> };
  assert.ok(me.members.some(row => row.id === member.id));
  await request(`/api/records/members/${member.id}`, 200, "PATCH", { eye_color: "brown" });
  const rows = await request(`/api/members/${member.id}/records`, 200) as Array<{ record: { eye_color?: string } }>;
  assert.ok(rows.some(row => row.record.eye_color === "brown"));
  await request(`/api/members/${member.id}/chats`, 200);
  await request(`/api/members/${member.id}/reports`, 200);
  console.log("PASS HTTP session → household → member → persisted update/read → chat/report reads, backed by Neon");
  await request("/api/auth/logout", 200, "POST");
  await request("/api/me", 401);
  console.log("PASS logout revokes the persisted session");
} finally {
  await db.query("select logout_session($1)", [hash]).catch(() => {});
  await db.end();
}
