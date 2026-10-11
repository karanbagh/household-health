import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { startTracing, stopTracing } from "./lib/tracing.js";
import { apiRoutes } from "./routes/api.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { pool } from "./db/client.js";

startTracing();

const app = Fastify({
  logger: {
    level: "info",
    // Request bodies carry health data; never log them.
    redact: ["req.headers['x-dev-user']", "req.body"],
  },
  genReqId: () => randomUUID(),
  bodyLimit: 64 * 1024,
});

app.register(fastifyStatic, { root: fileURLToPath(new URL("../web", import.meta.url)) });
app.register(apiRoutes, { prefix: "/api" });
app.register(onboardingRoutes, { prefix: "/api" });

app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
  req.log.error({ err }, "request failed");
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  reply.code(status).send({ error: status === 500 ? "Something went wrong on our side. Try again." : err.message, requestId: req.id });
});

const close = async () => { await app.close(); await stopTracing(); await pool.end(); process.exit(0); };
process.on("SIGINT", close);
process.on("SIGTERM", close);

if (config.authMode === "dev") app.log.warn("AUTH_MODE=dev: X-Dev-User header is trusted. Bind to localhost only.");
await app.listen({ port: config.port, host: "127.0.0.1" });
