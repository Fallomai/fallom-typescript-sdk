/**
 * Mastra Agent Wrapper
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
 * Wrap a Mastra agent to automatically trace all generate calls.
 */
export function wrapMastraAgent<
  T extends {
    generate: (...args: any[]) => Promise<any>;
    name?: string;
  }
>(agent: T, sessionCtx: SessionContext): T {
  const originalGenerate = agent.generate.bind(agent);
  const ctx = sessionCtx;

  agent.generate = async function (...args: any[]) {
    if (!isInitialized()) {
      return originalGenerate(...args);
    }

    const traceCtx =
      getTraceContextStorage().getStore() || getFallbackTraceContext();
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const input = args[0];
    const startTime = Date.now();
    const captureContent = shouldCaptureContent();

    try {
      const result = await originalGenerate(...args);
      const endTime = Date.now();

      // SDK is dumb - just send raw data
      const attributes: Record<string, unknown> = {
        "fallom.sdk_version": "2",
        "fallom.method": "agent.generate",
        "fallom.agent_name": agent.name || "unknown",
      };

      if (captureContent) {
        attributes["fallom.raw.request"] = JSON.stringify(input);
        attributes["fallom.raw.response"] = JSON.stringify(result);
      }

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: `agent.${agent.name || "unknown"}.generate`,
        kind: "agent",
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "OK",
        attributes,
      }).catch(() => {});

      return result;
    } catch (error: any) {
      const endTime = Date.now();

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: `agent.${agent.name || "unknown"}.generate`,
        kind: "agent",
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "ERROR",
        error_message: error?.message,
        attributes: {
          "fallom.sdk_version": "2",
          "fallom.method": "agent.generate",
          "fallom.agent_name": agent.name || "unknown",
        },
      }).catch(() => {});

      throw error;
    }
  } as typeof agent.generate;

  return agent;
}
