// Database tests explicitly opt into the development fixture login.
// Production and the default application configuration use Google authentication.
// Fixtures write through an owner connection, so reject the production URL
// pulled by `neon deploy` before a test can connect to the database.
const runtime = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
if (runtime && new URL(runtime).hostname.endsWith(".neon.tech")) {
  if (!process.env.NEON_BRANCH?.startsWith("hh-neon-verification-")) {
    throw new Error("Database tests require a disposable hh-neon-verification-* Neon branch; production fixtures are forbidden");
  }
  const app = new URL(runtime);
  const owner = process.env.DATABASE_ADMIN_URL ? new URL(process.env.DATABASE_ADMIN_URL) : null;
  if (!owner || owner.hostname !== app.hostname.replace("-pooler", "") || owner.pathname !== app.pathname) {
    throw new Error("Test app and migration credentials must target the same disposable Neon database");
  }
}
process.env.AUTH_MODE = "dev";
export {};
