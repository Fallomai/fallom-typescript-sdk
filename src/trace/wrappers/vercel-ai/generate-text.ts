/**
 * Vercel AI SDK generateText wrapper.
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
import { extractUsageFromResult } from "./utils";

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
        console.log(
          "\n🔍 [Fallom Debug] generateText result keys:",
          Object.keys(result || {})
        );
        console.log(
          "🔍 [Fallom Debug] result.usage:",
          JSON.stringify(result?.usage, null, 2)
        );
        console.log(
          "🔍 [Fallom Debug] result.experimental_providerMetadata:",
          JSON.stringify(result?.experimental_providerMetadata, null, 2)
        );
      }

      const modelId =
        result?.response?.modelId ||
        params?.model?.modelId ||
        String(params?.model || "unknown");

      const attributes: Record<string, unknown> = {};
      if (captureContent) {
        attributes["gen_ai.request.model"] = modelId;
        attributes["gen_ai.response.model"] = modelId;
        if (params?.prompt) {
          attributes["gen_ai.prompt.0.role"] = "user";
          attributes["gen_ai.prompt.0.content"] = params.prompt;
        }
        if (params?.messages) {
          params.messages.forEach((msg: any, i: number) => {
            attributes[`gen_ai.prompt.${i}.role`] = msg.role;
            attributes[`gen_ai.prompt.${i}.content`] =
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content);
          });
        }
        if (result?.text) {
          attributes["gen_ai.completion.0.role"] = "assistant";
          attributes["gen_ai.completion.0.content"] = result.text;
        }
        if (result?.response?.id) {
          attributes["gen_ai.response.id"] = result.response.id;
        }
      }

      if (result?.usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(result.usage);
      }
      if (result?.experimental_providerMetadata) {
        attributes["fallom.raw.providerMetadata"] = JSON.stringify(
          result.experimental_providerMetadata
        );
      }
      if (result?.finishReason) {
        attributes["gen_ai.response.finish_reason"] = result.finishReason;
      }

      const usage = extractUsageFromResult(result);

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
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
        attributes: captureContent ? attributes : undefined,
      }).catch(() => {});

      return result;
    } catch (error: any) {
      const endTime = Date.now();
      const modelId =
        params?.model?.modelId || String(params?.model || "unknown");

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
      }).catch(() => {});

      throw error;
    }
  };
}
