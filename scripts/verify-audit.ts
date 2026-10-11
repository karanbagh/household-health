// Recomputes every household's audit hash chain. Exit code 1 if any chain is broken.
import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
const { rows } = await client.query<{ id: string; name: string; broken_at: string | null; entries: string }>(
  `select h.id, h.name, audit_verify(h.id) as broken_at, (select count(*) from audit_log a where a.household_id = h.id) as entries from households h`);
for (const r of rows) console.log(`${r.name} (${r.id}): ${r.entries} entries, ${r.broken_at ? `BROKEN at audit_log.id ${r.broken_at}` : "chain intact"}`);
await client.end();
process.exit(rows.some((r) => r.broken_at) ? 1 : 0);
