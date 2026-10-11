// Applies db/migrations/*.sql in order as the database owner, then sets the app role's password.
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
await client.connect();
try {
  await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    await client.query("begin");
    try {
      await client.query(await readFile(`${dir}/${file}`, "utf8"));
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  }
  const pw = process.env.APP_DB_PASSWORD;
  if (pw) {
    await client.query(`alter role hh_app with login password ${client.escapeLiteral(pw)}`);
    console.log("hh_app password set");
  }
} finally {
  await client.end();
}
