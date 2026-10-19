import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { authenticate } from "../lib/auth.js";
import { withTenant } from "../db/client.js";
import { audit } from "../lib/audit.js";
import type { SavedTurn } from "../domain/chats.js";
export async function chatRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  app.get<{Params:{id:string}}>("/members/:id/chats", async (req,reply) => {
    if(!z.uuid().safeParse(req.params.id).success) return reply.code(400).send({error:"Invalid member"});
    return withTenant(req.tenant, async db => {
      const member=await db.execute(sql`select 1 from members where id=${req.params.id} and deleted_at is null`);
      if(!member.rows.length) return reply.code(404).send({error:"Member not found"});
      const rows=await db.execute(sql`select conversation_key as "conversationId",title,created_at as "createdAt",updated_at as "updatedAt",jsonb_array_length(turns) as "turnCount" from chat_sessions where member_id=${req.params.id} order by updated_at desc,id desc`);
      await audit(db,req.tenant,{action:"read",entity:"chat_sessions",memberId:req.params.id});return rows.rows;
    });
  });
  app.get<{Params:{id:string;key:string}}>("/members/:id/chats/:key",async(req,reply)=>{
    if(!z.uuid().safeParse(req.params.id).success || !z.string().min(1).max(100).safeParse(req.params.key).success) return reply.code(400).send({error:"Invalid conversation"});
    return withTenant(req.tenant,async db=>{
      const rows=await db.execute<{id:string;title:string;turns:SavedTurn[]}>(sql`select id,title,turns from chat_sessions where member_id=${req.params.id} and conversation_key=${req.params.key} and exists(select 1 from members m where m.id=member_id and m.deleted_at is null)`);
      const session=rows.rows[0];if(!session) return reply.code(404).send({error:"Conversation not found"});
      const proposals=await db.execute<{id:string;status:string}>(sql`select id,status from pending_entries where member_id=${req.params.id}`);
      const statuses=new Map(proposals.rows.map(row=>[row.id,row.status]));
      await audit(db,req.tenant,{action:"read",entity:"chat_sessions",entityId:session.id,memberId:req.params.id});
      return {title:session.title,turns:session.turns.map(turn=>({...turn,response:turn.response.type==="proposal"?{...turn.response,entryStatus:statuses.get(turn.response.pendingId)??"unavailable"}:turn.response}))};
    });
  });
}
