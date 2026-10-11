import { ChatOpenAI } from "@langchain/openai";
import { CallbackHandler } from "@langfuse/langchain";
import { config } from "../config.js";

/**
 * The only place the provider is chosen. To switch to a local model or another API,
 * return e.g. new ChatOllama({...}) or new ChatAnthropic({...}) here; nothing else changes.
 */
export function chatModel() {
  if (!config.openai.apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new ChatOpenAI({ model: config.openai.model, temperature: 0, apiKey: config.openai.apiKey, maxRetries: 2 });
}

/** One Langfuse handler per request; null when tracing is off. User id is the internal UUID, never an email. */
export function traceHandler(meta: { userId: string; householdId: string; conversationId: string; requestId: string }) {
  if (!config.langfuse.enabled) return null;
  return new CallbackHandler({
    userId: meta.userId,
    sessionId: meta.conversationId,
    tags: ["household-health"],
    traceMetadata: { householdId: meta.householdId, requestId: meta.requestId },
  });
}
