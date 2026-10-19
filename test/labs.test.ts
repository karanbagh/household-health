import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { buildReadTools } from "../src/agent/tools.js";
import { onboardingRoutes } from "../src/routes/onboarding.js";
import { apiRoutes } from "../src/routes/api.js";
import type { runChat, ChatResult } from "../src/agent/graph.js";
import { appointmentRoutes } from "../src/routes/appointments.js";
import { appointmentCalendar } from "../src/domain/calendar.js";
import { chatRoutes } from "../src/routes/chats.js";
import { saveChatTurn } from "../src/domain/chats.js";
import { makeLabRoutes } from "../src/routes/labs.js";
import { pool, type TenantContext } from "../src/db/client.js";
import { searchLabs, reportChunks, decodeLabFile, vectorLiteral, type LabServices, type LabReport, type ExtractedLab } from "../src/domain/labs.js";

const app = Fastify();
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
const email = `labs-${randomUUID()}@example.com`, otherEmail = `labs-other-${randomUUID()}@example.com`, viewerEmail = `labs-viewer-${randomUUID()}@example.com`;
const headers = { "x-dev-user": email };
let ctx: TenantContext, memberId: string, otherMemberId: string, report: LabReport, extractCalls = 0, failIndex = false;
const fixture: ExtractedLab = {
  reportType: "lab", sections: [],
  title: "Synthetic lipid and glucose panel", reportDate: "2026-10-01", labName: "Test lab", patientName: "Test Member", notes: "Fasting sample", originalText: "LDL 140 mg/dL, range <100, H. Glucose 90 mg/dL, range 70–99.", warnings: [],
  results: [
    { testName: "LDL", value: "140", unit: "mg/dL", referenceRange: "<100", flag: "high", sourceExcerpt: "LDL 140 mg/dL, range <100, H" },
    { testName: "Glucose", value: "90", unit: "mg/dL", referenceRange: "70–99", flag: "not_reported", sourceExcerpt: "Glucose 90 mg/dL, range 70–99" },
  ],
};
const vector = (text: string) => { const v = Array<number>(1536).fill(0); v[/LDL|cholesterol/i.test(text) ? 0 : /glucose|sugar/i.test(text) ? 1 : 2] = 1; return v; };
const services: LabServices = {
  embeddingModel: "synthetic-test-model", extract: async () => { extractCalls++; return structuredClone(fixture); },
  embedQuery: async text => vector(text), embedDocuments: async texts => { if (failIndex) throw new Error("provider unavailable"); return texts.map(vector); },
};
before(async () => {
  await admin.connect(); app.register(onboardingRoutes, { prefix: "/api" }); app.register(apiRoutes, { prefix: "/api", chatRunner: async (args: Parameters<typeof runChat>[0]): Promise<ChatResult> => ({type:"answer",memberId:args.defaultMemberId!,text:"Synthetic answer",sources:[]}) }); app.register(makeLabRoutes(services), { prefix: "/api" }); app.register(chatRoutes, { prefix: "/api" }); app.register(appointmentRoutes, {prefix:"/api",now:()=>new Date("2026-10-11T12:00:00Z")}); await app.ready();
  await app.inject({ method: "POST", url: "/api/households", payload: { email, displayName: "Lab Owner", name: "Lab test household" } });
  const me = (await app.inject({ url: "/api/me", headers })).json<{ user: { id: string }; household: { id: string } }>();
  ctx = { householdId: me.household.id, userId: me.user.id, role: "owner", requestId: randomUUID() };
  memberId = (await app.inject({ method: "POST", url: "/api/members", headers, payload: { fullName: "Test Member" } })).json<{ id: string }>().id;
  otherMemberId = (await app.inject({ method: "POST", url: "/api/members", headers, payload: { fullName: "Second Member" } })).json<{ id: string }>().id;
  await app.inject({ method: "POST", url: "/api/households", payload: { email: otherEmail, displayName: "Other", name: "Other household" } });
  const viewer = await admin.query<{ id: string }>("insert into users(email,display_name) values($1,'Viewer') returning id", [viewerEmail]);
  await admin.query("insert into household_users(household_id,user_id,role) values($1,$2,'viewer')", [ctx.householdId, viewer.rows[0]!.id]);
});
after(async () => { await app.close(); await admin.end(); await pool.end(); });

