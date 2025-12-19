/**
 * Vercel AI SDK streamText wrapper.
 * 
 * SDK is "dumb" - just captures raw request/response and sends to microservice.
 * All parsing/extraction happens server-side for easier maintenance.
 *
 * IMPORTANT: You must await this function, e.g.:
 *   const { textStream, fullStream } = await streamText({...})
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

function log(...args: unknown[]): void {
  if (isDebugMode()) console.log("[Fallom]", ...args);
}

export function createStreamTextWrapper(
  aiModule: any,
  sessionCtx: SessionContext,
  debug = false
) {
  const ctx = sessionCtx;

  return async (...args: any[]) => {
    const params = args[0] || {};
    const startTime = Date.now();
    const captureContent = shouldCaptureContent();

    // Track individual tool execution timing by wrapping tool execute functions
    const toolTimings: Map<string, { name: string; startTime: number; endTime: number; duration: number }> = new Map();
    
    // Wrap tools to capture execution timing
    let wrappedParams = params;
    if (params.tools && typeof params.tools === "object") {
      const wrappedTools: Record<string, any> = {};
      
      for (const [toolName, tool] of Object.entries(params.tools as Record<string, any>)) {
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
                  startTime: toolStartTime - startTime,
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

    const result = await aiModule.streamText(wrappedParams);

    if (!isInitialized()) {
      return result;
    }

    const traceCtx =
      getTraceContextStorage().getStore() || getFallbackTraceContext();
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    let firstTokenTime: number | null = null;
    const modelId =
      params?.model?.modelId || String(params?.model || "unknown");

    // Hook into multiple promises to capture ALL response data including tool calls
    if (result?.usage) {
      Promise.all([
        result.usage.catch(() => null),
        result.text?.catch(() => null),
        result.finishReason?.catch(() => null),
        result.toolCalls?.catch(() => null),
        result.toolResults?.catch(() => null),
        result.steps?.catch(() => null),
        result.responseMessages?.catch(() => null),
      ])
        .then(
          async ([
            rawUsage,
            responseText,
            finishReason,
            toolCalls,
            toolResults,
            steps,
            responseMessages,
          ]) => {
          const endTime = Date.now();

          if (debug || isDebugMode()) {
              console.log(
                "\n🔍 [Fallom Debug] streamText raw usage:",
                JSON.stringify(rawUsage, null, 2)
              );
              console.log(
                "🔍 [Fallom Debug] streamText response text:",
                responseText?.slice(0, 100)
              );
              console.log(
                "🔍 [Fallom Debug] streamText finish reason:",
                finishReason
              );
              console.log(
                "🔍 [Fallom Debug] streamText toolCalls:",
                JSON.stringify(toolCalls, null, 2)
              );
              console.log(
                "🔍 [Fallom Debug] streamText steps count:",
                steps?.length
              );
          }

          let providerMetadata = result?.experimental_providerMetadata;
            if (
              providerMetadata &&
              typeof providerMetadata.then === "function"
            ) {
            try {
              providerMetadata = await providerMetadata;
            } catch {
              providerMetadata = undefined;
            }
          }

            // SDK is dumb - just send ALL raw data, microservice does all parsing
          const attributes: Record<string, unknown> = {
            "fallom.sdk_version": "2",
            "fallom.method": "streamText",
            "fallom.is_streaming": true,
          };

          if (captureContent) {
              // Explicitly map tool calls to ensure we capture ALL fields including args
              // AI SDK v5 renamed: args → input, result → output
              const mapToolCall = (tc: any) => ({
                toolCallId: tc?.toolCallId,
                toolName: tc?.toolName,
                args: tc?.args ?? tc?.input, // v4: args, v5: input
                type: tc?.type,
              });

              const mapToolResult = (tr: any) => ({
                toolCallId: tr?.toolCallId,
                toolName: tr?.toolName,
                result: tr?.result ?? tr?.output, // v4: result, v5: output
                type: tr?.type,
              });

              // Send raw request params
            attributes["fallom.raw.request"] = JSON.stringify({
              prompt: params?.prompt,
              messages: params?.messages,
              system: params?.system,
              model: modelId,
                tools: params?.tools ? Object.keys(params.tools) : undefined,
                maxSteps: params?.maxSteps,
            });
            
              // Send raw response with explicitly mapped tool data
              attributes["fallom.raw.response"] = JSON.stringify({
                text: responseText,
                finishReason: finishReason,
                // Tool calls with FULL data (id, name, args)
                toolCalls: toolCalls?.map(mapToolCall),
                // Tool results with FULL data (id, name, result)
                toolResults: toolResults?.map(mapToolResult),
                // Multi-step agent data with FULL tool info including timestamps
                steps: steps?.map((step: any) => ({
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
                responseMessages: responseMessages,
              });
          }

          if (rawUsage) {
            attributes["fallom.raw.usage"] = JSON.stringify(rawUsage);
          }
          if (providerMetadata) {
            attributes["fallom.raw.providerMetadata"] =
              JSON.stringify(providerMetadata);
          }
          if (firstTokenTime) {
            attributes["fallom.time_to_first_token_ms"] =
              firstTokenTime - startTime;
          }

          // Build waterfall timing data using ACTUAL captured tool execution times
          const totalDurationMs = endTime - startTime;
          const sortedToolTimings = Array.from(toolTimings.values()).sort(
            (a, b) => a.startTime - b.startTime
          );
          
          const waterfallTimings: any = {
            requestStart: 0,
            firstTokenTime: firstTokenTime ? firstTokenTime - startTime : undefined,
            responseEnd: totalDurationMs,
            totalDurationMs,
            isStreaming: true,
            phases: [],
            toolTimings: sortedToolTimings,
          };

          // Add TTFT as a phase
          if (firstTokenTime) {
            waterfallTimings.phases.push({
              type: "ttft",
              label: "Time to First Token",
              startMs: 0,
              endMs: firstTokenTime - startTime,
              durationMs: firstTokenTime - startTime,
              accurate: true,
            });
          }

          if (sortedToolTimings.length > 0) {
            // We have REAL measured tool timing data!
            const firstToolStart = Math.min(...sortedToolTimings.map(t => t.startTime));
            const lastToolEnd = Math.max(...sortedToolTimings.map(t => t.endTime));

            // Phase 1: LLM deciding on tools
            if (firstToolStart > 10) {
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
                accurate: true,
              });
            });

            // Phase 3: Final LLM response
            const finalResponseDuration = totalDurationMs - lastToolEnd;
            if (finalResponseDuration > 10) {
              waterfallTimings.phases.push({
                type: "response",
                label: "LLM Call 2 → Final Response",
                startMs: lastToolEnd,
                endMs: totalDurationMs,
                durationMs: finalResponseDuration,
                accurate: true,
              });
            }
          }

          // Include raw step data
          if (steps) {
            waterfallTimings.steps = steps.map((step: any, idx: number) => ({
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
            metadata: ctx.metadata,
            tags: ctx.tags,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: parentSpanId,
            name: "streamText",
            kind: "llm",
            model: modelId,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(endTime).toISOString(),
            duration_ms: endTime - startTime,
            status: "OK",
              time_to_first_token_ms: firstTokenTime
                ? firstTokenTime - startTime
                : undefined,
            is_streaming: true,
            attributes,
              // Prompt context (if prompts.get() or prompts.getAB() was called)
              prompt_key: promptCtx?.promptKey,
              prompt_version: promptCtx?.promptVersion,
              prompt_ab_test_key: promptCtx?.abTestKey,
              prompt_variant_index: promptCtx?.variantIndex,
          }).catch(() => {});
          }
        )
        .catch((error: any) => {
          const endTime = Date.now();
          log("❌ streamText error:", error?.message);

          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            metadata: ctx.metadata,
            tags: ctx.tags,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: parentSpanId,
            name: "streamText",
            kind: "llm",
            model: modelId,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(endTime).toISOString(),
            duration_ms: endTime - startTime,
            status: "ERROR",
            error_message: error?.message,
            attributes: {
              "fallom.sdk_version": "2",
              "fallom.method": "streamText",
              "fallom.is_streaming": true,
            },
          }).catch(() => {});
        });
    }

    // Wrap textStream to capture first token time
    if (result?.textStream) {
      const originalTextStream = result.textStream;
      const wrappedTextStream = (async function* () {
        for await (const chunk of originalTextStream) {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            log("⏱️ Time to first token:", firstTokenTime - startTime, "ms");
          }
          yield chunk;
        }
      })();

      return new Proxy(result, {
        get(target, prop) {
          if (prop === "textStream") {
            return wrappedTextStream;
          }
          return (target as any)[prop];
        },
      });
    }

    return result;
  };
}
