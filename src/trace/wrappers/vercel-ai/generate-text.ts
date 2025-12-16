/**
 * Vercel AI SDK generateText wrapper.
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

export function createGenerateTextWrapper(
  aiModule: any,
  sessionCtx: SessionContext,
  debug = false
) {
  const ctx = sessionCtx;

  return async (...args: any[]) => {
    if (!isInitialized()) {
      return aiModule.generateText(...args);
    }

    const traceCtx =
      getTraceContextStorage().getStore() || getFallbackTraceContext();
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const params = args[0] || {};
    const startTime = Date.now();
    const captureContent = shouldCaptureContent();

    try {
      const result = await aiModule.generateText(...args);
      const endTime = Date.now();

      if (debug || isDebugMode()) {
        console.log("\n🔍 [Fallom Debug] generateText raw result:", JSON.stringify(result, null, 2));
      }

      const modelId =
        result?.response?.modelId ||
        params?.model?.modelId ||
        String(params?.model || "unknown");

      // SDK is dumb - just send raw data, microservice does all parsing
      const attributes: Record<string, unknown> = {
        "fallom.sdk_version": "2",
        "fallom.method": "generateText",
      };

      if (captureContent) {
        // Send raw request params (microservice extracts prompts, system, etc.)
        attributes["fallom.raw.request"] = JSON.stringify({
          prompt: params?.prompt,
          messages: params?.messages,
          system: params?.system,
          model: modelId,
        });
        
        // Send raw response (microservice extracts text, finish_reason, etc.)
        attributes["fallom.raw.response"] = JSON.stringify({
          text: result?.text,
          finishReason: result?.finishReason,
          responseId: result?.response?.id,
          modelId: result?.response?.modelId,
        });
      }

      // Always send usage data for cost calculation
      if (result?.usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(result.usage);
      }
      if (result?.experimental_providerMetadata) {
        attributes["fallom.raw.providerMetadata"] = JSON.stringify(result.experimental_providerMetadata);
      }

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: "generateText",
        kind: "llm",
        model: modelId,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "OK",
        attributes,
      }).catch(() => {});

      return result;
    } catch (error: any) {
      const endTime = Date.now();
      const modelId = params?.model?.modelId || String(params?.model || "unknown");

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: "generateText",
        kind: "llm",
        model: modelId,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "ERROR",
        error_message: error?.message,
        attributes: {
          "fallom.sdk_version": "2",
          "fallom.method": "generateText",
          "fallom.raw.request": JSON.stringify({
            prompt: params?.prompt,
            messages: params?.messages,
            system: params?.system,
            model: modelId,
          }),
        },
      }).catch(() => {});

      throw error;
    }
  };
}