test("validates file bytes, embedding dimensions and preserves exact printed values", () => {
  assert.throws(() => decodeLabFile({ file: { name: "fake.pdf", mime: "application/pdf", base64: Buffer.from("not pdf").toString("base64") } }));
  assert.throws(() => vectorLiteral([1])); assert.throws(() => vectorLiteral(Array<number>(1536).fill(0)));
  const chunks = reportChunks({ ...fixture, results: [{ ...fixture.results[0]!, value: "<0.01", unit: null, referenceRange: null, flag: "not_reported" }] });
  assert.match(chunks[0]!, /Result: <0.01\nPrinted reference range: not printed\nPrinted flag: not_reported/);
});
test("pasted report is stored as a reviewable draft with exact original text, excluded from search", async () => {
  const res = await app.inject({ method: "POST", url: `/api/members/${memberId}/labs`, headers, payload: { text: fixture.originalText } });
  assert.equal(res.statusCode, 201, res.body); report = res.json<LabReport>(); assert.equal(report.status, "draft");
  assert.deepEqual(await searchLabs(ctx, memberId, "cholesterol", {}, services), []);
  const original = await app.inject({ url: `/api/labs/${report.id}/original`, headers }); assert.equal(original.body, fixture.originalText);
  const audited = await admin.query<{ entity: string; after: Record<string, unknown> }>("select entity, after from audit_log where entity_id=$1 and action='create'", [report.id]);
  assert.equal(audited.rows[0]!.entity, "reports");
  assert.equal(audited.rows[0]!.after.original_text, undefined); assert.equal(audited.rows[0]!.after.file_data, undefined);
});
test("confirmation builds semantic index and synonyms rank the relevant test; member and tenant isolated", async () => {
  const res = await app.inject({ method: "PUT", url: `/api/labs/${report.id}`, headers, payload: { revision: report.revision, data: report.data } });
  assert.equal(res.statusCode, 200, res.body); report = res.json<LabReport>(); assert.equal(report.status, "confirmed");
  const hits = await searchLabs(ctx, memberId, "cholesterol", {}, services); assert.match(hits[0]!.content, /Test: LDL/); assert.equal(hits[0]!.reportId, report.id);
  assert.deepEqual(await searchLabs(ctx, otherMemberId, "cholesterol", {}, services), []);
  assert.deepEqual(await searchLabs(ctx, memberId, "cholesterol", { fromDate: "2026-10-02" }, services), []);
  for (const suffix of ["", "/original"]) assert.equal((await app.inject({ url: `/api/labs/${report.id}${suffix}`, headers: { "x-dev-user": otherEmail } })).statusCode, 404);
  const otherMe = (await app.inject({ url: "/api/me", headers: { "x-dev-user": otherEmail } })).json<{ user: { id: string }; household: { id: string } }>();
  assert.deepEqual(await searchLabs({ ...ctx, householdId: otherMe.household.id, userId: otherMe.user.id }, memberId, "cholesterol", {}, services), []);
  const tools = buildReadTools(ctx, { id: ctx.householdId, timezone: "America/New_York", unitSystem: "us" }, memberId, services);
  const searchTool = tools.tools.find(t => t.name === "search_lab_results")!;
  const searched = await searchTool.invoke({ query: "cholesterol", from_date: null, to_date: null });
  assert.match(String(searched), /LDL/); assert.equal(tools.sources.length, 1); assert.equal(tools.sources[0]!.id, report.id);
  const historyTool = tools.tools.find(t => t.name === "get_lab_reports")!;
  assert.match(String(await historyTool.invoke({ from_date: null, to_date: null })), /140/); assert.equal(tools.sources.length, 1);
  const beforeCalls = extractCalls;
  assert.equal((await app.inject({ method: "POST", url: `/api/members/${memberId}/labs`, headers: { "x-dev-user": otherEmail }, payload: { text: "test" } })).statusCode, 404);
  assert.equal(extractCalls, beforeCalls);
});
test("viewers can read but cannot upload, revise or delete, before model invocation", async () => {
  const viewer = { "x-dev-user": viewerEmail }, beforeCalls = extractCalls;
  assert.equal((await app.inject({ url: `/api/labs/${report.id}`, headers: viewer })).statusCode, 200);
  for (const [method, url, payload] of [
    ["POST", `/api/members/${memberId}/labs`, { text: "text" }], ["PUT", `/api/labs/${report.id}`, { revision: report.revision, data: report.data }], ["DELETE", `/api/labs/${report.id}`, undefined],
  ] as const) assert.equal((await app.inject({ method, url, headers: viewer, payload })).statusCode, 403);
  assert.equal(extractCalls, beforeCalls);
});
test("revisions atomically replace old index, reject stale changes, preserve original and survive embedding failure", async () => {
  const invalidDate = await app.inject({ method: "PUT", url: `/api/labs/${report.id}`, headers, payload: { revision: report.revision, data: { ...report.data, reportDate: "1110-11-26" } } });
  assert.equal(invalidDate.statusCode, 400);
  const oldRevision = report.revision, data = structuredClone(report.data); data.results[0]!.value = "120";
  failIndex = true;
  assert.equal((await app.inject({ method: "PUT", url: `/api/labs/${report.id}`, headers, payload: { revision: oldRevision, data } })).statusCode, 503);
  assert.match((await searchLabs(ctx, memberId, "cholesterol", {}, services))[0]!.content, /Result: 140/);
  failIndex = false;
  const saved = await app.inject({ method: "PUT", url: `/api/labs/${report.id}`, headers, payload: { revision: oldRevision, data } }); assert.equal(saved.statusCode, 200, saved.body); report = saved.json<LabReport>();
  const hits = await searchLabs(ctx, memberId, "cholesterol", {}, services); assert.match(hits[0]!.content, /Result: 120/); assert.ok(hits.every(h => !h.content.includes("Result: 140")));
  assert.equal((await app.inject({ method: "PUT", url: `/api/labs/${report.id}`, headers, payload: { revision: oldRevision, data } })).statusCode, 409);
  assert.equal((await app.inject({ url: `/api/labs/${report.id}/original`, headers })).body, fixture.originalText);
});
test("binary originals round-trip and malformed or contradictory uploads are rejected", async () => {
  const bytes = Buffer.from("%PDF-1.4\nsynthetic test fixture\n" + "x".repeat(80000));
  const created = await app.inject({ method: "POST", url: `/api/members/${memberId}/labs`, headers, payload: { file: { name: "sample.pdf", mime: "application/pdf", base64: bytes.toString("base64") } } });
  assert.equal(created.statusCode, 201, created.body);
  const original = await app.inject({ url: `/api/labs/${created.json<LabReport>().id}/original`, headers }); assert.deepEqual(original.rawPayload, bytes); assert.equal(original.headers["content-type"], "application/pdf");
  for (const payload of [{}, { text: "text", file: { name: "a.png", mime: "image/png", base64: "AAAA" } }, { file: { name: "a.pdf", mime: "application/pdf", base64: "AAAA" } }]) assert.equal((await app.inject({ method: "POST", url: `/api/members/${memberId}/labs`, headers, payload })).statusCode, 400);
});
test("deleting a report removes searchable chunks and access to the original", async () => {
  assert.equal((await app.inject({ method: "DELETE", url: `/api/labs/${report.id}`, headers })).statusCode, 200);
  assert.deepEqual(await searchLabs(ctx, memberId, "cholesterol", {}, services), []);
  assert.equal((await app.inject({ url: `/api/labs/${report.id}/original`, headers })).statusCode, 404);
  const chunks = await admin.query("select 1 from report_chunks where report_id=$1", [report.id]); assert.equal(chunks.rows.length, 0);
});

