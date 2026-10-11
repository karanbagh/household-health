import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { withTenant, type TenantContext } from "../db/client.js";
import { pendingEntries } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { nowDescription } from "../lib/time.js";
import { buildProposals, type Household, type Proposal } from "../domain/entries.js";
import { chatModel } from "./llm.js";
import { understandSchema, type Understanding } from "./schemas.js";
import { buildReadTools, type Source } from "./tools.js";

export interface MemberRef { id: string; name: string; dateOfBirth: string | null }
export interface Turn { role: "user" | "assistant"; content: string }

export type ChatResult =
  | { type: "answer"; memberId: string; text: string; sources: Source[] }
  | { type: "proposal"; memberId: string; pendingId: string; items: { kind: Proposal["kind"]; display: string; assumptions: string[] }[] }
  | { type: "clarify"; memberId: string | null; text: string }
  | { type: "reply"; text: string };

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  understanding: Annotation<Understanding | null>(),
  memberId: Annotation<string | null>(),
  result: Annotation<ChatResult | null>(),
});

const MAX_TOOL_ROUNDS = 6;

function understandPrompt(hh: Household, members: MemberRef[]) {
  return `You help parents keep a household's health records. Classify the latest message and, for entries, extract every fact.
Now: ${nowDescription(hh.timezone)}. Resolve "this morning", "yesterday", "next Tuesday at 3" against this.
Household members (use these ids):
${members.map((m) => `- ${m.id}: ${m.name}${m.dateOfBirth ? ` (born ${m.dateOfBirth})` : ""}`).join("\n")}

Rules:
- Record exactly what the parent said. Never convert units, never fill in a unit, dose or date they did not give; use null.
- One item per fact: "weight 32 kg and temp 101.2" is two vital items. A reading like "BP 110/70" is one blood_pressure item.
- If the latest message answers a question you asked earlier in the conversation, output the complete entry combining both.
- Corrections such as "actually it was 31.4" restate the full entry with the corrected value.
- Starting, changing or stopping a medicine, new allergies, booked appointments, and profile details are entries.
- Profile details include name, preferred name, date of birth, sex, blood type, and eye color. "Siva has brown eyes" is an entry with profile_update.eye_color = "brown"; other profile fields are null.
- Questions about what is recorded are intent=question; restate them so they stand alone.`;
}

const ANSWER_PROMPT = (hh: Household, member: MemberRef) => `You answer a parent's questions about ${member.name}'s health record.
Now: ${nowDescription(hh.timezone)}.
- Use the tools for every fact. Answer only from tool results; if something is not recorded, say so plainly.
- Give dates with every reading or event. Use the trend numbers the tools compute; do not do arithmetic yourself.
- Be brief and direct: lead with the answer, then the supporting details. Use short lists only for several items.
- You are a record keeper, not a clinician: do not diagnose or advise on doses or treatment. If asked, give the recorded facts and suggest checking with ${member.name}'s doctor.`;

