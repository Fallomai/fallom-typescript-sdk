/**
 * Mastra agent wrapper for automatic tracing.
 */

import { isInitialized, sendTrace } from "../core";
import { generateHexId } from "../utils";
import type { SessionContext, TraceData } from "../types";

/**
 * Wrap a Mastra agent to automatically trace all generate() calls.
 * Requires a session context (use via FallomSession).
 */
export function wrapMastraAgent<
  T extends {
    generate: (...args: any[]) => Promise<any>;
    name?: string;
  }
>(agent: T, sessionCtx: SessionContext): T {
  const originalGenerate = agent.generate.bind(agent);
  const agentName = agent.name || "MastraAgent";
  const ctx = sessionCtx;

  agent.generate = async function (...args: any[]) {
    if (!isInitialized()) {
      return originalGenerate(...args);
    }

    const traceId = generateHexId(32);
    const spanId = generateHexId(16);
    const startTime = Date.now();
    const messages = args[0] || [];

    try {
      const result = await originalGenerate(...args);
      const endTime = Date.now();

      const model = result?.model?.modelId || "unknown";

      const toolCalls: Array<{ name: string; arguments: any; result?: any }> =
        [];
      if (result?.steps?.length) {
        for (const step of result.steps) {
          if (step.toolCalls?.length) {
            for (let i = 0; i < step.toolCalls.length; i++) {
              const tc = step.toolCalls[i];
              const tr = step.toolResults?.[i];
              toolCalls.push({
                name: tc.toolName,
                arguments: tc.args,
                result: tr?.result,
              });
            }
          }
        }
      }

      const attributes: Record<string, unknown> = {
        "gen_ai.system": "Mastra",
        "gen_ai.request.model": model,
        "gen_ai.response.model": model,
        "fallom.source": "mastra-agent",
        "llm.request.type": "chat",
      };

      if (Array.isArray(messages)) {
        messages.forEach((msg: any, i: number) => {
          attributes[`gen_ai.prompt.${i}.role`] = msg.role || "user";
          attributes[`gen_ai.prompt.${i}.content`] =
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
        });
      }

      if (result?.text) {
        attributes["gen_ai.completion.0.role"] = "assistant";
        attributes["gen_ai.completion.0.content"] = result.text;
        attributes["gen_ai.completion.0.finish_reason"] = "stop";
      }

      if (toolCalls.length > 0) {
        attributes["fallom.tool_calls"] = JSON.stringify(toolCalls);
        toolCalls.forEach((tc, i) => {
          attributes[`gen_ai.completion.0.tool_calls.${i}.name`] = tc.name;
          attributes[`gen_ai.completion.0.tool_calls.${i}.type`] = "function";
          attributes[`gen_ai.completion.0.tool_calls.${i}.arguments`] =
            JSON.stringify(tc.arguments);
        });
      }

      if (result?.usage) {
        attributes["gen_ai.usage.prompt_tokens"] = result.usage.promptTokens;
        attributes["gen_ai.usage.completion_tokens"] =
          result.usage.completionTokens;
        attributes["llm.usage.total_tokens"] = result.usage.totalTokens;
      }

      const traceData: TraceData = {
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        name: `mastra.${agentName}.generate`,
        kind: "client",
        model,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "OK",
        prompt_tokens: result?.usage?.promptTokens,
        completion_tokens: result?.usage?.completionTokens,
        total_tokens: result?.usage?.totalTokens,
        attributes,
      };

      sendTrace(traceData).catch(() => {});
      return result;
    } catch (error) {
      const endTime = Date.now();

      const traceData: TraceData = {
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        name: `mastra.${agentName}.generate`,
        kind: "client",
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "ERROR",
        error_message: error instanceof Error ? error.message : String(error),
      };

      sendTrace(traceData).catch(() => {});
      throw error;
    }
  } as any;

  return agent;
}
