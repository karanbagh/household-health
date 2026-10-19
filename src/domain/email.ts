import { sql } from "drizzle-orm";
import { withTenant, type Db, type TenantContext } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { decryptRefreshToken, MailError, mailReady, type GmailProvider, type MailMessage } from "../lib/mail.js";

export interface HouseholdPerson extends Record<string, unknown> { id: string; email: string; name: string; role: TenantContext["role"] }
export interface Delivery extends Record<string, unknown> {
  id: string; resource_id: string; kind: string; recipient: string; status: "sending" | "sent" | "failed" | "unknown";
}
export async function people(db: Db): Promise<HouseholdPerson[]> {
  return (await db.execute<HouseholdPerson>(sql`select * from household_people() order by name,email`)).rows;
}
export async function mailbox(ctx: TenantContext): Promise<{ email: string; refreshToken: string }> {
  if (!mailReady()) throw new MailError("Email setup is not complete. Ask the owner to configure Gmail.");
  const row = await withTenant(ctx, async db => (await db.execute<{ email: string; refresh_token_encrypted: string }>(sql`select email,refresh_token_encrypted from household_mailboxes`)).rows[0]);
  if (!row) throw new MailError("The household owner must connect Gmail before sending email.");
  return { email: row.email, refreshToken: decryptRefreshToken(row.refresh_token_encrypted, ctx.householdId) };
}
export async function reserveDelivery(db: Db, ctx: TenantContext, operation: string, kind: string, resource: string, recipient: string): Promise<{ delivery: Delivery; fresh: boolean }> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.householdId},47))`);
  const prior = (await db.execute<Delivery>(sql`select id,resource_id,kind,recipient,status from email_deliveries where operation_id=${operation} and recipient=${recipient}`)).rows[0];
  if (prior) {
    if (prior.kind !== kind || prior.resource_id !== resource) throw new MailError("Use a new send request for different content.", 409);
    return { delivery: prior, fresh: false };
  }
  const count = (await db.execute<{ n: number }>(sql`select count(*)::int as n from email_deliveries where created_at>now()-interval '1 hour'`)).rows[0]!.n;
  if (count >= 50) throw new MailError("The household email limit has been reached. Try again in an hour.", 429);
  const row = (await db.execute<Delivery>(sql`insert into email_deliveries(household_id,operation_id,kind,resource_id,recipient) values(${ctx.householdId},${operation},${kind},${resource},${recipient}) returning id,resource_id,kind,recipient,status`)).rows[0]!;
  return { delivery: row, fresh: true };
}
export async function deliver(ctx: TenantContext, delivery: Delivery, sender: { refreshToken: string }, message: MailMessage, provider: GmailProvider): Promise<{ status: Delivery["status"]; message?: string }> {
  let providerId: string | null = null, status: Delivery["status"] = "sent", errorMessage: string | undefined;
  try { providerId = await provider.send(sender.refreshToken, message); }
  catch (error) {
    status = error instanceof MailError && !error.uncertain ? "failed" : "unknown";
    errorMessage = error instanceof MailError ? error.message : "Sending was not confirmed. Check Gmail Sent before sending again.";
  }
  await withTenant(ctx, async db => {
    await db.execute(sql`update email_deliveries set status=${status},provider_id=${providerId} where id=${delivery.id}`);
    await audit(db, ctx, { action: `email_${status}`, entity: "email_deliveries", entityId: delivery.id, details: { kind: delivery.kind, resourceId: delivery.resource_id } });
  });
  return { status, ...(errorMessage ? { message: errorMessage } : {}) };
}