export async function runChat(args: {
  ctx: TenantContext;
  hh: Household;
  members: MemberRef[];
  defaultMemberId: string | null;
  message: string;
  history: Turn[];
  callbacks: BaseCallbackHandler[];
  /** Injected in tests; defaults to the configured provider. */
  model?: ReturnType<typeof chatModel>;
}): Promise<ChatResult> {
  const { ctx, hh, members, message, history, callbacks } = args;
  if (!members.length) return { type: "reply", text: "Add a household member first." };
  const memberIds = members.map((m) => m.id) as [string, ...string[]];
  const model = args.model ?? chatModel();
  const historyMsgs: BaseMessage[] = history.slice(-8).map((t) => (t.role === "user" ? new HumanMessage(t.content) : new AIMessage(t.content)));

  // Read tools are bound after the member is known; the graph is built per request so they close over this tenant.
  let read: ReturnType<typeof buildReadTools> | null = null;
  const memberById = (id: string | null) => members.find((m) => m.id === id) ?? null;

  const graph = new StateGraph(State)
    .addNode("understand", async () => {
      const u = await model.withStructuredOutput(understandSchema(memberIds), { name: "understand_message" })
        .invoke([new SystemMessage(understandPrompt(hh, members)), ...historyMsgs, new HumanMessage(message)]);
      const memberId = memberById(u.member_id)?.id ?? memberById(args.defaultMemberId)?.id ?? (members.length === 1 ? members[0]!.id : null);
      return { understanding: u, memberId };
    })

    .addNode("propose", async (s) => {
      const u = s.understanding!;
      if (ctx.role === "viewer") return { result: { type: "reply", text: "You have view-only access, so I can't record changes." } satisfies ChatResult };
      if (!u.items.length) return { result: { type: "clarify", memberId: s.memberId, text: "What would you like me to record?" } satisfies ChatResult };
      const memberId = s.memberId!;
      const result = await withTenant(ctx, async (db) => {
        const { proposals, issues } = await buildProposals(db, hh, memberId, u.items);
        if (issues.length) return { type: "clarify", memberId, text: issues.join("\n") } satisfies ChatResult;
        if (!proposals.length) return { type: "clarify", memberId, text: "I didn't find anything to record. Can you rephrase?" } satisfies ChatResult;
        const [row] = await db.insert(pendingEntries).values({
          householdId: ctx.householdId, memberId, createdBy: ctx.userId, sourceText: message, proposals, status: "pending", traceId: ctx.traceId ?? null,
        }).returning({ id: pendingEntries.id });
        await audit(db, ctx, { action: "entry_proposed", entity: "pending_entries", entityId: row!.id, memberId,
          details: { message, proposals: proposals.map((p) => ({ kind: p.kind, display: p.display, assumptions: p.assumptions })) } });
        return { type: "proposal", memberId, pendingId: row!.id,
          items: proposals.map((p) => ({ kind: p.kind, display: p.display, assumptions: p.assumptions })) } satisfies ChatResult;
      });
      return { result };
    })

    .addNode("prepare_answer", (s) => {
      read = buildReadTools(ctx, hh, s.memberId!);
      const question = s.understanding!.question ?? message;
      return { messages: [new SystemMessage(ANSWER_PROMPT(hh, memberById(s.memberId)!)), ...historyMsgs, new HumanMessage(question)] };
    })

    .addNode("agent", async (s) => {
      const rounds = s.messages.filter((m) => m.getType() === "tool").length;
      const bound = rounds >= MAX_TOOL_ROUNDS ? model : model.bindTools(read!.tools);
      return { messages: [await bound.invoke(s.messages)] };
    })

    .addNode("tools", async (s, config) => new ToolNode(read!.tools).invoke(s, config))

    .addNode("finish_answer", async (s) => {
      const last = s.messages.at(-1);
      const text = typeof last?.content === "string" ? last.content : (last?.text ?? "");
      await withTenant(ctx, (db) => audit(db, ctx, {
        action: "ai_query", entity: "conversation", memberId: s.memberId,
        details: { question: message, standalone_question: s.understanding?.question, tool_calls: read!.calls, answer_chars: text.length },
      }));
      return { result: { type: "answer", memberId: s.memberId!, text, sources: read!.sources } satisfies ChatResult };
    })

    .addNode("ask_member", () => ({
      result: { type: "clarify", memberId: null, text: `Who is this about: ${members.map((m) => m.name).join(" or ")}?` } satisfies ChatResult,
    }))

    .addNode("other", () => ({
      result: { type: "reply", text: "I can record readings, medications, allergies, appointments and profile details, or answer questions about them. For example: \"Weight 32.4 kg this morning\" or \"What is he taking right now?\"" } satisfies ChatResult,
    }))

    .addEdge(START, "understand")
    .addConditionalEdges("understand", (s) => {
      const intent = s.understanding!.intent;
      if (intent === "other") return "other";
      if (!s.memberId) return "ask_member";
      return intent === "entry" ? "propose" : "prepare_answer";
    }, ["other", "ask_member", "propose", "prepare_answer"])
    .addEdge("prepare_answer", "agent")
    .addConditionalEdges("agent", (s) => (toolsCondition(s) === "tools" ? "tools" : "finish_answer"), ["tools", "finish_answer"])
    .addEdge("tools", "agent")
    .addEdge("propose", END)
    .addEdge("finish_answer", END)
    .addEdge("ask_member", END)
    .addEdge("other", END)
    .compile();

  const final = await graph.invoke({ messages: [] }, { callbacks, recursionLimit: 4 + MAX_TOOL_ROUNDS * 2 + 2, runName: "household-health-chat" });
  return final.result ?? { type: "reply", text: "Something went wrong. Please try again." };
}
