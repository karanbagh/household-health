// Exercises the LangGraph flow end to end against Postgres with a scripted stand-in for the LLM.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { pool, withTenant, type TenantContext } from "../src/db/client.js";
import { pendingEntries, auditLog, members as memberTable } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { runChat } from "../src/agent/graph.js";
import { commitProposals, undoRecords, type Proposal } from "../src/domain/entries.js";
import { buildReadTools } from "../src/agent/tools.js";
import type { LabData } from "../src/domain/labs.js";
import { understandSchema } from "../src/agent/schemas.js";

const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
let ctx: TenantContext, memberId = "";
const hh = { id: "", timezone: "America/New_York", unitSystem: "us" as const };

/** Plays back scripted structured outputs and chat turns in order. */
function scriptedModel(structured: unknown[], turns: AIMessage[]) {
  const seen: BaseMessage[][] = [];
  const m = {
    withStructuredOutput: () => ({ invoke: async () => structured.shift() }),
    bindTools: () => ({ invoke: async (msgs: BaseMessage[]) => { seen.push(msgs); return turns.shift(); } }),
    invoke: async (msgs: BaseMessage[]) => { seen.push(msgs); return turns.shift(); },
  };
  return { model: m as never, seen };
}
const none = { vital: null, medication_start: null, medication_stop: null, allergy: null, appointment: null, profile_update: null };

before(async () => {
  await admin.connect();
  const tag = randomUUID().slice(0, 8);
  const { rows: [h] } = await admin.query<{ id: string }>("insert into households (name) values ($1) returning id", [`graph-${tag}`]);
  const { rows: [u] } = await admin.query<{ id: string }>("insert into users (email, display_name) values ($1, 'p') returning id", [`${tag}@g`]);
  await admin.query("insert into household_users values ($1, $2, 'owner')", [h!.id, u!.id]);
  const { rows: [m] } = await admin.query<{ id: string }>("insert into members (household_id, full_name) values ($1, 'Harshal') returning id", [h!.id]);
  ctx = { householdId: h!.id, userId: u!.id, role: "owner", requestId: randomUUID() };
  memberId = m!.id; hh.id = h!.id;
});
after(async () => { await admin.end(); await pool.end(); });

const members = () => [{ id: memberId, name: "Harshal", dateOfBirth: null }];

test("an entry message becomes a pending proposal with a confirm card", async () => {
  const { model } = scriptedModel([{ intent: "entry", member_id: memberId, question: null, items: [
    { ...none, kind: "vital", vital: { type: "temperature", value: 101.2, value2: null, unit: null, measured_at_local: null } },
    { ...none, kind: "allergy", allergy: { substance: "Penicillin", reaction: "hives", severity: "moderate", noted_on: null } },
  ] }], []);
  const r = await runChat({ ctx, hh, members: members(), defaultMemberId: null, message: "temp 101.2, he's allergic to penicillin (hives)", history: [], callbacks: [], model });
  assert.equal(r.type, "proposal");
  if (r.type !== "proposal") return;
  assert.equal(r.items.length, 2);
  assert.match(r.items[0]!.display, /101\.2 °F \(38\.4 °C\)/);
  const [p] = await withTenant(ctx, (db) => db.select().from(pendingEntries).where(eq(pendingEntries.id, r.pendingId)));
  await withTenant(ctx, (db) => commitProposals(db, memberId, ctx.userId, ctx.householdId, p!.sourceText, p!.proposals as Proposal[]));
});

test("an unclear entry comes back as a question", async () => {
  const { model } = scriptedModel([{ intent: "entry", member_id: memberId, question: null, items: [
    { ...none, kind: "vital", vital: { type: "blood_pressure", value: 110, value2: null, unit: null, measured_at_local: null } } ] }], []);
  const r = await runChat({ ctx, hh, members: members(), defaultMemberId: null, message: "bp 110", history: [], callbacks: [], model });
  assert.equal(r.type, "clarify");
});

test("a question runs tools against the record, cites sources and is audited", async () => {
  const { model, seen } = scriptedModel(
    [{ intent: "question", member_id: memberId, items: [], question: "What is Harshal allergic to?" }],
    [new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "get_allergies", args: { include_inactive: false } }] }),
     new AIMessage("Harshal is allergic to penicillin (hives, moderate).")]);
  const r = await runChat({ ctx: { ...ctx, requestId: randomUUID() }, hh, members: members(), defaultMemberId: null, message: "allergies?", history: [], callbacks: [], model });
  assert.equal(r.type, "answer");
  if (r.type !== "answer") return;
  assert.equal(r.sources.length, 1);
  assert.match(r.sources[0]!.label, /Penicillin/);
  const toolResult = seen[1]!.at(-1)!;
  assert.match(String(toolResult.content), /Penicillin/);
  const q = await withTenant(ctx, (db) => db.select().from(auditLog).where(eq(auditLog.action, "ai_query")));
  assert.equal(q.length, 1);
  assert.equal((q[0]!.details as { tool_calls: { recordIds: string[] }[] }).tool_calls[0]!.recordIds.length, 1);
});

test("viewers get a polite refusal for entries", async () => {
  const { model } = scriptedModel([{ intent: "entry", member_id: memberId, question: null, items: [
    { ...none, kind: "vital", vital: { type: "weight", value: 30, value2: null, unit: "kg", measured_at_local: null } } ] }], []);
  const r = await runChat({ ctx: { ...ctx, role: "viewer" }, hh, members: members(), defaultMemberId: null, message: "30 kg", history: [], callbacks: [], model });
  assert.equal(r.type, "reply");
});

