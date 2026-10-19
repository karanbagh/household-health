import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { sql } from "drizzle-orm";
import { config } from "../src/config.js";
import { pool, withTenant, type TenantContext } from "../src/db/client.js";
import { authRoutes } from "../src/routes/auth.js";
import { apiRoutes } from "../src/routes/api.js";
import { onboardingRoutes } from "../src/routes/onboarding.js";
import { householdAccessRoutes } from "../src/routes/household-access.js";
import { emailRoutes } from "../src/routes/email.js";
import { randomToken, tokenHash } from "../src/lib/sessions.js";
import { encryptRefreshToken, decryptRefreshToken, mimeMessage, MailError, gmailProvider, type GmailProvider, type MailMessage } from "../src/lib/mail.js";
import type { GoogleTransaction } from "../src/lib/google.js";
import { appointmentCalendar } from "../src/domain/calendar.js";

interface Account { id: string; email: string; headers: { cookie: string; "x-csrf-token": string }; householdId?: string }
const app = Fastify({ genReqId: () => randomUUID() });
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
const tag = randomUUID(), messages: MailMessage[] = [];
let owner: Account, other: Account, viewer: Account, editor: Account;
let appointmentId = "", memberId = "", failSend = false, uncertain = false, providerCalls = 0;
let transaction: GoogleTransaction, connectedEmail = "", invitationId = "", invitationToken = "";
const keyBefore = config.mail.encryptionKey, authBefore = config.authMode;
const provider: GmailProvider = {
  async authorize(tx) { transaction = tx; return `https://accounts.google.com/o/oauth2/v2/auth?state=${tx.state}`; },
  async callback(_url, tx) { assert.equal(tx.nonce, transaction.nonce); assert.equal(tx.verifier, transaction.verifier); providerCalls++; return { email: connectedEmail, refreshToken: "synthetic-gmail-refresh-secret" }; },
  async send(refreshToken, message) {
    assert.equal(refreshToken, "synthetic-gmail-refresh-secret");
    if (failSend) throw new MailError("Synthetic Gmail rejection", 502, uncertain);
    messages.push(message); return `synthetic-${messages.length}`;
  },
};
async function account(label: string, household = false): Promise<Account> {
  const email = `${label}-${randomUUID()}@gmail.com`, token = randomToken(), csrf = randomToken();
  const user = (await admin.query<{ id: string }>("select google_login($1,$2,$3,true,$4,$5) as id", [`mail-${randomUUID()}`, email, `Synthetic ${label}`, tokenHash(token), csrf])).rows[0]!;
  const value: Account = { id: user.id, email, headers: { cookie: `hh_session=${token}`, "x-csrf-token": csrf } };
  if (household) {
    const response = await app.inject({ method: "POST", url: "/api/households", headers: value.headers, payload: { name: `Synthetic mail ${label}` } });
    assert.equal(response.statusCode, 201, response.body); value.householdId = response.json<{ id: string }>().id;
  }
  return value;
}
const ctx = (who: Account): TenantContext => ({ householdId: who.householdId!, userId: who.id, role: "owner", requestId: randomUUID() });
async function connect(who = owner, badState = false) {
  const started = await app.inject({ method: "POST", url: "/api/email/gmail/connect", headers: who.headers });
  assert.equal(started.statusCode, 200, started.body);
  const oauth = started.cookies.find(value => value.name === "hh_gmail_oauth")!;
  assert.ok(oauth.httpOnly); assert.equal(oauth.sameSite, "Lax");
  const headers = { cookie: `${who.headers.cookie}; hh_gmail_oauth=${oauth.value}` };
  const url = `/api/email/gmail/callback?code=synthetic&state=${badState ? "bad-state" : transaction.state}`;
  return { response: await app.inject({ url, headers }), headers, url };
}
async function invite(email: string, role: "editor" | "viewer" = "viewer", operationId = randomUUID()) {
  const response = await app.inject({ method: "POST", url: "/api/household/invitations", headers: owner.headers, payload: { email, role, operationId } });
  return { response, operationId };
}
const tokenFrom = (message: MailMessage) => /#invite=([A-Za-z0-9_-]{43})/.exec(message.text)![1]!;
const accept = (who: Account, token: string) => app.inject({ method: "POST", url: "/api/invitations/accept", headers: who.headers, payload: { token } });