test("miscellaneous reports retain narrative sections, stay scoped, and replace their index when edited", async () => {
  const narrative: ExtractedLab = {
    ...fixture, reportType: "discharge", title: "Synthetic discharge summary", results: [], notes: "", sections: [
      { heading: "Procedure", text: "Synthetic procedure performed on 2026-10-01." },
      { heading: "Follow-up recommendations", text: "The report recommends a follow-up visit in two weeks and no heavy lifting for seven days." },
    ],
  };
  const narrativeServices: LabServices = { ...services, extract: async () => narrative };
  const isolatedApp = Fastify(); isolatedApp.register(makeLabRoutes(narrativeServices), { prefix: "/api" }); await isolatedApp.ready();
  try {
    const source = "SYNTHETIC DISCHARGE REPORT: follow-up in two weeks; no heavy lifting for seven days.";
    const created = await isolatedApp.inject({ method: "POST", url: `/api/members/${memberId}/reports`, headers, payload: { text: source, reportType: "discharge" } });
    assert.equal(created.statusCode, 201, created.body);
    let document = created.json<LabReport>(); assert.equal(document.data.reportType, "discharge"); assert.deepEqual(document.data.sections, narrative.sections);
    assert.ok(!(await searchLabs(ctx, memberId, "follow-up", { reportType: null }, services)).some(hit => hit.reportId === document.id));
    const saved = await isolatedApp.inject({ method: "PUT", url: `/api/reports/${document.id}`, headers, payload: { revision: document.revision, data: document.data } });
    assert.equal(saved.statusCode, 200, saved.body); document = saved.json<LabReport>();
    const hits = await searchLabs(ctx, memberId, "follow-up", { reportType: "discharge" }, services);
    assert.ok(hits.some(hit => hit.content.includes("no heavy lifting for seven days")));
    assert.ok(!(await searchLabs(ctx, memberId, "follow-up", {}, services)).some(hit => hit.reportId === document.id), "lab-only searches must exclude narrative reports");
    assert.deepEqual(await searchLabs(ctx, otherMemberId, "follow-up", { reportType: null }, services), []);
    for (const path of [`/api/reports/${document.id}`, `/api/reports/${document.id}/original`]) assert.equal((await isolatedApp.inject({ url: path, headers: { "x-dev-user": otherEmail } })).statusCode, 404);
    assert.equal((await isolatedApp.inject({ method: "PUT", url: `/api/reports/${document.id}`, headers: { "x-dev-user": viewerEmail }, payload: { revision: document.revision, data: document.data } })).statusCode, 403);
    const read = buildReadTools(ctx, { id: ctx.householdId, timezone: "America/New_York", unitSystem: "us" }, memberId, services);
    const search = read.tools.find(tool => tool.name === "search_reports")!;
    assert.match(String(await search.invoke({ query: "follow-up", report_type: "discharge", from_date: null, to_date: null })), /two weeks/);
    const complete = await read.getReports.invoke({ report_type: "discharge", latest: true, from_date: null, to_date: null }); assert.match(String(complete), /Synthetic procedure/); assert.equal(read.sources.length, 1);
    const labOnly = await read.getLatestLabReport.invoke({}); assert.ok(!String(labOnly).includes(document.id));
    const edited = { ...document.data, sections: [{ heading: "Reviewed instructions", text: "The report recommends follow-up in three weeks." }] };
    const updated = await isolatedApp.inject({ method: "PUT", url: `/api/reports/${document.id}`, headers, payload: { revision: document.revision, data: edited } }); assert.equal(updated.statusCode, 200, updated.body);
    const updatedHits = await searchLabs(ctx, memberId, "follow-up", { reportType: null }, services);
    assert.ok(updatedHits.some(hit => hit.content.includes("three weeks"))); assert.ok(updatedHits.every(hit => !hit.content.includes("seven days")));
    assert.equal((await isolatedApp.inject({ url: `/api/reports/${document.id}/original`, headers })).body, source);
    assert.equal((await isolatedApp.inject({ method: "DELETE", url: `/api/reports/${document.id}`, headers })).statusCode, 200);
    assert.deepEqual(await searchLabs(ctx, memberId, "follow-up", { reportType: "discharge" }, services), []);
  } finally { await isolatedApp.close(); }
});

