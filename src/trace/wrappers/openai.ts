/**
 * OpenAI SDK Wrapper
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
 * Wrap an OpenAI client to automatically trace all chat completions.
 */
export function wrapOpenAI<
  T extends {
    chat: { completions: { create: (...args: any[]) => Promise<any> } };
  }
>(client: T, sessionCtx: SessionContext): T {
  const originalCreate = client.chat.completions.create.bind(
    client.chat.completions
  );
  const ctx = sessionCtx;

  client.chat.completions.create = async function (...args: any[]) {
    if (!isInitialized()) {
      return originalCreate(...args);
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
      const response = await originalCreate(...args);
      const endTime = Date.now();

      // SDK is dumb - just send raw data
      const attributes: Record<string, unknown> = {
        "fallom.sdk_version": "2",
        "fallom.method": "chat.completions.create",
      };

      if (captureContent) {
        attributes["fallom.raw.request"] = JSON.stringify({
          messages: params?.messages,
          model: params?.model,
        });
        attributes["fallom.raw.response"] = JSON.stringify({
          text: response?.choices?.[0]?.message?.content,
          finishReason: response?.choices?.[0]?.finish_reason,
          responseId: response?.id,
          model: response?.model,
        });
      }

      if (response?.usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(response.usage);
      }

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: "chat.completions.create",
        kind: "llm",
        model: response?.model || params?.model,
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
        name: "chat.completions.create",
        kind: "llm",
        model: params?.model,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "ERROR",
        error_message: error?.message,
        attributes: {
          "fallom.sdk_version": "2",
          "fallom.method": "chat.completions.create",
        },
      }).catch(() => {});

      throw error;
    }
  } as typeof client.chat.completions.create;

  return client;
}
