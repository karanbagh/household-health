function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required("DATABASE_URL"),
  authMode: (process.env.AUTH_MODE ?? "dev") as "dev" | "disabled",
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  },
  langfuse: {
    enabled: Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
    redactContent: process.env.LANGFUSE_REDACT_CONTENT === "true",
  },
};