test("narrative indexing covers long sections and preserves instructions across chunk boundaries", () => {
  const text = "x".repeat(1400) + " Follow up with the surgeon in two weeks." + "y".repeat(2000);
  const chunks = reportChunks({ ...fixture, results: [], notes: "", reportType: "surgery", sections: [{ heading: "Recommendations", text }] });
  assert.ok(chunks.some(chunk => chunk.includes("Follow up with the surgeon in two weeks.")));
  assert.ok(chunks.at(-1)!.endsWith(text.slice(2600)));
});

test("saved sessions survive retrieval, isolate users and members, and preserve ordered follow-up context", async () => {
  const key=randomUUID(), otherKey=randomUUID();
  const first={message:"What was recorded?",response:{type:"answer" as const,memberId,text:"Synthetic answer",sources:[]},historyBefore:[]};
  const posted=await app.inject({method:"POST",url:"/api/chat",headers,payload:{memberId,conversationId:key,message:first.message,history:[]}});
  assert.equal(posted.statusCode,200,posted.body);
  await saveChatTurn(ctx,memberId,key,{message:"What about before?",response:{type:"answer",memberId,text:"Synthetic follow-up",sources:[]},historyBefore:[{role:"user",content:first.message},{role:"assistant",content:"Synthetic answer"}]});
  await saveChatTurn(ctx,otherMemberId,otherKey,first);
  const list=await app.inject({url:`/api/members/${memberId}/chats`,headers});assert.equal(list.statusCode,200);
  const sessions=list.json<{conversationId:string;turnCount:number;title:string}[]>();assert.equal(sessions.length,1);assert.equal(sessions[0]!.conversationId,key);assert.equal(sessions[0]!.turnCount,2);
  const resumed=await app.inject({url:`/api/members/${memberId}/chats/${key}`,headers});assert.equal(resumed.statusCode,200);
  const saved=resumed.json<{turns:{message:string;historyBefore:{content:string}[]}[]}>();assert.equal(saved.turns[1]!.message,"What about before?");assert.equal(saved.turns[1]!.historyBefore[1]!.content,"Synthetic answer");
  for(const account of [otherEmail,viewerEmail]) assert.equal((await app.inject({url:`/api/members/${memberId}/chats/${key}`,headers:{"x-dev-user":account}})).statusCode,404);
  assert.equal((await app.inject({url:`/api/members/${otherMemberId}/chats/${key}`,headers})).statusCode,404);
  const pending=await admin.query<{id:string}>("insert into pending_entries(household_id,member_id,created_by,source_text,proposals,status) values($1,$2,$3,'synthetic','[]','confirmed') returning id",[ctx.householdId,memberId,ctx.userId]);
  await saveChatTurn(ctx,memberId,key,{message:"Synthetic entry",response:{type:"proposal",memberId,pendingId:pending.rows[0]!.id,items:[]},historyBefore:[]});
  const current=(await app.inject({url:`/api/members/${memberId}/chats/${key}`,headers})).json<{turns:{response:{entryStatus?:string}}[]}>();assert.equal(current.turns.at(-1)!.response.entryStatus,"confirmed");
});

