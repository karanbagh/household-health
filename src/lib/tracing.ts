import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { config } from "../config.js";

let sdk: NodeSDK | null = null;

/**
 * Langfuse observability via OpenTelemetry. Every LangGraph node, LLM call and tool call becomes a span.
 * With LANGFUSE_REDACT_CONTENT=true, prompt and completion text are replaced before export, so
 * Langfuse keeps structure, timings, token counts and costs without health data.
 */
export function startTracing() {
  if (!config.langfuse.enabled) return;
  const processor = new LangfuseSpanProcessor({
    ...(config.langfuse.redactContent ? { mask: () => "[redacted]" } : {}),
  });
  sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
}

export async function stopTracing() {
  await sdk?.shutdown();
}
