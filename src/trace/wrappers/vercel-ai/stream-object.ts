/**
 * Vercel AI SDK streamObject wrapper.
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
import type { SessionContext } from "../../types";
import { extractUsageFromResult } from "./utils";

function log(...args: unknown[]): void {
  if (isDebugMode()) console.log("[Fallom]", ...args);
}

export function createStreamObjectWrapper(
  aiModule: any,
  sessionCtx: SessionContext,
  debug = false
) {
  const ctx = sessionCtx;

  return async (...args: any[]) => {
    const params = args[0] || {};
    const startTime = Date.now();
    const captureContent = shouldCaptureContent();

    const result = await aiModule.streamObject(...args);

    log("🔍 streamObject result keys:", Object.keys(result || {}));

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

    // Hook into usage promise
    if (result?.usage) {
      result.usage
        .then(async (rawUsage: any) => {
          const endTime = Date.now();

          if (debug || isDebugMode()) {
            console.log(
              "\n🔍 [Fallom Debug] streamObject usage:",
              JSON.stringify(rawUsage, null, 2)
            );
          }

          log("📊 streamObject usage:", JSON.stringify(rawUsage, null, 2));

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

          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: parentSpanId,
            name: "streamObject",
            kind: "llm",
            model: modelId,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(endTime).toISOString(),
            duration_ms: endTime - startTime,
            status: "OK",
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
            attributes: captureContent ? attributes : undefined,
          }).catch(() => {});
        })
        .catch((error: any) => {
          const endTime = Date.now();

          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: parentSpanId,
            name: "streamObject",
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

    // Wrap partialObjectStream to capture first token time
    if (result?.partialObjectStream) {
      const originalStream = result.partialObjectStream;
      const wrappedStream = (async function* () {
        for await (const chunk of originalStream) {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            log("⏱️ Time to first token:", firstTokenTime - startTime, "ms");
          }
          yield chunk;
        }
      })();

      return new Proxy(result, {
        get(target, prop) {
          if (prop === "partialObjectStream") {
            return wrappedStream;
          }
          return (target as any)[prop];
        },
      });
    }

    return result;
  };
}
