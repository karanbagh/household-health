import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = NodePgDatabase<typeof schema>;

/** Who is acting, in which household. Built only from the authenticated session, never from LLM output. */
export interface TenantContext {
  householdId: string;
  userId: string;
  role: "owner" | "editor" | "viewer";
  requestId: string;
  traceId?: string | null;
}

/**
 * Run fn in one transaction with the tenant context set as transaction-local settings.
 * Postgres RLS reads these settings, so a query that forgets a household filter returns nothing
 * rather than another household's data. The audit triggers read the same settings.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `select set_config('app.household_id', $1, true), set_config('app.user_id', $2, true),
              set_config('app.role', $3, true), set_config('app.request_id', $4, true),
              set_config('app.trace_id', $5, true)`,
      [ctx.householdId, ctx.userId, ctx.role, ctx.requestId, ctx.traceId ?? ""],
    );
    const result = await fn(drizzle(client, { schema }));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