before(async () => {
  config.authMode = "google"; config.mail.encryptionKey = randomBytes(32).toString("base64");
  config.google.clientId = "synthetic-client"; config.google.clientSecret = "synthetic-secret";
  await admin.connect();
  app.register(cookie); app.register(authRoutes, { prefix: "/api" }); app.register(apiRoutes, { prefix: "/api" }); app.register(onboardingRoutes, { prefix: "/api" });
  app.register(householdAccessRoutes, { prefix: "/api", mailProvider: provider }); app.register(emailRoutes, { prefix: "/api", mailProvider: provider });
  await app.ready(); owner = await account("owner", true); other = await account("other", true); viewer = await account("viewer"); editor = await account("editor"); connectedEmail = owner.email;
  memberId = (await admin.query<{ id: string }>("insert into members(household_id,full_name) values($1,'Synthetic Calendar Member') returning id", [owner.householdId])).rows[0]!.id;
  appointmentId = (await admin.query<{ id: string }>("insert into appointments(household_id,member_id,starts_at,provider_name,specialty,location,reason,outcome_notes) values($1,$2,now()+interval '2 days','Synthetic Provider','Dentist','Test Location','PRIVATE CLINICAL REASON','PRIVATE OUTCOME') returning id", [owner.householdId, memberId])).rows[0]!.id;
});
after(async () => { config.authMode = authBefore; config.mail.encryptionKey = keyBefore; await app.close(); await admin.end(); await pool.end(); });

