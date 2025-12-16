/**
 * Anthropic client wrapper for automatic tracing.
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
 * Wrap an Anthropic client to automatically trace all message creations.
 * Requires a session context (use via FallomSession).
 */
export function wrapAnthropic<
  T extends { messages: { create: (...args: any[]) => Promise<any> } }
>(client: T, sessionCtx: SessionContext): T {
  const originalCreate = client.messages.create.bind(client.messages);
  const ctx = sessionCtx;

  client.messages.create = async function (...args: any[]) {
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
            { role: "assistant", content: response?.content?.[0]?.text || "" },
            response?.model || params?.model,
            response?.id
          )
        : {};

      if (params?.system) {
        attributes["gen_ai.system_prompt"] = params.system;
      }
      if (response?.usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(response.usage);
      }
      if (response?.stop_reason) {
        attributes["gen_ai.response.finish_reason"] = response.stop_reason;
      }

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: "messages.create",
        kind: "llm",
        model: response?.model || params?.model,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "OK",
        prompt_tokens: response?.usage?.input_tokens,
        completion_tokens: response?.usage?.output_tokens,
        total_tokens:
          (response?.usage?.input_tokens || 0) +
          (response?.usage?.output_tokens || 0),
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
        if (params?.system) {
          attributes["gen_ai.system_prompt"] = params.system;
        }
      }

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: "messages.create",
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
  } as typeof client.messages.create;

  return client;
}
