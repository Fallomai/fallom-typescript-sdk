/**
 * Vercel AI SDK streamText wrapper.
 * 
 * SDK is "dumb" - just captures raw request/response and sends to microservice.
 * All parsing/extraction happens server-side for easier maintenance.
 * 
 * IMPORTANT: You must await this function, e.g.:
 *   const { textStream, fullStream } = await streamText({...})
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
    const modelId = params?.model?.modelId || String(params?.model || "unknown");

    // Hook into multiple promises to capture all response data
    // We need: usage, text, finishReason
    if (result?.usage) {
      Promise.all([
        result.usage.catch(() => null),
        result.text?.catch(() => null),
        result.finishReason?.catch(() => null),
      ])
        .then(async ([rawUsage, responseText, finishReason]) => {
          const endTime = Date.now();

          if (debug || isDebugMode()) {
            console.log("\n🔍 [Fallom Debug] streamText raw usage:", JSON.stringify(rawUsage, null, 2));
            console.log("🔍 [Fallom Debug] streamText response text:", responseText?.slice(0, 100));
            console.log("🔍 [Fallom Debug] streamText finish reason:", finishReason);
          }

          let providerMetadata = result?.experimental_providerMetadata;
          if (providerMetadata && typeof providerMetadata.then === "function") {
            try {
              providerMetadata = await providerMetadata;
            } catch {
              providerMetadata = undefined;
            }
          }

          // SDK is dumb - just send raw data
          const attributes: Record<string, unknown> = {
            "fallom.sdk_version": "2",
            "fallom.method": "streamText",
            "fallom.is_streaming": true,
          };

          if (captureContent) {
            attributes["fallom.raw.request"] = JSON.stringify({
              prompt: params?.prompt,
              messages: params?.messages,
              system: params?.system,
              model: modelId,
            });
            
            // Include response text and finish reason
            if (responseText || finishReason) {
              attributes["fallom.raw.response"] = JSON.stringify({
                text: responseText,
                finishReason: finishReason,
              });
            }
          }

          if (rawUsage) {
            attributes["fallom.raw.usage"] = JSON.stringify(rawUsage);
          }
          if (providerMetadata) {
            attributes["fallom.raw.providerMetadata"] = JSON.stringify(providerMetadata);
          }
          if (firstTokenTime) {
            attributes["fallom.time_to_first_token_ms"] = firstTokenTime - startTime;
          }

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
            status: "OK",
            time_to_first_token_ms: firstTokenTime ? firstTokenTime - startTime : undefined,
            is_streaming: true,
            attributes,
          }).catch(() => {});
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
            attributes: {
              "fallom.sdk_version": "2",
              "fallom.method": "streamText",
              "fallom.is_streaming": true,
            },
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
