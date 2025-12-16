/**
 * OpenAI client wrapper for automatic tracing.
 */

import {
  getTraceContextStorage,
  getFallbackTraceContext,
  isInitialized,
  shouldCaptureContent,
  sendTrace,
} from "../core";
import { generateHexId, messagesToOtelAttributes } from "../utils";
import type { SessionContext } from "../types";

/**
 * Wrap an OpenAI client to automatically trace all chat completions.
 * Requires a session context (use via FallomSession).
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

      const attributes: Record<string, unknown> = captureContent
        ? messagesToOtelAttributes(
            params?.messages,
            response?.choices?.[0]?.message,
            response?.model || params?.model,
            response?.id
          )
        : {};

      if (response?.usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(response.usage);
      }
      if (response?.choices?.[0]?.finish_reason) {
        attributes["gen_ai.response.finish_reason"] =
          response.choices[0].finish_reason;
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
        prompt_tokens: response?.usage?.prompt_tokens,
        completion_tokens: response?.usage?.completion_tokens,
        total_tokens: response?.usage?.total_tokens,
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      }).catch(() => {});

      return response;
    } catch (error: any) {
      const endTime = Date.now();

      const attributes = captureContent
        ? messagesToOtelAttributes(
            params?.messages,
            undefined,
            params?.model,
            undefined
          )
        : undefined;
      if (attributes) {
        attributes["error.message"] = error?.message;
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
        model: params?.model,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "ERROR",
        error_message: error?.message,
        attributes,
      }).catch(() => {});

      throw error;
    }
  } as typeof client.chat.completions.create;

  return client;
}
