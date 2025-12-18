/**
 * Vercel AI SDK generateText wrapper.
 *
 * SDK is "dumb" - just captures raw request/response and sends to microservice.
 * All parsing/extraction happens server-side for easier maintenance.
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
import { getPromptContext } from "../../../prompts";

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

    // Track individual tool execution timing by wrapping tool execute functions
    const toolTimings: Map<
      string,
      { name: string; startTime: number; endTime: number; duration: number }
    > = new Map();

    // Wrap tools to capture execution timing
    let wrappedParams = params;
    if (params.tools && typeof params.tools === "object") {
      const wrappedTools: Record<string, any> = {};

      for (const [toolName, tool] of Object.entries(
        params.tools as Record<string, any>
      )) {
        if (tool && typeof tool.execute === "function") {
          const originalExecute = tool.execute;
          wrappedTools[toolName] = {
            ...tool,
            execute: async (...executeArgs: any[]) => {
              const toolStartTime = Date.now();
              const toolCallId = `${toolName}-${toolStartTime}`;

              try {
                const result = await originalExecute(...executeArgs);
                const toolEndTime = Date.now();

                toolTimings.set(toolCallId, {
                  name: toolName,
                  startTime: toolStartTime - startTime, // Relative to request start
                  endTime: toolEndTime - startTime,
                  duration: toolEndTime - toolStartTime,
                });

                return result;
              } catch (error) {
                const toolEndTime = Date.now();
                toolTimings.set(toolCallId, {
                  name: toolName,
                  startTime: toolStartTime - startTime,
                  endTime: toolEndTime - startTime,
                  duration: toolEndTime - toolStartTime,
                });
                throw error;
              }
            },
          };
        } else {
          wrappedTools[toolName] = tool;
        }
      }

      wrappedParams = { ...params, tools: wrappedTools };
    }

    try {
      const result = await aiModule.generateText(wrappedParams);
      const endTime = Date.now();

      if (debug || isDebugMode()) {
        console.log(
          "\n🔍 [Fallom Debug] generateText raw result:",
          JSON.stringify(result, null, 2)
        );
      }

      const modelId =
        result?.response?.modelId ||
        params?.model?.modelId ||
        String(params?.model || "unknown");

      // SDK is dumb - just send ALL raw data, microservice does all parsing
      const attributes: Record<string, unknown> = {
        "fallom.sdk_version": "2",
        "fallom.method": "generateText",
      };

      if (captureContent) {
        // Send raw request params - include EVERYTHING
        attributes["fallom.raw.request"] = JSON.stringify({
          prompt: params?.prompt,
          messages: params?.messages,
          system: params?.system,
          model: modelId,
          tools: params?.tools ? Object.keys(params.tools) : undefined,
          maxSteps: params?.maxSteps,
        });

        // Explicitly map tool calls to ensure we capture ALL fields including args
        // (Vercel AI SDK objects may have getters that don't serialize automatically)
        const mapToolCall = (tc: any) => ({
          toolCallId: tc?.toolCallId,
          toolName: tc?.toolName,
          args: tc?.args, // The actual arguments passed to the tool!
          type: tc?.type,
        });

        const mapToolResult = (tr: any) => ({
          toolCallId: tr?.toolCallId,
          toolName: tr?.toolName,
          result: tr?.result, // The actual result from the tool!
          type: tr?.type,
        });

        attributes["fallom.raw.response"] = JSON.stringify({
          text: result?.text,
          finishReason: result?.finishReason,
          responseId: result?.response?.id,
          modelId: result?.response?.modelId,
          // Tool calls with FULL data (id, name, args)
          toolCalls: result?.toolCalls?.map(mapToolCall),
          // Tool results with FULL data (id, name, result)
          toolResults: result?.toolResults?.map(mapToolResult),
          // Multi-step agent data with FULL tool info including timestamps
          steps: result?.steps?.map((step: any) => ({
            stepType: step?.stepType,
            text: step?.text,
            finishReason: step?.finishReason,
            toolCalls: step?.toolCalls?.map(mapToolCall),
            toolResults: step?.toolResults?.map(mapToolResult),
            usage: step?.usage,
            // Step-level timing from Vercel AI SDK
            timestamp: step?.response?.timestamp,
            responseId: step?.response?.id,
          })),
          // Response messages (includes tool call/result messages)
          responseMessages: result?.responseMessages,
        });
      }

      // Always send usage data for cost calculation
      if (result?.usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(result.usage);
      }
      if (result?.experimental_providerMetadata) {
        attributes["fallom.raw.providerMetadata"] = JSON.stringify(
          result.experimental_providerMetadata
        );
      }

      // Build waterfall timing data using ACTUAL captured tool execution times
      const totalDurationMs = endTime - startTime;
      const sortedToolTimings = Array.from(toolTimings.values()).sort(
        (a, b) => a.startTime - b.startTime
      );

      const waterfallTimings: any = {
        requestStart: 0,
        responseEnd: totalDurationMs,
        totalDurationMs,
        phases: [],
        // Include actual tool timings for verification
        toolTimings: sortedToolTimings,
      };

      if (sortedToolTimings.length > 0) {
        // We have REAL measured tool timing data!
        const firstToolStart = Math.min(
          ...sortedToolTimings.map((t) => t.startTime)
        );
        const lastToolEnd = Math.max(
          ...sortedToolTimings.map((t) => t.endTime)
        );

        // Phase 1: LLM deciding on tools (0 → first tool starts)
        if (firstToolStart > 10) {
          // Only show if > 10ms
          waterfallTimings.phases.push({
            type: "llm",
            label: "LLM Call 1 (decides tools)",
            startMs: 0,
            endMs: firstToolStart,
            durationMs: firstToolStart,
            accurate: true,
          });
        }

        // Phase 2: Each tool with its ACTUAL measured timing
        sortedToolTimings.forEach((toolTiming) => {
          waterfallTimings.phases.push({
            type: "tool",
            label: `${toolTiming.name}()`,
            startMs: toolTiming.startTime,
            endMs: toolTiming.endTime,
            durationMs: toolTiming.duration,
            accurate: true, // This is REAL measured timing!
          });
        });

        // Phase 3: Final LLM response (after last tool → end)
        const finalResponseDuration = totalDurationMs - lastToolEnd;
        if (finalResponseDuration > 10) {
          // Only show if > 10ms
          waterfallTimings.phases.push({
            type: "response",
            label: "LLM Call 2 → Final Response",
            startMs: lastToolEnd,
            endMs: totalDurationMs,
            durationMs: finalResponseDuration,
            accurate: true,
          });
        }
      } else if (result?.steps && result.steps.length > 0) {
        // No tool timings captured (tools weren't wrapped) - fall back to step estimation
        const steps = result.steps;
        const stepDuration = Math.round(totalDurationMs / steps.length);

        steps.forEach((step: any, idx: number) => {
          const hasTools = step?.toolCalls && step.toolCalls.length > 0;
          const isFinalStep = step?.finishReason === "stop";
          const stepStart = idx * stepDuration;
          const stepEnd = Math.min((idx + 1) * stepDuration, totalDurationMs);

          if (hasTools) {
            waterfallTimings.phases.push({
              type: "llm",
              label: `Step ${idx + 1}: LLM + Tools`,
              startMs: stepStart,
              endMs: stepEnd,
              durationMs: stepEnd - stepStart,
              accurate: false,
              note: "Tool timing not captured - combined step",
            });
          } else if (isFinalStep) {
            waterfallTimings.phases.push({
              type: "response",
              label: `Step ${idx + 1}: Final Response`,
              startMs: stepStart,
              endMs: stepEnd,
              durationMs: stepEnd - stepStart,
              accurate: true,
            });
          }
        });
      }

      // Include raw step data
      if (result?.steps) {
        waterfallTimings.steps = result.steps.map((step: any, idx: number) => ({
          stepIndex: idx,
          stepType: step?.stepType,
          finishReason: step?.finishReason,
          timestamp: step?.response?.timestamp,
          toolCalls: step?.toolCalls?.map((tc: any) => ({
            id: tc?.toolCallId,
            name: tc?.toolName,
          })),
          usage: step?.usage,
        }));
      }

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
        name: "generateText",
        kind: "llm",
        model: modelId,
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
        attributes: {
          "fallom.sdk_version": "2",
          "fallom.method": "generateText",
          "fallom.raw.request": JSON.stringify({
            prompt: params?.prompt,
            messages: params?.messages,
            system: params?.system,
            model: modelId,
          }),
        },
      }).catch(() => {});

      throw error;
    }
  };
}
