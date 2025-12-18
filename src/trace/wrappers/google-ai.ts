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
import { getPromptContext } from "../../prompts";

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
        // Send raw request - microservice extracts what it needs
        attributes["fallom.raw.request"] = JSON.stringify(request);

        // Extract function calls from candidates
        const candidates = result?.candidates || [];
        const functionCalls: any[] = [];

        for (const candidate of candidates) {
          const parts = candidate?.content?.parts || [];
          for (const part of parts) {
            if (part.functionCall) {
              functionCalls.push({
                name: part.functionCall.name,
                arguments: part.functionCall.args,
              });
            }
          }
        }

        attributes["fallom.raw.response"] = JSON.stringify({
          text: result?.text?.(),
          candidates: result?.candidates,
          finishReason: candidates[0]?.finishReason,
          // Tool/function calls - Google uses functionCall in parts
          toolCalls: functionCalls.length > 0 ? functionCalls : undefined,
        });
      }

      if (result?.usageMetadata) {
        attributes["fallom.raw.usage"] = JSON.stringify(result.usageMetadata);
      }

      // Build waterfall timing data
      const waterfallTimings = {
        requestStart: 0,
        requestEnd: endTime - startTime,
        responseEnd: endTime - startTime,
        totalDurationMs: endTime - startTime,
        // Google AI function calls (if present)
        toolCalls: functionCalls.map((fc: any) => ({
          name: fc.name,
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
        name: "generateContent",
        kind: "llm",
        model: (model as any).model || "gemini",
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
