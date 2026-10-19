import { databaseConnectionString } from "./db/connection.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

const authMode = process.env.AUTH_MODE ?? "google";
if (!["google", "dev", "disabled"].includes(authMode)) throw new Error("Invalid AUTH_MODE");
if (process.env.NODE_ENV === "production" && authMode === "dev") throw new Error("Development authentication cannot run in production");
const appOrigin = new URL(process.env.APP_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`);
if (appOrigin.pathname !== "/" || appOrigin.search || appOrigin.hash || appOrigin.username || appOrigin.password) throw new Error("APP_ORIGIN must be an origin without a path");
if (appOrigin.protocol !== "https:" && !(appOrigin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(appOrigin.hostname))) throw new Error("APP_ORIGIN requires HTTPS outside localhost");
if (process.env.NODE_ENV === "production" && appOrigin.protocol !== "https:") throw new Error("Production requires HTTPS");
if (process.env.NODE_ENV === "production" && authMode === "google") { required("GOOGLE_CLIENT_ID"); required("GOOGLE_CLIENT_SECRET"); }
const databaseUrl = databaseConnectionString(process.env.APP_DATABASE_URL || required("DATABASE_URL"));
const databaseAddress = new URL(databaseUrl);
if (databaseAddress.hostname.endsWith(".neon.tech") && decodeURIComponent(databaseAddress.username) !== "hh_app") {
  throw new Error("Neon application traffic must use hh_app. Run npm run db:setup-neon to configure APP_DATABASE_URL.");
}
if (process.env.APP_DATABASE_URL && process.env.DATABASE_URL) {
  const managed = new URL(process.env.DATABASE_URL);
  if (managed.hostname.endsWith(".neon.tech") &&
      (managed.hostname.replace("-pooler", "") !== databaseAddress.hostname.replace("-pooler", "") || managed.pathname !== databaseAddress.pathname)) {
    throw new Error("APP_DATABASE_URL and DATABASE_URL target different databases. Configure hh_app for the selected Neon branch before starting.");
  }
}
const host = process.env.HOST ?? "127.0.0.1";
if (authMode === "dev" && !["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Development authentication must bind to localhost");
export const config = {
  host,
  port: Number(process.env.PORT ?? 8080),
  databaseUrl,
  authMode: authMode as "google" | "dev" | "disabled",
  google: { clientId: process.env.GOOGLE_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "", origin: appOrigin.origin, secureCookies: appOrigin.protocol === "https:" },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    labModel: process.env.OPENAI_LAB_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
  },
  langfuse: {
    enabled: Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
    redactContent: process.env.LANGFUSE_REDACT_CONTENT === "true",
  },
};
