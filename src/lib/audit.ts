import { auditLog } from "../db/schema.js";
import type { Db, TenantContext } from "../db/client.js";

export type AuditAction =
  | "read" | "ai_query" | "entry_proposed" | "entry_confirmed" | "entry_discarded" | "entry_undone";

/**
 * App-written audit rows: reads, AI queries, and the entry lifecycle.
 * Data changes (create / update / soft delete) are captured by database triggers, so no call is needed for them.
 */
export async function audit(
  db: Db,
  ctx: TenantContext,
  e: { action: AuditAction; entity: string; entityId?: string | null; memberId?: string | null; details?: unknown },
) {
  await db.insert(auditLog).values({
    householdId: ctx.householdId,
    actorUserId: ctx.userId,
    memberId: e.memberId ?? null,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    details: e.details ?? null,
    requestId: ctx.requestId,
    traceId: ctx.traceId ?? null,
  });
}
