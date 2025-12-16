/**
 * Vercel AI SDK streamText wrapper.
 */

import {
  getTraceContextStorage,
  getFallbackTraceContext,
  isInitialized,
  shouldCaptureContent,
  isDebugMode,
  sendTrace,
} from "../../core";
import { generateHexId } from "../../utils";
import type { SessionContext, TraceData } from "../../types";
import { extractUsageFromResult } from "./utils";

function log(...args: unknown[]): void {
  if (isDebugMode()) console.log("[Fallom]", ...args);
}

export function createStreamTextWrapper(
  aiModule: any,
  sessionCtx: SessionContext,
  debug = false
) {
  const ctx = sessionCtx;

  return async (...args: any[]) => {
    const params = args[0] || {};
    const startTime = Date.now();
    const captureContent = shouldCaptureContent();

    const result = await aiModule.streamText(...args);

    if (!isInitialized()) {
      return result;
    }

    const traceCtx =
      getTraceContextStorage().getStore() || getFallbackTraceContext();
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    let firstTokenTime: number | null = null;
    const modelId =
      params?.model?.modelId || String(params?.model || "unknown");

    // Hook into the usage promise
    if (result?.usage) {
      result.usage
        .then(async (rawUsage: any) => {
          const endTime = Date.now();

          if (debug || isDebugMode()) {
            console.log(
              "\n🔍 [Fallom Debug] streamText usage:",
              JSON.stringify(rawUsage, null, 2)
            );
          }

          log("📊 streamText usage:", JSON.stringify(rawUsage, null, 2));

          let providerMetadata = result?.experimental_providerMetadata;
          if (providerMetadata && typeof providerMetadata.then === "function") {
            try {
              providerMetadata = await providerMetadata;
            } catch {
              providerMetadata = undefined;
            }
          }

          const usage = extractUsageFromResult(
            { experimental_providerMetadata: providerMetadata },
            rawUsage
          );

          const attributes: Record<string, unknown> = {};
          if (captureContent) {
            attributes["gen_ai.request.model"] = modelId;
            if (params?.prompt) {
              attributes["gen_ai.prompt.0.role"] = "user";
              attributes["gen_ai.prompt.0.content"] = params.prompt;
            }
          }

          if (firstTokenTime) {
            attributes["gen_ai.time_to_first_token_ms"] =
              firstTokenTime - startTime;
          }

          if (rawUsage) {
            attributes["fallom.raw.usage"] = JSON.stringify(rawUsage);
          }
          if (providerMetadata) {
            attributes["fallom.raw.providerMetadata"] =
              JSON.stringify(providerMetadata);
          }

          const tracePayload: TraceData = {
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: parentSpanId,
            name: "streamText",
            kind: "llm",
            model: modelId,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(endTime).toISOString(),
            duration_ms: endTime - startTime,
            status: "OK",
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
            time_to_first_token_ms: firstTokenTime
              ? firstTokenTime - startTime
              : undefined,
            attributes: captureContent ? attributes : undefined,
          };

          sendTrace(tracePayload).catch(() => {});
        })
        .catch((error: any) => {
          const endTime = Date.now();
          log("❌ streamText error:", error?.message);

          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: parentSpanId,
            name: "streamText",
            kind: "llm",
            model: modelId,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(endTime).toISOString(),
            duration_ms: endTime - startTime,
            status: "ERROR",
            error_message: error?.message,
          }).catch(() => {});
        });
    }

    // Wrap textStream to capture first token time
    if (result?.textStream) {
      const originalTextStream = result.textStream;
      const wrappedTextStream = (async function* () {
        for await (const chunk of originalTextStream) {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            log("⏱️ Time to first token:", firstTokenTime - startTime, "ms");
          }
          yield chunk;
        }
      })();

      return new Proxy(result, {
        get(target, prop) {
          if (prop === "textStream") {
            return wrappedTextStream;
          }
          return (target as any)[prop];
        },
      });
    }

    return result;
  };
}
