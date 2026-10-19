import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "@neon/env";
import pg from "pg";
import neonConfig from "../neon.js";
import { databaseConnectionString } from "../src/db/connection.js";

// Neon owns DATABASE_URL and can replace it on every deploy/env pull. Keep the
// least-privilege app URL separate, so a later pull cannot silently bypass RLS.
const envFile = process.argv[2] ?? (existsSync(".env") ? ".env" : ".env.local");
const content = await readFile(envFile, "utf8");
const { postgres } = parseEnv(neonConfig, ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]);
const pooled = new URL(databaseConnectionString(postgres.databaseUrl));
const direct = new URL(databaseConnectionString(postgres.databaseUrlUnpooled));
if (!pooled.hostname.endsWith(".neon.tech") || !pooled.hostname.includes("-pooler") ||
    direct.hostname !== pooled.hostname.replace("-pooler", "") || direct.pathname !== pooled.pathname) {
  throw new Error("Expected matching Neon pooled and unpooled URLs from neon deploy");
}
const prior = process.env.APP_DATABASE_URL ? new URL(process.env.APP_DATABASE_URL) : null;
if (prior && (prior.hostname !== pooled.hostname || prior.pathname !== pooled.pathname || decodeURIComponent(prior.username) !== "hh_app")) {
  throw new Error("APP_DATABASE_URL must point to hh_app on this branch. Remove it from the target env file before configuring a different branch.");
}
const client = new pg.Client({ connectionString: direct.toString(), connectionTimeoutMillis: 15_000 });
await client.connect();
try {
  const exists = (await client.query("select 1 from pg_roles where rolname='hh_app'")).rowCount === 1;
  if (exists && !prior) throw new Error("hh_app already exists. Supply its APP_DATABASE_URL to avoid rotating a live credential.");
  const password = prior ? decodeURIComponent(prior.password) : randomBytes(32).toString("base64url");
  if (!password) throw new Error("APP_DATABASE_URL must contain the hh_app password");
  if (!exists) {
    await client.query(`create role hh_app login password ${client.escapeLiteral(password)}`);
    // Neon requires its non-superuser database owner to be a member when granting privileges.
    await client.query(`grant hh_app to ${client.escapeIdentifier(decodeURIComponent(direct.username))}`);
  }
  pooled.username = "hh_app";
  pooled.password = password;
  const updates: Record<string, string> = {
    APP_DATABASE_URL: pooled.toString(),
    DATABASE_ADMIN_URL: direct.toString(),
    APP_DB_PASSWORD: password,
  };
  let next = content;
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    next = pattern.test(next) ? next.replace(pattern, () => line) : `${next.trimEnd()}\n${line}\n`;
  }
  await writeFile(envFile, next, { mode: 0o600 });
  await chmod(envFile, 0o600);
  console.log(`Configured restricted hh_app connection in ${envFile}; secrets were not printed.`);
  console.log("Next: run migrations with the same env file, then npm run build and npm start.");
} finally {
  await client.end();
}
