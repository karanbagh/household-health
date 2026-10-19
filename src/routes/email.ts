import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { pool, withTenant, type TenantContext } from "../db/client.js";
import { authenticate } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { config } from "../config.js";
import { cookieOptions, cookieToken, randomToken, sessionIdentity, tokenHash } from "../lib/sessions.js";
import { encryptRefreshToken, gmailProvider, MailError, mailReady, type GmailProvider } from "../lib/mail.js";
import type { GoogleTransaction } from "../lib/google.js";
import { appointmentCalendar, type CalendarAppointment } from "../domain/calendar.js";
import { deliver, mailbox, people, reserveDelivery } from "../domain/email.js";

const GMAIL_COOKIE = "hh_gmail_oauth";
const cookiePath = "/api/email/gmail";
const calendarBody = z.object({
  operationId: z.uuid(), recipientUserIds: z.array(z.uuid()).min(1).max(10),
  reminderMinutes: z.union([z.literal(15), z.literal(60), z.literal(1440)]).default(1440),
  durationMinutes: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(120)]).default(60),
}).strict();
interface GmailTransaction extends GoogleTransaction { household_id: string; user_id: string }

export async function emailRoutes(app: FastifyInstance, options: FastifyPluginOptions & { mailProvider?: GmailProvider } = {}) {
  const provider = options.mailProvider ?? gmailProvider;
  app.get("/email/status", { preHandler: authenticate }, async req => withTenant(req.tenant, async db => {
    const row = (await db.execute<{ email: string }>(sql`select email from household_mailboxes`)).rows[0];
    return { configured: mailReady(), connected: Boolean(row), sender: row?.email ?? null, callbackUrl: config.google.origin + "/api/email/gmail/callback" };
  }));
  app.post("/email/gmail/connect", { preHandler: authenticate }, async (req, reply) => {
    if (req.tenant.role !== "owner") return reply.code(403).send({ error: "Only the owner can connect Gmail." });
    if (config.authMode !== "google" || !mailReady()) return reply.code(503).send({ error: "Configure Google login and MAIL_ENCRYPTION_KEY before connecting Gmail." });
    const transaction = { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
    const url = await provider.authorize(transaction), browserToken = randomToken();
    await pool.query("delete from gmail_oauth_transactions where expires_at<=now()");
    await pool.query("insert into gmail_oauth_transactions(token_hash,state,nonce,verifier,household_id,user_id,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')", [tokenHash(browserToken), transaction.state, transaction.nonce, transaction.verifier, req.tenant.householdId, req.tenant.userId]);
    return reply.setCookie(GMAIL_COOKIE, browserToken, cookieOptions(600, cookiePath)).send({ url });
  });
  app.get("/email/gmail/callback", async (req, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    reply.clearCookie(GMAIL_COOKIE, cookieOptions(0, cookiePath));
    try {
      if (config.authMode !== "google") throw new Error("Google sign-in required");
      const session = await sessionIdentity(req), browserToken = cookieToken(req, GMAIL_COOKIE);
      if (!session || !browserToken) throw new Error("Missing signed-in transaction");
      const transaction = (await pool.query<GmailTransaction>("delete from gmail_oauth_transactions where token_hash=$1 and user_id=$2 and expires_at>now() returning state,nonce,verifier,household_id,user_id", [tokenHash(browserToken), session.user_id])).rows[0];
      const query = z.object({ state: z.string(), code: z.string().min(1) }).parse(req.query);
      if (!transaction || transaction.state !== query.state) throw new Error("Invalid transaction");
      const memberships = (await pool.query<{ household_id: string; role: string }>("select * from auth_memberships_by_user($1)", [session.user_id])).rows;
      if (!memberships.some(row => row.household_id === transaction.household_id && row.role === "owner")) throw new Error("Owner access required");
      const connected = await provider.callback(new URL(req.url, config.google.origin), transaction);
      if (connected.email.toLowerCase() !== session.email.toLowerCase()) throw new Error("Choose the signed-in owner's Google account");
      const ctx: TenantContext = { householdId: transaction.household_id, userId: session.user_id, role: "owner", requestId: req.id };
      const encrypted = encryptRefreshToken(connected.refreshToken, ctx.householdId);
      await withTenant(ctx, async db => {
        await db.execute(sql`insert into household_mailboxes(household_id,email,refresh_token_encrypted,connected_by) values(${ctx.householdId},${connected.email},${encrypted},${ctx.userId}) on conflict(household_id) do update set email=excluded.email,refresh_token_encrypted=excluded.refresh_token_encrypted,connected_by=excluded.connected_by,updated_at=now()`);
        await audit(db, ctx, { action: "gmail_connected", entity: "household_mailboxes", entityId: ctx.householdId });
      });
      return reply.redirect("/?gmail=connected");
    } catch (error) {
      req.log.warn({ type: error instanceof Error ? error.name : "GmailConnectionError" }, "Gmail connection failed");
      return reply.redirect("/?gmail=failed");
    }
  });
  app.delete("/email/gmail", { preHandler: authenticate }, async (req, reply) => {
    if (req.tenant.role !== "owner") return reply.code(403).send({ error: "Only the owner can disconnect Gmail." });
    return withTenant(req.tenant, async db => {
      await db.execute(sql`delete from household_mailboxes`);
      await audit(db, req.tenant, { action: "gmail_disconnected", entity: "household_mailboxes", entityId: req.tenant.householdId });
      return { disconnected: true };
    });
  });
  app.post<{ Params: { id: string } }>("/appointments/:id/email", { preHandler: authenticate }, async (req, reply) => {
    if (req.tenant.role === "viewer") return reply.code(403).send({ error: "Only owners and editors can email appointment invitations." });
    const body = calendarBody.safeParse(req.body);
    if (!body.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: "Choose household recipients and valid calendar settings." });
    const sender = await mailbox(req.tenant);
    const prepared = await withTenant(req.tenant, async db => {
      const row = (await db.execute<Omit<CalendarAppointment, "startsAt"> & { startsAt: string | Date } & Record<string, unknown>>(sql`select a.id,a.starts_at as "startsAt",a.provider_name as "providerName",a.specialty,a.location,coalesce(m.preferred_name,m.full_name) as "memberName" from appointments a join members m on m.id=a.member_id where a.id=${req.params.id} and a.status='scheduled' and a.deleted_at is null and m.deleted_at is null`)).rows[0];
      if (!row) throw new MailError("Scheduled appointment not found.", 404);
      const ids = [...new Set(body.data.recipientUserIds)];
      const recipients = (await people(db)).filter(person => ids.includes(person.id));
      if (recipients.length !== ids.length) throw new MailError("Choose only users who currently have access to this household.", 400);
      // Reserve the whole selection atomically before emailing any recipient.
      const deliveries = [];
      for (const person of recipients) deliveries.push({ person, ...await reserveDelivery(db, req.tenant, body.data.operationId, "calendar_invitation", row.id, person.email) });
      return { appointment: { ...row, startsAt: row.startsAt instanceof Date ? row.startsAt : new Date(row.startsAt) }, deliveries };
    });
    const results = [];
    for (const item of prepared.deliveries) {
      const result = item.fresh ? await deliver(req.tenant, item.delivery, sender, {
        from: sender.email, to: item.person.email, subject: `Calendar invitation: ${prepared.appointment.memberName}'s appointment`,
        text: `An appointment calendar invitation is attached. Open it in your calendar to accept and enable reminders. This email includes the selected member's name, appointment time, provider and location. Later changes in Household Health do not automatically update this event.`,
        calendar: appointmentCalendar(prepared.appointment, body.data.reminderMinutes, body.data.durationMinutes, new Date(), { organizer: sender.email, attendee: item.person.email }),
      }, provider) : { status: item.delivery.status };
      results.push({ userId: item.person.id, ...result });
    }
    return { results };
  });
}
