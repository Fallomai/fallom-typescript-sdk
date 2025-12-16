/**
 * Google AI (Gemini) client wrapper for automatic tracing.
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
 * Wrap a Google Generative AI client to automatically trace all content generations.
 * Requires a session context (use via FallomSession).
 */
export function wrapGoogleAI<
  T extends { generateContent: (...args: any[]) => Promise<any> }
>(model: T, sessionCtx: SessionContext): T {
  const originalGenerate = model.generateContent.bind(model);
  const ctx = sessionCtx;

  model.generateContent = async function (...args: any[]) {
    if (!isInitialized()) {
      return originalGenerate(...args);
    }

    const traceCtx =
      getTraceContextStorage().getStore() || getFallbackTraceContext();
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const startTime = Date.now();
    const captureContent = shouldCaptureContent();

    try {
      const response = await originalGenerate(...args);
      const endTime = Date.now();

      const result = response?.response;
      const usage = result?.usageMetadata;
      const modelName = (model as any)?.model || "gemini";

      const attributes: Record<string, unknown> = {};
      if (captureContent) {
        attributes["gen_ai.request.model"] = modelName;
        attributes["gen_ai.response.model"] = modelName;

        const input = args[0];
        if (typeof input === "string") {
          attributes["gen_ai.prompt.0.role"] = "user";
          attributes["gen_ai.prompt.0.content"] = input;
        } else if (input?.contents) {
          input.contents.forEach((content: any, i: number) => {
            attributes[`gen_ai.prompt.${i}.role`] = content.role || "user";
            attributes[`gen_ai.prompt.${i}.content`] =
              content.parts?.[0]?.text || JSON.stringify(content.parts);
          });
        }

        const outputText = result?.text?.();
        if (outputText) {
          attributes["gen_ai.completion.0.role"] = "assistant";
          attributes["gen_ai.completion.0.content"] = outputText;
        }
      }

      if (usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(usage);
      }
      const candidate = result?.candidates?.[0];
      if (candidate?.finishReason) {
        attributes["gen_ai.response.finish_reason"] = candidate.finishReason;
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
        model: modelName,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "OK",
        prompt_tokens: usage?.promptTokenCount,
        completion_tokens: usage?.candidatesTokenCount,
        total_tokens: usage?.totalTokenCount,
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      }).catch(() => {});

      return response;
    } catch (error: any) {
      const endTime = Date.now();
      const modelName = (model as any)?.model || "gemini";

      const attributes: Record<string, unknown> = {};
      if (captureContent) {
        attributes["gen_ai.request.model"] = modelName;
        attributes["error.message"] = error?.message;
        const input = args[0];
        if (typeof input === "string") {
          attributes["gen_ai.prompt.0.role"] = "user";
          attributes["gen_ai.prompt.0.content"] = input;
        }
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
        model: modelName,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "ERROR",
        error_message: error?.message,
        attributes: captureContent ? attributes : undefined,
      }).catch(() => {});

      throw error;
    }
  } as typeof model.generateContent;

  return model;
}