test("eye color becomes a profile proposal, is saved and readable, and can be undone", async () => {
  const understanding = understandSchema([memberId]).parse({
    intent: "entry", member_id: memberId, question: null, items: [{
      ...none, kind: "profile_update", profile_update: {
        full_name: null, preferred_name: null, date_of_birth: null, sex: null, blood_type: null, eye_color: "brown",
      },
    }],
  });
  const { model } = scriptedModel([understanding], []);
  const requestCtx = { ...ctx, requestId: randomUUID() };
  const r = await runChat({ ctx: requestCtx, hh, members: members(), defaultMemberId: null, message: "Harshal has brown eyes", history: [], callbacks: [], model });
  assert.equal(r.type, "proposal");
  if (r.type !== "proposal") return;
  assert.match(r.items[0]!.display, /eye color brown/);
  const [pending] = await withTenant(ctx, (db) => db.select().from(pendingEntries).where(eq(pendingEntries.id, r.pendingId)));
  const created = await withTenant(requestCtx, (db) => commitProposals(db, memberId, ctx.userId, ctx.householdId, pending!.sourceText, pending!.proposals as Proposal[]));
  const read = buildReadTools(ctx, hh, memberId);
  const profile = read.tools.find((tool) => tool.name === "get_profile")!;
  assert.match(String(await profile.invoke({})), /"eye_color":"brown"/);
  const changes = await withTenant(ctx, (db) => db.select().from(auditLog).where(eq(auditLog.requestId, requestCtx.requestId)));
  const update = changes.find((row) => row.action === "update")!;
  assert.equal((update.before as { eye_color: string | null }).eye_color, null);
  assert.equal((update.after as { eye_color: string }).eye_color, "brown");
  await withTenant(requestCtx, (db) => undoRecords(db, created));
  const [restored] = await withTenant(ctx, (db) => db.select().from(memberTable).where(eq(memberTable.id, memberId)));
  assert.equal(restored!.eyeColor, null);
});

test("latest lab questions preload every test without guessed date windows or chunk limits", async () => {
  const results: LabData["results"] = Array.from({ length: 30 }, (_, index) => ({ testName: `Test ${index}`, value: "1", unit: null, referenceRange: null, flag: "not_reported", sourceExcerpt: "test fixture" }));
  results.push({ testName: "HDL cholesterol", value: "55", unit: "mg/dL", referenceRange: ">40", flag: "not_reported", sourceExcerpt: "HDL 55 mg/dL reference >40" });
  const inserted = await admin.query<{ id: string }>(`insert into reports(household_id,member_id,title,report_date,original_text,content_hash,results,status)
    values($1,$2,'Legacy lab report','2020-10-11','Synthetic source','synthetic',$3::jsonb,'confirmed') returning id`, [ctx.householdId, memberId, JSON.stringify(results)]);
  await admin.query(`insert into reports(household_id,member_id,title,report_date,original_text,content_hash,results,status)
    values($1,$2,'Newer unsaved draft','2026-10-11','Synthetic source','synthetic','[]','draft')`, [ctx.householdId, memberId]);
  const { model, seen } = scriptedModel([{ intent: "question", member_id: memberId, question: "Is HDL in range in the latest lab report?", items: [] }], [new AIMessage("HDL cholesterol is recorded in the latest saved report.")]);
  const result = await runChat({ ctx: { ...ctx, requestId: randomUUID() }, hh, members: members(), defaultMemberId: memberId, message: "is good cholestrol in range in the latest lab report", history: [], callbacks: [], model });
  assert.equal(result.type, "answer");
  if (result.type !== "answer") return;
  assert.deepEqual(result.sources.map(source => source.id), [inserted.rows[0]!.id]);
  const toolMessage = seen[0]!.find(message => message.getType() === "tool");
  assert.ok(toolMessage, "Latest report must be fetched before the model answers");
  const content = JSON.parse(String(toolMessage.content)) as { report: { data: { reportDate: string; results: { testName: string }[] } } };
  assert.equal(content.report.data.reportDate, "2020-10-11");
  assert.equal(content.report.data.results.length, 31);
  assert.equal(content.report.data.results.at(-1)!.testName, "HDL cholesterol");
});

test("latest discharge questions preload the complete discharge document rather than the lab report", async () => {
  const sections = [{ heading: "Follow-up", text: "Synthetic discharge instructions recommend a follow-up visit in two weeks." }];
  const inserted = await admin.query<{ id: string }>(`insert into reports(household_id,member_id,title,report_type,report_date,original_text,content_hash,results,sections,status)
    values($1,$2,'Synthetic discharge summary','discharge','2026-10-11','Synthetic source','synthetic','[]',$3::jsonb,'confirmed') returning id`, [ctx.householdId, memberId, JSON.stringify(sections)]);
  const { model, seen } = scriptedModel([{ intent: "question", member_id: memberId, question: "What follow-up did the latest discharge report recommend?", items: [] }], [new AIMessage("The discharge report documents follow-up in two weeks.")]);
  const result = await runChat({ ctx: { ...ctx, requestId: randomUUID() }, hh, members: members(), defaultMemberId: memberId, message: "What follow-up did the latest discharge report recommend?", history: [], callbacks: [], model });
  assert.equal(result.type, "answer"); if (result.type !== "answer") return;
  assert.deepEqual(result.sources.map(source => source.id), [inserted.rows[0]!.id]);
  const message = seen[0]!.find(message => message.getType() === "tool"); assert.ok(message);
  const data = JSON.parse(String(message.content)) as { reports: { data: { reportType: string; sections: { text: string }[] } }[] };
  assert.equal(data.reports.length, 1); assert.equal(data.reports[0]!.data.reportType, "discharge"); assert.match(data.reports[0]!.data.sections[0]!.text, /two weeks/);
});
