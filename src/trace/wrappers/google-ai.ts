/**
 * Google AI SDK Wrapper
 * 
 * SDK is "dumb" - just captures raw request/response and sends to microservice.
 * All parsing/extraction happens server-side for easier maintenance.
 */

import {
  getTraceContextStorage,
  getFallbackTraceContext,
  isInitialized,
  shouldCaptureContent,
  sendTrace,
} from "../core";
import { generateHexId } from "../utils";
import type { SessionContext } from "../types";

/**
 * Wrap a Google AI model to automatically trace generateContent calls.
 */
export function wrapGoogleAI<
  T extends { generateContent: (...args: any[]) => Promise<any> }
>(model: T, sessionCtx: SessionContext): T {
  const originalGenerateContent = model.generateContent.bind(model);
  const ctx = sessionCtx;

  model.generateContent = async function (...args: any[]) {
    if (!isInitialized()) {
      return originalGenerateContent(...args);
    }

    const traceCtx =
      getTraceContextStorage().getStore() || getFallbackTraceContext();
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const request = args[0];
    const startTime = Date.now();
    const captureContent = shouldCaptureContent();

    try {
      const response = await originalGenerateContent(...args);
      const endTime = Date.now();

      const result = response?.response || response;

      // SDK is dumb - just send raw data
      const attributes: Record<string, unknown> = {
        "fallom.sdk_version": "2",
        "fallom.method": "generateContent",
      };

      if (captureContent) {
        attributes["fallom.raw.request"] = JSON.stringify(request);
        attributes["fallom.raw.response"] = JSON.stringify({
          text: result?.text?.(),
          candidates: result?.candidates,
        });
      }

      if (result?.usageMetadata) {
        attributes["fallom.raw.usage"] = JSON.stringify(result.usageMetadata);
      }

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: "generateContent",
        kind: "llm",
        model: (model as any).model || "gemini",
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "OK",
        attributes,
      }).catch(() => {});

      return response;
    } catch (error: any) {
      const endTime = Date.now();

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: "generateContent",
        kind: "llm",
        model: (model as any).model || "gemini",
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "ERROR",
        error_message: error?.message,
        attributes: {
          "fallom.sdk_version": "2",
          "fallom.method": "generateContent",
        },
      }).catch(() => {});

      throw error;
    }
  } as typeof model.generateContent;

  return model;
}
