import type { FastifyReply, FastifyRequest } from "fastify";
import { pool, type TenantContext } from "../db/client.js";
import { sessionIdentity, requireCsrf } from "./sessions.js";
import { config } from "../config.js";

declare module "fastify" {
  interface FastifyRequest { tenant: TenantContext; userName: string }
}

interface Membership { user_id: string; display_name: string; household_id: string; household_name: string; role: TenantContext["role"] }

/** Identity comes from a verified server session in Google mode; dev headers never override it. */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  let memberships: Membership[];
  if (config.authMode === "google") {
    const session=await sessionIdentity(req);
    if(!session) return reply.code(401).send({error:"Sign in with Google to continue"});
    if (!["GET","HEAD","OPTIONS"].includes(req.method) && !requireCsrf(req,reply,session)) return;
    memberships=(await pool.query<Membership>("select * from auth_memberships_by_user($1)",[session.user_id])).rows;
  } else if (config.authMode === "dev") {
    const email=req.headers["x-dev-user"];
    if(typeof email!=="string"||!email) return reply.code(401).send({error:"Sign in required"});
    memberships=(await pool.query<Membership>("select * from auth_memberships($1)",[email])).rows;
  } else return reply.code(503).send({error:"Sign-in is unavailable"});
  if(!memberships.length) return reply.code(403).send({error:"Create a household to continue"});
  const rows=memberships;
  const wanted = req.headers["x-household-id"];
  const m = typeof wanted === "string" ? rows.find((r) => r.household_id === wanted) : rows.length === 1 ? rows[0] : undefined;
  if (!m) return reply.code(400).send({ error: "Choose a household", households: rows.map((r) => ({ id: r.household_id, name: r.household_name })) });

  req.tenant = { householdId: m.household_id, userId: m.user_id, role: m.role, requestId: req.id };
  req.userName = m.display_name;
}
