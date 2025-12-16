/**
 * FallomSession - Session-scoped tracing for concurrent-safe operations.
 */

import {
  getTraceContextStorage,
  getFallbackTraceContext,
  isInitialized,
  shouldCaptureContent,
  sendTrace,
} from "./core";
import { generateHexId } from "./utils";
import type { SessionContext, SessionOptions, WrapAISDKOptions } from "./types";

// Import wrappers
import { wrapOpenAI } from "./wrappers/openai";
import { wrapAnthropic } from "./wrappers/anthropic";
import { wrapGoogleAI } from "./wrappers/google-ai";
import { wrapAISDK } from "./wrappers/vercel-ai";
import { wrapMastraAgent } from "./wrappers/mastra";

/**
 * A session-scoped Fallom instance.
 *
 * All wrappers created from this session automatically use the session context,
 * making them safe for concurrent operations without global state issues.
 *
 * @example
 * ```typescript
 * const session = fallom.session({
 *   configKey: "my-app",
 *   sessionId: "session-123",
 *   customerId: "user-456"
 * });
 *
 * // All calls use the session context
 * const { generateText } = session.wrapAISDK(ai);
 * await generateText({ model: openai("gpt-4o"), prompt: "..." });
 *
 * // Or wrap the model directly
 * const model = session.traceModel(openai("gpt-4o"));
 * await generateText({ model, prompt: "..." });
 * ```
 */
export class FallomSession {
  private ctx: SessionContext;

  constructor(options: SessionOptions) {
    this.ctx = {
      configKey: options.configKey,
      sessionId: options.sessionId,
      customerId: options.customerId,
    };
  }

  /** Get the session context. */
  getContext(): SessionContext {
    return { ...this.ctx };
  }

  /**
   * Get model assignment for this session (A/B testing).
   */
  async getModel(
    configKeyOrOptions?: string | { fallback?: string; version?: number },
    options?: { fallback?: string; version?: number }
  ): Promise<string> {
    let configKey: string;
    let opts: { fallback?: string; version?: number };

    if (typeof configKeyOrOptions === "string") {
      configKey = configKeyOrOptions;
      opts = options || {};
    } else {
      configKey = this.ctx.configKey;
      opts = configKeyOrOptions || {};
    }

    const { get } = await import("../models");
    return get(configKey, this.ctx.sessionId, opts);
  }

  /**
   * Wrap a Vercel AI SDK model to trace all calls.
   */
  traceModel<
    T extends {
      doGenerate?: (...args: any[]) => Promise<any>;
      doStream?: (...args: any[]) => Promise<any>;
    }
  >(model: T): T {
    const ctx = this.ctx;
    const tracedModel = Object.create(model);

    if (model.doGenerate) {
      const originalDoGenerate = model.doGenerate.bind(model);
      tracedModel.doGenerate = async function (...args: any[]) {
        if (!isInitialized()) return originalDoGenerate(...args);

        const traceCtx =
          getTraceContextStorage().getStore() || getFallbackTraceContext();
        const traceId = traceCtx?.traceId || generateHexId(32);
        const spanId = generateHexId(16);
        const startTime = Date.now();

        try {
          const result = await originalDoGenerate(...args);
          const endTime = Date.now();
          const modelId = (model as any).modelId || "unknown";
          const usage = result?.usage || result?.rawResponse?.usage;

          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: traceCtx?.parentSpanId,
            name: "generateText",
            kind: "llm",
            model: modelId,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(endTime).toISOString(),
            duration_ms: endTime - startTime,
            status: "OK",
            prompt_tokens: usage?.promptTokens,
            completion_tokens: usage?.completionTokens,
            total_tokens: usage?.totalTokens,
            attributes: shouldCaptureContent() && usage
              ? { "fallom.raw.usage": JSON.stringify(usage) }
              : undefined,
          }).catch(() => {});

          return result;
        } catch (error) {
          const endTime = Date.now();
          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: traceCtx?.parentSpanId,
            name: "generateText",
            kind: "llm",
            model: (model as any).modelId || "unknown",
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(endTime).toISOString(),
            duration_ms: endTime - startTime,
            status: "ERROR",
            error_message:
              error instanceof Error ? error.message : String(error),
          }).catch(() => {});
          throw error;
        }
      };
    }

    if (model.doStream) {
      const originalDoStream = model.doStream.bind(model);
      tracedModel.doStream = async function (...args: any[]) {
        if (!isInitialized()) return originalDoStream(...args);

        const traceCtx =
          getTraceContextStorage().getStore() || getFallbackTraceContext();
        const traceId = traceCtx?.traceId || generateHexId(32);
        const spanId = generateHexId(16);
        const startTime = Date.now();
        const modelId = (model as any).modelId || "unknown";

        try {
          const result = await originalDoStream(...args);

          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: traceCtx?.parentSpanId,
            name: "streamText",
            kind: "llm",
            model: modelId,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(Date.now()).toISOString(),
            duration_ms: Date.now() - startTime,
            status: "OK",
            is_streaming: true,
          }).catch(() => {});

          return result;
        } catch (error) {
          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: traceCtx?.parentSpanId,
            name: "streamText",
            kind: "llm",
            model: modelId,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(Date.now()).toISOString(),
            duration_ms: Date.now() - startTime,
            status: "ERROR",
            error_message:
              error instanceof Error ? error.message : String(error),
            is_streaming: true,
          }).catch(() => {});
          throw error;
        }
      };
    }

    return tracedModel;
  }

  /** Wrap OpenAI client. Delegates to shared wrapper. */
  wrapOpenAI<
    T extends {
      chat: { completions: { create: (...args: any[]) => Promise<any> } };
    }
  >(client: T): T {
    return wrapOpenAI(client, this.ctx);
  }

  /** Wrap Anthropic client. Delegates to shared wrapper. */
  wrapAnthropic<
    T extends { messages: { create: (...args: any[]) => Promise<any> } }
  >(client: T): T {
    return wrapAnthropic(client, this.ctx);
  }

  /** Wrap Google AI model. Delegates to shared wrapper. */
  wrapGoogleAI<T extends { generateContent: (...args: any[]) => Promise<any> }>(
    model: T
  ): T {
    return wrapGoogleAI(model, this.ctx);
  }

  /** Wrap Vercel AI SDK. Delegates to shared wrapper. */
  wrapAISDK<
    T extends {
      generateText: (...args: any[]) => Promise<any>;
      streamText: (...args: any[]) => any;
      generateObject?: (...args: any[]) => Promise<any>;
      streamObject?: (...args: any[]) => any;
    }
  >(
    ai: T,
    options?: WrapAISDKOptions
  ): {
    generateText: T["generateText"];
    streamText: T["streamText"];
    generateObject: T["generateObject"];
    streamObject: T["streamObject"];
  } {
    return wrapAISDK(ai, this.ctx, options);
  }

  /** Wrap Mastra agent. Delegates to shared wrapper. */
  wrapMastraAgent<
    T extends {
      generate: (...args: any[]) => Promise<any>;
      name?: string;
    }
  >(agent: T): T {
    return wrapMastraAgent(agent, this.ctx);
  }
}

/**
 * Create a session-scoped Fallom instance.
 */
export function session(options: SessionOptions): FallomSession {
  return new FallomSession(options);
}