test("calendar invites preserve UTC timing, reminder choice, safe text escaping and UTF-8 folding",()=>{
  const id=randomUUID();
  const calendar=appointmentCalendar({id,memberName:"Test, Member",startsAt:new Date("2026-10-15T19:00:00Z"),providerName:"Dr. Example",specialty:"Dentist",location:"Room; 1\nBEGIN:VEVENT"},60,30,new Date("2026-10-11T12:00:00Z"));
  assert.match(calendar,/DTSTART:20261015T190000Z/);assert.match(calendar,/DTEND:20261015T193000Z/);assert.match(calendar,/TRIGGER:-PT60M/);assert.match(calendar,/SUMMARY:Test\\, Member/);assert.match(calendar,/LOCATION:Room\\; 1\\nBEGIN:VEVENT/);
  assert.equal(calendar.split("\r\n").filter(line=>line==="BEGIN:VEVENT").length,1);
  const long=appointmentCalendar({id,memberName:"測".repeat(100),startsAt:new Date(),providerName:null,specialty:null,location:null},15,60);
  assert.ok(long.split("\r\n").every(line=>Buffer.byteLength(line,"utf8")<=75));
  assert.ok(long.replace(/\r\n /g,"").includes("測".repeat(100)));
});

test("login notice includes only scheduled appointments within seven days; calendar exports are tenant scoped",async()=>{
  const create=async(member:string,time:string,status:string,household=ctx.householdId)=>{
    const inserted=await admin.query<{id:string}>("insert into appointments(household_id,member_id,starts_at,specialty,status) values($1,$2,$3,'Dentist',$4) returning id",[household,member,time,status]);return inserted.rows[0]!.id;
  };
  const upcoming=await create(memberId,"2026-10-12T19:00:00Z","scheduled");
  const cancelled=await create(otherMemberId,"2026-10-12T19:00:00Z","cancelled");
  const completed=await create(memberId,"2026-10-12T19:00:00Z","completed");
  await create(memberId,"2026-10-11T11:59:59Z","scheduled");await create(memberId,"2026-10-18T12:00:00Z","scheduled");
  const listed=await app.inject({url:"/api/appointments/upcoming",headers});assert.equal(listed.statusCode,200);
  const body=listed.json<{appointments:{id:string;memberName:string}[];hasMore:boolean}>();assert.deepEqual(body.appointments.map(a=>a.id),[upcoming]);assert.equal(body.appointments[0]!.memberName,"Test Member");assert.equal(body.hasMore,false);
  const exported=await app.inject({url:`/api/appointments/${upcoming}/calendar?reminderMinutes=15&durationMinutes=30`,headers});assert.equal(exported.statusCode,200);assert.match(exported.headers["content-type"] as string,/text\/calendar/);assert.match(exported.body,/TRIGGER:-PT15M/);assert.match(exported.body,/UID:appointment-/);
  assert.equal((await app.inject({url:`/api/appointments/${upcoming}/calendar`,headers:{"x-dev-user":viewerEmail}})).statusCode,200);
  assert.equal((await app.inject({url:`/api/appointments/${upcoming}/calendar`,headers:{"x-dev-user":otherEmail}})).statusCode,404);
  assert.equal((await app.inject({url:`/api/appointments/${upcoming}/calendar?reminderMinutes=-5`,headers})).statusCode,400);
  for(const id of [cancelled,completed]) assert.equal((await app.inject({url:`/api/appointments/${id}/calendar`,headers})).statusCode,404);
  await admin.query("update appointments set deleted_at=now() where id=$1",[upcoming]);assert.equal((await app.inject({url:`/api/appointments/${upcoming}/calendar`,headers})).statusCode,404);
});
