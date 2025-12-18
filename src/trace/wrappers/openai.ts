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
import { getPromptContext } from "../../prompts";

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
        // Send ALL request data - microservice extracts what it needs
        attributes["fallom.raw.request"] = JSON.stringify({
          messages: params?.messages,
          model: params?.model,
          tools: params?.tools,
          tool_choice: params?.tool_choice,
          functions: params?.functions,
          function_call: params?.function_call,
        });

        // Send ALL response data including tool calls
        const choice = response?.choices?.[0];
        attributes["fallom.raw.response"] = JSON.stringify({
          text: choice?.message?.content,
          finishReason: choice?.finish_reason,
          responseId: response?.id,
          model: response?.model,
          // Tool calls - send everything!
          toolCalls: choice?.message?.tool_calls,
          functionCall: choice?.message?.function_call,
        });
      }

      if (response?.usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(response.usage);
      }

      // Build waterfall timing data
      const waterfallTimings = {
        requestStart: 0,
        requestEnd: endTime - startTime,
        responseEnd: endTime - startTime,
        totalDurationMs: endTime - startTime,
        // OpenAI tool calls (if present)
        toolCalls: response?.choices?.[0]?.message?.tool_calls?.map(
          (tc: any, idx: number) => ({
            id: tc.id,
            name: tc.function?.name,
            callTime: 0, // All tool calls happen at once in non-streaming
          })
        ),
      };
      attributes["fallom.raw.timings"] = JSON.stringify(waterfallTimings);

      // Get prompt context if set (one-shot, clears after read)
      const promptCtx = getPromptContext();

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
        // Prompt context (if prompts.get() or prompts.getAB() was called)
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
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
