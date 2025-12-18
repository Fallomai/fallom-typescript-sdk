/**
 * Anthropic SDK Wrapper
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
 * Wrap an Anthropic client to automatically trace all message creations.
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

      // SDK is dumb - just send raw data
      const attributes: Record<string, unknown> = {
        "fallom.sdk_version": "2",
        "fallom.method": "messages.create",
      };

      if (captureContent) {
        // Send ALL request data - microservice extracts what it needs
        attributes["fallom.raw.request"] = JSON.stringify({
          messages: params?.messages,
          system: params?.system,
          model: params?.model,
          tools: params?.tools,
          tool_choice: params?.tool_choice,
        });

        // Extract text and tool use from content blocks
        const contentBlocks = response?.content || [];
        const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
        const toolUseBlocks = contentBlocks.filter(
          (b: any) => b.type === "tool_use"
        );

        attributes["fallom.raw.response"] = JSON.stringify({
          text: textBlocks.map((b: any) => b.text).join(""),
          finishReason: response?.stop_reason,
          responseId: response?.id,
          model: response?.model,
          // Tool calls - Anthropic uses tool_use content blocks
          toolCalls: toolUseBlocks.map((b: any) => ({
            id: b.id,
            name: b.name,
            arguments: b.input,
          })),
          // Also send raw content for full fidelity
          content: contentBlocks,
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
        // Anthropic tool calls (if present)
        toolCalls: toolUseBlocks.map((b: any) => ({
          id: b.id,
          name: b.name,
          callTime: 0, // All tool calls happen at once in non-streaming
        })),
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
        name: "messages.create",
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
        name: "messages.create",
        kind: "llm",
        model: params?.model,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "ERROR",
        error_message: error?.message,
        attributes: {
          "fallom.sdk_version": "2",
          "fallom.method": "messages.create",
        },
      }).catch(() => {});

      throw error;
    }
  } as typeof client.messages.create;

  return client;
}