test("refresh credentials are authenticated-encrypted and bound to the household", () => {
  const a = randomUUID(), b = randomUUID(); const encrypted = encryptRefreshToken("secret", a);
  assert.ok(!encrypted.includes("secret")); assert.equal(decryptRefreshToken(encrypted, a), "secret");
  assert.throws(() => decryptRefreshToken(encrypted, b)); assert.throws(() => decryptRefreshToken(encrypted.slice(0, -3) + "bad", a));
});
test("Gmail connection requires owner consent, valid state, matching account, and rejects replay", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/email/gmail/connect", headers: { cookie: owner.headers.cookie } })).statusCode, 403);
  const calls = providerCalls; assert.equal((await connect(owner, true)).response.headers.location, "/?gmail=failed"); assert.equal(providerCalls, calls);
  connectedEmail = other.email; assert.equal((await connect()).response.headers.location, "/?gmail=failed");
  connectedEmail = owner.email; const good = await connect(); assert.equal(good.response.headers.location, "/?gmail=connected");
  assert.equal((await app.inject({ url: good.url, headers: good.headers })).headers.location, "/?gmail=failed");
  const rows = await admin.query<{ refresh_token_encrypted: string }>("select refresh_token_encrypted from household_mailboxes where household_id=$1", [owner.householdId]);
  assert.ok(!rows.rows[0]!.refresh_token_encrypted.includes("synthetic-gmail-refresh-secret"));
  const status = await app.inject({ url: "/api/email/status", headers: owner.headers });
  assert.equal(status.json<{ sender: string }>().sender, owner.email); assert.ok(!status.body.includes("refresh"));
});
test("inviting creates no membership, hashes tokens, excludes health data, and deduplicates the same send operation", async () => {
  const first = await invite(viewer.email); assert.equal(first.response.statusCode, 200, first.response.body);
  invitationId = first.response.json<{ id: string }>().id; invitationToken = tokenFrom(messages.at(-1)!);
  assert.ok(!first.response.body.includes(invitationToken));
  const stored = (await admin.query<{ token_hash: string }>("select token_hash from household_invitations where id=$1", [invitationId])).rows[0]!;
  assert.equal(stored.token_hash, tokenHash(invitationToken));
  assert.equal((await admin.query("select 1 from household_users where user_id=$1", [viewer.id])).rowCount, 0);
  const count = messages.length; await invite(viewer.email, "viewer", first.operationId); assert.equal(messages.length, count);
  assert.ok(!messages.at(-1)!.text.includes("PRIVATE"));
  const auditRows = await admin.query("select details from audit_log where entity_id=$1", [invitationId]); assert.ok(!JSON.stringify(auditRows.rows).includes(invitationToken));
});
test("only the invited signed-in email can accept with CSRF protection; the token is single-use", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/invitations/accept", payload: { token: invitationToken } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/invitations/accept", headers: { cookie: viewer.headers.cookie }, payload: { token: invitationToken } })).statusCode, 403);
  assert.equal((await accept(other, invitationToken)).statusCode, 400);
  assert.equal((await accept(viewer, invitationToken)).statusCode, 200);
  assert.equal((await accept(viewer, invitationToken)).statusCode, 400);
  const me = await app.inject({ url: "/api/me", headers: viewer.headers }); assert.equal(me.statusCode, 200, me.body); assert.equal(me.json<{ user: { role: string } }>().user.role, "viewer");
  assert.equal((await app.inject({ method: "POST", url: "/api/members", headers: viewer.headers, payload: { fullName: "Forbidden" } })).statusCode, 403);
});
test("owners alone manage access; invites cannot grant ownership and removing a member immediately revokes access", async () => {
  for (const method of ["GET", "POST"] as const) assert.equal((await app.inject({ method, url: method === "GET" ? "/api/household/access" : "/api/household/invitations", headers: viewer.headers, ...(method === "POST" ? { payload: { email: editor.email, role: "editor", operationId: randomUUID() } } : {}) })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/household/invitations", headers: owner.headers, payload: { email: editor.email, role: "owner", operationId: randomUUID() } })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/household/users/${owner.id}`, headers: owner.headers })).statusCode, 400);
  const created = await invite(editor.email, "editor"); assert.equal(created.response.statusCode, 200, created.response.body); assert.equal((await accept(editor, tokenFrom(messages.at(-1)!))).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/household/users/${editor.id}`, headers: owner.headers, payload: { role: "viewer" } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/me", headers: editor.headers })).json<{ user: { role: string } }>().user.role, "viewer");
  assert.equal((await app.inject({ method: "DELETE", url: `/api/household/users/${editor.id}`, headers: owner.headers })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/me", headers: editor.headers })).statusCode, 403);
});
test("revoked/expired invitations fail; resend replaces the old link; another household cannot see invitations or mailbox credentials", async () => {
  const candidate = await account("resend"); const sent = await invite(candidate.email); const id = sent.response.json<{ id: string }>().id; const oldToken = tokenFrom(messages.at(-1)!);
  await admin.query("update household_invitations set expires_at=now()-interval '1 second' where id=$1", [id]); assert.equal((await accept(candidate, oldToken)).statusCode, 400);
  const resend = await app.inject({ method: "POST", url: `/api/household/invitations/${id}/resend`, headers: owner.headers, payload: { operationId: randomUUID() } }); assert.equal(resend.statusCode, 200, resend.body);
  const replacement = tokenFrom(messages.at(-1)!); assert.notEqual(replacement, oldToken); assert.equal((await accept(candidate, oldToken)).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/household/invitations/${id}`, headers: owner.headers })).statusCode, 200); assert.equal((await accept(candidate, replacement)).statusCode, 400);
  const hidden = await withTenant(ctx(other), async db => ({ invites: (await db.execute(sql`select * from household_invitations where household_id=${owner.householdId}`)).rows, mailboxes: (await db.execute(sql`select * from household_mailboxes where household_id=${owner.householdId}`)).rows }));
  assert.deepEqual(hidden, { invites: [], mailboxes: [] });
});
test("existing Google users can join a second household and select it without replacing their original access", async () => {
  await invite(other.email); assert.equal((await accept(other, tokenFrom(messages.at(-1)!))).statusCode, 200);
  const status = await app.inject({ url: "/api/auth/status", headers: other.headers }); assert.equal(status.json<{ households: unknown[] }>().households.length, 2);
  assert.equal((await app.inject({ url: "/api/me", headers: other.headers })).statusCode, 400);
  const first = await app.inject({ url: "/api/me", headers: { ...other.headers, "x-household-id": other.householdId! } }); assert.equal(first.json<{ user: { role: string } }>().user.role, "owner");
  const second = await app.inject({ url: "/api/me", headers: { ...other.headers, "x-household-id": owner.householdId! } }); assert.equal(second.json<{ user: { role: string } }>().user.role, "viewer");
});
test("calendar email only reaches explicitly selected household users and contains a real calendar request", async () => {
  const payload = { operationId: randomUUID(), recipientUserIds: [viewer.id], reminderMinutes: 60, durationMinutes: 30 };
  assert.equal((await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/email`, headers: viewer.headers, payload })).statusCode, 403);
  const outsider = await account("outsider");
  const before = messages.length;
  assert.equal((await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/email`, headers: owner.headers, payload: { ...payload, recipientUserIds: [outsider.id] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/email`, headers: owner.headers, payload: { ...payload, toEmail: outsider.email } })).statusCode, 400); assert.equal(messages.length, before);
  const sent = await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/email`, headers: owner.headers, payload }); assert.equal(sent.statusCode, 200, sent.body); assert.equal(sent.json<{ results: Array<{ status: string }> }>().results[0]!.status, "sent");
  const message = messages.at(-1)!; assert.equal(message.to, viewer.email); assert.equal(message.from, owner.email);
  assert.match(message.calendar!, /METHOD:REQUEST\r\n/); assert.ok(message.calendar!.includes(`ORGANIZER:mailto:${owner.email}`));
  assert.match(message.calendar!, /ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:/); assert.match(message.calendar!, /TRIGGER:-PT60M/); assert.ok(!message.calendar!.includes("PRIVATE"));
  assert.match(mimeMessage(message), /Content-Type: text\/calendar;.*method=REQUEST/);
  await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/email`, headers: owner.headers, payload }); assert.equal(messages.length, before + 1);
});
test("sending failures are persisted honestly and unknown outcomes are not retried automatically", async () => {
  failSend = true; uncertain = true;
  const request = { operationId: randomUUID(), recipientUserIds: [viewer.id] };
  const send = await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/email`, headers: owner.headers, payload: request }); assert.equal(send.statusCode, 200, send.body); assert.equal(send.json<{ results: Array<{ status: string }> }>().results[0]!.status, "unknown");
  const before = messages.length; failSend = false;
  await app.inject({ method: "POST", url: `/api/appointments/${appointmentId}/email`, headers: owner.headers, payload: request }); assert.equal(messages.length, before);
});
test("Gmail MIME rejects header injection, preserves Unicode, and refreshes tokens over HTTPS", async () => {
  assert.throws(() => mimeMessage({ from: owner.email, to: "bad@example.com\r\nBcc: attacker@example.com", subject: "test", text: "test" }));
  const calendar = appointmentCalendar({ id: randomUUID(), startsAt: new Date("2026-11-01T06:30:00Z"), memberName: "Émilie", providerName: null, specialty: null, location: null }, 15, 60, new Date("2026-10-18T12:00:00Z"), { organizer: owner.email, attendee: viewer.email });
  assert.match(calendar, /DTSTART:20261101T063000Z/); assert.ok(calendar.split("\r\n").every(line => Buffer.byteLength(line) <= 75));
  const original = globalThis.fetch; const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), ...(init ? { init } : {}) }); return new Response(JSON.stringify(requests.length === 1 ? { access_token: "synthetic-access" } : { id: "synthetic-message-id" }), { status: 200, headers: { "content-type": "application/json" } }); };
  try {
    assert.equal(await gmailProvider.send("synthetic-refresh", { from: owner.email, to: viewer.email, subject: "Émilie’s appointment", text: "Synthetic", calendar }), "synthetic-message-id");
    assert.equal(requests[0]!.url, "https://oauth2.googleapis.com/token"); assert.ok(String(requests[0]!.init!.body).includes("grant_type=refresh_token"));
    assert.equal(requests[1]!.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const encoded = JSON.parse(String(requests[1]!.init!.body)) as { raw: string }; assert.match(Buffer.from(encoded.raw, "base64url").toString(), /Content-Type: text\/calendar/);
  } finally { globalThis.fetch = original; }
});
test("household sending limit stops more deliveries before creating another invitation", async () => {
  await admin.query("insert into email_deliveries(household_id,operation_id,kind,resource_id,recipient,status) select $1,gen_random_uuid(),'calendar_invitation',$2,'rate-test@example.invalid','sent' from generate_series(1,50)", [owner.householdId, appointmentId]);
  const response = await invite(`limited-${tag}@gmail.com`); assert.equal(response.response.statusCode, 429, response.response.body);
  assert.equal((await admin.query("select 1 from household_invitations where email=$1", [`limited-${tag}@gmail.com`])).rowCount, 0);
});
