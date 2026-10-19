import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fastifyCookie as cookie } from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { config } from "../config.js";
export const SESSION_COOKIE = "hh_session";
export const OAUTH_COOKIE = "hh_oauth";
export const randomToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function cookieToken(req: FastifyRequest, name = SESSION_COOKIE): string | null {
  try { const value=cookie.parse(req.headers.cookie ?? "")[name]; return typeof value === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : null; } catch { return null; }
}
export interface SessionIdentity { user_id: string; email: string; display_name: string; csrf_token: string }
export async function sessionIdentity(req: FastifyRequest): Promise<SessionIdentity | null> {
  const token=cookieToken(req);if(!token) return null;
  const rows=await pool.query<SessionIdentity>("select * from login_session($1)",[tokenHash(token)]);return rows.rows[0]??null;
}
export function requireCsrf(req: FastifyRequest, reply: FastifyReply, session: SessionIdentity): boolean {
  const token=req.headers["x-csrf-token"],origin=req.headers.origin;
  if (typeof token!=="string" || Buffer.byteLength(token)!==Buffer.byteLength(session.csrf_token) || (origin && origin!==config.google.origin) || !timingSafeEqual(Buffer.from(token),Buffer.from(session.csrf_token))) {
    reply.code(403).send({error:"Refresh the page before trying again"});return false;
  }
  return true;
}
export const cookieOptions = (maxAge: number, path = "/") => ({ path, httpOnly:true, sameSite:"lax" as const, secure:config.google.secureCookies, maxAge });
