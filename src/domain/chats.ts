import { sql } from "drizzle-orm";
import { withTenant, type TenantContext } from "../db/client.js";
import type { ChatResult, Turn } from "../agent/graph.js";
export interface SavedTurn { message: string; response: ChatResult; historyBefore: Turn[] }
export async function saveChatTurn(ctx: TenantContext, memberId: string, key: string, turn: SavedTurn) {
  return withTenant(ctx, async db => {
    const member = await db.execute(sql`select 1 from members where id=${memberId} and deleted_at is null`);
    if (!member.rows.length) throw new Error("Member not found");
    await db.execute(sql`insert into chat_sessions(household_id,member_id,user_id,conversation_key,title,turns)
      values(${ctx.householdId},${memberId},${ctx.userId},${key},${turn.message.slice(0,100)},${JSON.stringify([turn])}::jsonb)
      on conflict(household_id,member_id,user_id,conversation_key) do update set turns=chat_sessions.turns || excluded.turns,updated_at=clock_timestamp()`);
  });
}
