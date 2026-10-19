import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { pool, withTenant, type TenantContext } from "../db/client.js";
import { authenticate } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { config } from "../config.js";
import { cookieToken, randomToken, requireCsrf, sessionIdentity, tokenHash } from "../lib/sessions.js";
import { gmailProvider, MailError, type GmailProvider } from "../lib/mail.js";
import { deliver, mailbox, people, reserveDelivery, type Delivery } from "../domain/email.js";

const roleSchema = z.enum(["editor", "viewer"]);
const invitationSchema = z.object({ email: z.email().trim().max(254).transform(value => value.toLowerCase()), role: roleSchema, operationId: z.uuid() }).strict();
const operationSchema = z.object({ operationId: z.uuid() }).strict();
const invitationFields = sql`id,email,role,status,expires_at,created_at`;
interface Invitation extends Record<string, unknown> { id: string; email: string; role: "editor" | "viewer" }
function owner(ctx: TenantContext) { if (ctx.role !== "owner") throw new MailError("Only the household owner can manage access.", 403); }

export async function householdAccessRoutes(app: FastifyInstance, options: FastifyPluginOptions & { mailProvider?: GmailProvider } = {}) {
  const provider = options.mailProvider ?? gmailProvider;
  app.get("/household/people", { preHandler: authenticate }, async req => withTenant(req.tenant, people));
  app.get("/household/access", { preHandler: authenticate }, async req => {
    owner(req.tenant);
    return withTenant(req.tenant, async db => ({
      users: await people(db),
      invitations: (await db.execute(sql`select ${invitationFields},(select status from email_deliveries d where d.resource_id=i.id order by d.created_at desc limit 1) as delivery_status from household_invitations i order by created_at desc limit 50`)).rows,
    }));
  });
  app.post("/household/invitations", { preHandler: authenticate }, async (req, reply) => {
    owner(req.tenant);
    const body = invitationSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter a valid email and access level." });
    return sendInvitation(req.tenant, body.data, undefined, provider);
  });
  app.post<{ Params: { id: string } }>("/household/invitations/:id/resend", { preHandler: authenticate }, async (req, reply) => {
    owner(req.tenant);
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success || !z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: "Invalid invitation." });
    const existing = await withTenant(req.tenant, async db => (await db.execute<Invitation>(sql`select id,email,role from household_invitations where id=${req.params.id} and status='pending'`)).rows[0]);
    if (!existing) return reply.code(404).send({ error: "Pending invitation not found." });
    return sendInvitation(req.tenant, { ...existing, operationId: parsed.data.operationId }, existing.id, provider);
  });
  app.delete<{ Params: { id: string } }>("/household/invitations/:id", { preHandler: authenticate }, async (req, reply) => {
    owner(req.tenant);
    if (!z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: "Invalid invitation." });
    return withTenant(req.tenant, async db => {
      const row = await db.execute(sql`update household_invitations set status='revoked',invited_by=${req.tenant.userId} where id=${req.params.id} and status='pending' returning id`);
      if (!row.rows.length) return reply.code(404).send({ error: "Pending invitation not found." });
      await audit(db, req.tenant, { action: "invitation_revoked", entity: "household_invitations", entityId: req.params.id });
      return { revoked: true };
    });
  });
  for (const method of ["PATCH", "DELETE"] as const) app.route<{ Params: { id: string } }>({
    method, url: "/household/users/:id", preHandler: authenticate,
    handler: async (req, reply) => {
      owner(req.tenant);
      const body = method === "PATCH" ? z.object({ role: roleSchema }).strict().safeParse(req.body) : null;
      if (!z.uuid().safeParse(req.params.id).success || (body && !body.success)) return reply.code(400).send({ error: "Choose a valid household user and role." });
      try {
        return await withTenant(req.tenant, async db => {
          await db.execute(sql`select change_household_access(${req.params.id},${body?.success ? body.data.role : null})`);
          await audit(db, req.tenant, { action: method === "PATCH" ? "access_updated" : "access_removed", entity: "household_users", entityId: req.params.id, details: body?.success ? { role: body.data.role } : null });
          return { updated: true };
        });
      } catch (error) {
        if (pgCode(error) === "22023") return reply.code(400).send({ error: "This account cannot be changed here. Owner access is protected." });
        throw error;
      }
    },
  });
  app.post("/invitations/accept", async (req, reply) => {
    if (config.authMode !== "google") return reply.code(401).send({ error: "Sign in with Google to accept an invitation." });
    const session = await sessionIdentity(req);
    if (!session) return reply.code(401).send({ error: "Sign in with the invited Google account first." });
    if (!requireCsrf(req, reply, session)) return;
    const body = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid invitation." });
    try {
      const accepted = await pool.query<{ id: string }>("select accept_household_invitation($1,$2,$3) as id", [tokenHash(cookieToken(req)!), tokenHash(body.data.token), randomUUID()]);
      return { householdId: accepted.rows[0]!.id };
    } catch (error) {
      if (["22023", "28000"].includes(pgCode(error) ?? "")) return reply.code(400).send({ error: "This invitation expired, was revoked, was already used, or belongs to another email. Sign in with the invited account or ask the owner to resend it." });
      throw error;
    }
  });
}
function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? pgCode(error.cause) : undefined;
}
async function sendInvitation(ctx: TenantContext, body: z.infer<typeof invitationSchema>, existingId: string | undefined, provider: GmailProvider) {
  const sender = await mailbox(ctx);
  const token = randomToken();
  const prepared = await withTenant(ctx, async db => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.householdId},47))`);
    const prior = (await db.execute<Delivery>(sql`select id,resource_id,kind,recipient,status from email_deliveries where operation_id=${body.operationId}`)).rows[0];
    if (prior) {
      if (prior.kind !== "household_invitation" || prior.recipient !== body.email) throw new MailError("Use a new request for another invitation.", 409);
      return { invitationId: prior.resource_id, delivery: prior, fresh: false, name: "" };
    }
    if ((await people(db)).some(person => person.email.toLowerCase() === body.email)) throw new MailError("That account already has access to this household.", 409);
    const pending = (await db.execute<Invitation>(sql`select id,email,role from household_invitations where email=${body.email} and status='pending' for update`)).rows[0];
    if (existingId && pending?.id !== existingId) throw new MailError("Pending invitation not found.", 404);
    const count = (await db.execute<{ n: number }>(sql`select count(*)::int as n from household_invitations where status='pending' and expires_at>now()`)).rows[0]!.n;
    if (!pending && count >= 25) throw new MailError("Revoke an unused invitation before inviting more people.", 429);
    const invitationId = pending?.id ?? randomUUID();
    if (pending) await db.execute(sql`update household_invitations set token_hash=${tokenHash(token)},role=${body.role},invited_by=${ctx.userId},expires_at=now()+interval '7 days' where id=${invitationId}`);
    else await db.execute(sql`insert into household_invitations(id,household_id,email,role,token_hash,invited_by) values(${invitationId},${ctx.householdId},${body.email},${body.role},${tokenHash(token)},${ctx.userId})`);
    const reserved = await reserveDelivery(db, ctx, body.operationId, "household_invitation", invitationId, body.email);
    const household = (await db.execute<{ name: string }>(sql`select name from households`)).rows[0]!;
    await audit(db, ctx, { action: pending ? "invitation_resent" : "invitation_created", entity: "household_invitations", entityId: invitationId, details: { role: body.role } });
    return { invitationId, ...reserved, name: household.name };
  });
  if (!prepared.fresh) return { id: prepared.invitationId, status: prepared.delivery.status };
  const link = `${config.google.origin}/#invite=${token}`;
  const result = await deliver(ctx, prepared.delivery, sender, {
    from: sender.email, to: body.email, subject: `Invitation to ${prepared.name} on Household Health`,
    text: `You have been invited to ${prepared.name} on Household Health with ${body.role === "editor" ? "editing" : "view-only"} access.\n\nAccept: ${link}\n\nSign in with Google using ${body.email}. This invitation expires in 7 days and grants access to the household's health records. If you did not expect it, ignore this message.`,
  }, provider);
  return { id: prepared.invitationId, ...result };
}
