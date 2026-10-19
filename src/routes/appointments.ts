import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import { withTenant } from "../db/client.js";
import { appointments, members, households } from "../db/schema.js";
import { authenticate } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { formatLocal } from "../lib/time.js";
import { appointmentCalendar } from "../domain/calendar.js";
export async function appointmentRoutes(app: FastifyInstance, options: FastifyPluginOptions & {now?:()=>Date}={}) {
  app.addHook("preHandler",authenticate);
  app.get("/appointments/upcoming",async req=>withTenant(req.tenant,async db=>{
    const now=options.now?.()??new Date();
    const rows=await db.select({appointment:appointments,memberName:members.fullName,preferredName:members.preferredName}).from(appointments).innerJoin(members,eq(members.id,appointments.memberId))
      .where(and(isNull(appointments.deletedAt),isNull(members.deletedAt),eq(appointments.status,"scheduled"),gte(appointments.startsAt,now),lt(appointments.startsAt,new Date(now.getTime()+7*86400000)))).orderBy(asc(appointments.startsAt)).limit(6);
    const [household]=await db.select().from(households);
    await audit(db,req.tenant,{action:"read",entity:"appointments",details:{upcoming:true,recordIds:rows.slice(0,5).map(row=>row.appointment.id)}});
    return {appointments:rows.slice(0,5).map(({appointment:a,memberName,preferredName})=>({id:a.id,memberId:a.memberId,memberName:preferredName??memberName,startsAt:a.startsAt,at:formatLocal(a.startsAt,household!.timezone),with:[a.providerName,a.specialty].filter(Boolean).join(", ")})),hasMore:rows.length>5};
  }));
  app.get<{Params:{id:string}}>("/appointments/:id/calendar",async(req,reply)=>{
    if(!z.uuid().safeParse(req.params.id).success) return reply.code(400).send({error:"Invalid appointment"});
    const parsed=z.object({reminderMinutes:z.enum(["15","60","1440"]).default("1440"),durationMinutes:z.enum(["30","60","90","120"]).default("60")}).strict().safeParse(req.query);
    if(!parsed.success) return reply.code(400).send({error:"Choose a valid reminder and calendar duration"});
    return withTenant(req.tenant,async db=>{
      const [row]=await db.select({appointment:appointments,memberName:members.fullName,preferredName:members.preferredName}).from(appointments).innerJoin(members,eq(members.id,appointments.memberId)).where(and(eq(appointments.id,req.params.id),isNull(appointments.deletedAt),isNull(members.deletedAt),eq(appointments.status,"scheduled")));
      if(!row) return reply.code(404).send({error:"Scheduled appointment not found"});
      await audit(db,req.tenant,{action:"read",entity:"appointments",entityId:row.appointment.id,memberId:row.appointment.memberId,details:{calendarExport:true,...parsed.data}});
      return reply.type("text/calendar; charset=utf-8").header("Content-Disposition",'attachment; filename="appointment.ics"').header("Cache-Control","no-store").send(appointmentCalendar({...row.appointment,memberName:row.preferredName??row.memberName},Number(parsed.data.reminderMinutes),Number(parsed.data.durationMinutes),options.now?.()));
    });
  });
}
