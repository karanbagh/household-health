import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { authRoutes } from "./routes/auth.js";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { startTracing, stopTracing } from "./lib/tracing.js";
import { appointmentRoutes } from "./routes/appointments.js";
import { chatRoutes } from "./routes/chats.js";
import { apiRoutes } from "./routes/api.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { makeLabRoutes } from "./routes/labs.js";
import { recordRoutes } from "./routes/records.js";
import { pool } from "./db/client.js";
import { householdAccessRoutes } from "./routes/household-access.js";
import { emailRoutes } from "./routes/email.js";

startTracing();

const app = Fastify({
  logger: {
    level: "info",
    // Request bodies carry health data; never log them.
    redact: ["req.headers['x-dev-user']", "req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']", "res.headers['set-cookie']", "req.body"],
    serializers: {req: (req: {method?:string;url?:string}) => ({method:req.method,url:req.url?.split("?")[0]})},
  },
  genReqId: () => randomUUID(),
  bodyLimit: 64 * 1024,
});

app.register(cookie);
app.register(authRoutes, {prefix:"/api"});
app.register(householdAccessRoutes, { prefix: "/api" });
app.register(emailRoutes, { prefix: "/api" });
app.addHook("onSend",async(req,reply)=>{if(req.url.startsWith("/api/")) reply.header("Cache-Control","no-store");});
app.get("/health", async (_req, reply) => {
  reply.header("Cache-Control", "no-store");
  try {
    await pool.query("select 1");
    return { status: "ok" };
  } catch {
    return reply.code(503).send({ status: "unavailable" });
  }
});
app.register(fastifyStatic, { root: fileURLToPath(new URL("../web", import.meta.url)) });
app.register(apiRoutes, { prefix: "/api" });
app.register(chatRoutes, { prefix: "/api" });
app.register(appointmentRoutes, { prefix: "/api" });
app.register(onboardingRoutes, { prefix: "/api" });
app.register(recordRoutes, { prefix: "/api" });
app.register(makeLabRoutes(), { prefix: "/api" });

app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
  req.log.error({ err }, "request failed");
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  reply.code(status).send({ error: status === 500 ? "Something went wrong on our side. Try again." : err.message, requestId: req.id });
});

const close = async () => { await app.close(); await stopTracing(); await pool.end(); process.exit(0); };
process.on("SIGINT", close);
process.on("SIGTERM", close);

if (config.authMode === "dev") app.log.warn("AUTH_MODE=dev: X-Dev-User header is trusted. Bind to localhost only.");
await app.listen({ port: config.port, host: config.host });
