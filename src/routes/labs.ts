import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { authenticate } from "../lib/auth.js";
import { withTenant } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { LabError, LabUploadSchema, LabDataSchema, createLabDraft, defaultLabServices, getLabReport, saveLabReview, LAB_COLUMNS, toLabReport, type LabServices, type StoredLab } from "../domain/labs.js";

export function makeLabRoutes(services: LabServices = defaultLabServices()) {
  return async function labRoutes(app: FastifyInstance) {
    app.addHook("preHandler", authenticate);
    app.addHook("preHandler", async (req, reply) => {
      if (req.method !== "GET" && req.tenant.role === "viewer") return reply.code(403).send({ error: "You have view-only access" });
      const params = req.params as Record<string, unknown>;
      if (!z.uuid().safeParse(params.id).success) return reply.code(400).send({ error: "Invalid report or member" });
    });
    app.setErrorHandler((error: Error, req, reply) => {
      if (error instanceof LabError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.find(issue => issue.path.includes("reportDate"))?.message ?? "Enter valid report details" });
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status < 500) return reply.code(status).send({ error: error.message });
      req.log.error({ error: error.name }, "lab request failed");
      return reply.code(500).send({ error: "Could not process the report. Try again." });
    });
    for (const resource of ["labs", "reports"]) {
    app.post<{ Params: { id: string } }>(`/members/:id/${resource}`, { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
      const upload = LabUploadSchema.parse(req.body);
      return reply.code(201).send(await createLabDraft(req.tenant, req.params.id, upload, services));
    });
    app.get<{ Params: { id: string } }>(`/members/:id/${resource}`, async (req) => withTenant(req.tenant, async (db) => {
      const member = await db.execute(sql`select 1 from members where id=${req.params.id} and deleted_at is null`);
      if (!member.rows.length) throw new LabError("Member not found", 404);
      const rows = await db.execute<StoredLab>(sql`select ${LAB_COLUMNS} from reports where member_id=${req.params.id} and deleted_at is null order by report_date desc nulls last, created_at desc`);
      await audit(db, req.tenant, { action: "read", entity: "reports", memberId: req.params.id });
      return rows.rows.map(toLabReport);
    }));
    app.get<{ Params: { id: string } }>(`/${resource}/:id`, async (req) => {
      const report = await getLabReport(req.tenant, req.params.id);
      await withTenant(req.tenant, (db) => audit(db, req.tenant, { action: "read", entity: "reports", entityId: report.id, memberId: report.memberId }));
      return report;
    });
    app.put<{ Params: { id: string } }>(`/${resource}/:id`, { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
      const body = z.object({ revision: z.number().int().positive(), data: LabDataSchema }).strict().parse(req.body);
      return saveLabReview(req.tenant, req.params.id, body.revision, body.data, services);
    });
    app.delete<{ Params: { id: string } }>(`/${resource}/:id`, async (req) => {
      const report = await getLabReport(req.tenant, req.params.id);
      return withTenant(req.tenant, async (db) => {
        const row = await db.execute(sql`update reports set deleted_at=now(), updated_at=now(), revision=revision+1 where id=${report.id} and deleted_at is null returning id`);
        if (!row.rows.length) throw new LabError("Report not found", 404);
        await db.execute(sql`delete from report_chunks where report_id=${report.id}`);
        return { deleted: true };
      });
    });
    app.get<{ Params: { id: string } }>(`/${resource}/:id/original`, async (req, reply) => {
      const report = await getLabReport(req.tenant, req.params.id);
      const source = await withTenant(req.tenant, async (db) => {
        const rows = await db.execute<{ file_data: Buffer | null; file_mime: string | null; original_text: string }>(sql`select file_data,file_mime,original_text from reports where id=${report.id} and deleted_at is null`);
        await audit(db, req.tenant, { action: "read", entity: "reports", entityId: report.id, memberId: report.memberId, details: { original: true } });
        return rows.rows[0];
      });
      if (!source) throw new LabError("Report not found", 404);
      return reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(report.fileName ?? "lab-report.txt").replace(/'/g, "%27")}`)
        .header("X-Content-Type-Options", "nosniff").type(source.file_mime ?? "text/plain; charset=utf-8").send(source.file_data ?? source.original_text);
    });
    }
  };
}
