import type { FastifyReply, FastifyRequest } from "fastify";
import { pool, type TenantContext } from "../db/client.js";
import { config } from "../config.js";

declare module "fastify" {
  interface FastifyRequest { tenant: TenantContext; userName: string }
}

interface Membership { user_id: string; display_name: string; household_id: string; household_name: string; role: TenantContext["role"] }

/**
 * Resolves the caller to (user, household, role).
 * v0 ships a development mode that trusts an email in the X-Dev-User header; it must not be exposed
 * beyond localhost. Replace this function with your identity provider (OIDC / passkeys) before real use:
 * everything downstream depends only on request.tenant.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  if (config.authMode !== "dev") return reply.code(501).send({ error: "Configure an identity provider in src/lib/auth.ts" });
  const email = req.headers["x-dev-user"];
  if (typeof email !== "string" || !email) return reply.code(401).send({ error: "Sign in required" });

  const { rows } = await pool.query<Membership>("select * from auth_memberships($1)", [email]);
  if (!rows.length) return reply.code(403).send({ error: "This account isn't part of a household" });

  const wanted = req.headers["x-household-id"];
  const m = typeof wanted === "string" ? rows.find((r) => r.household_id === wanted) : rows.length === 1 ? rows[0] : undefined;
  if (!m) return reply.code(400).send({ error: "Choose a household", households: rows.map((r) => ({ id: r.household_id, name: r.household_name })) });

  req.tenant = { householdId: m.household_id, userId: m.user_id, role: m.role, requestId: req.id };
  req.userName = m.display_name;
}
