import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/client.js";
import { config } from "../config.js";

const HouseholdBody = z.object({
  email: z.email().trim().max(254).transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  timezone: z.string().max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
    catch { return false; }
  }, "Invalid timezone").default("America/New_York"),
  unitSystem: z.enum(["us", "metric"]).default("us"),
}).strict();

export async function onboardingRoutes(app: FastifyInstance) {
  app.post("/households", async (req, reply) => {
    if (config.authMode !== "dev") return reply.code(501).send({ error: "Configure an identity provider before creating households" });
    const body = HouseholdBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter a valid email, your name, and household name", details: body.error.issues });
    const { email, displayName, name, timezone, unitSystem } = body.data;
    try {
      const { rows: [row] } = await pool.query<{ id: string }>(
        "select create_household($1, $2, $3, $4, $5) as id", [email, displayName, name, timezone, unitSystem]);
      return reply.code(201).send({ id: row!.id, email });
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "23505") {
        return reply.code(409).send({ error: "This email already has an account. Sign in instead." });
      }
      throw err;
    }
  });
}
