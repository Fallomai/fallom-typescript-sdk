/**
 * Vercel AI SDK streamObject wrapper.
 * 
 * SDK is "dumb" - just captures raw request/response and sends to microservice.
 * All parsing/extraction happens server-side for easier maintenance.
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

    if (!isInitialized()) {
      return result;
    }

    const traceCtx =
      getTraceContextStorage().getStore() || getFallbackTraceContext();
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const modelId = params?.model?.modelId || String(params?.model || "unknown");

    // Hook into multiple promises to capture all response data
    if (result?.usage) {
      Promise.all([
        result.usage.catch(() => null),
        result.object?.catch(() => null),
        result.finishReason?.catch(() => null),
      ])
        .then(async ([rawUsage, responseObject, finishReason]) => {
          const endTime = Date.now();

          if (debug || isDebugMode()) {
            console.log("\n🔍 [Fallom Debug] streamObject raw usage:", JSON.stringify(rawUsage, null, 2));
            console.log("🔍 [Fallom Debug] streamObject response object:", JSON.stringify(responseObject)?.slice(0, 100));
            console.log("🔍 [Fallom Debug] streamObject finish reason:", finishReason);
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
            "fallom.method": "streamObject",
            "fallom.is_streaming": true,
          };

          if (captureContent) {
            attributes["fallom.raw.request"] = JSON.stringify({
              prompt: params?.prompt,
              messages: params?.messages,
              system: params?.system,
              model: modelId,
              schema: params?.schema ? "provided" : undefined,
            });
            
            // Include response object and finish reason
            if (responseObject || finishReason) {
              attributes["fallom.raw.response"] = JSON.stringify({
                object: responseObject,
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
            is_streaming: true,
            attributes,
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
            attributes: {
              "fallom.sdk_version": "2",
              "fallom.method": "streamObject",
              "fallom.is_streaming": true,
            },
          }).catch(() => {});
        });
    }

    return result;
  };
}
