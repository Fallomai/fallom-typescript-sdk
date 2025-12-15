/**
 * Fallom tracing module.
 *
 * Auto-instruments all LLM calls via OTEL and groups them by session.
 * Also supports custom spans for business metrics.
 */

import { AsyncLocalStorage } from "async_hooks";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { Context } from "@opentelemetry/api";

// Session context using AsyncLocalStorage (Node.js equivalent of Python's contextvars)
interface SessionContext {
  configKey: string;
  sessionId: string;
  customerId?: string;
}

const sessionStorage = new AsyncLocalStorage<SessionContext>();

// Module-level fallback for simple cases (when not using runWithSession)
// This mimics Python's contextvars behavior for simpler use cases
let fallbackSession: SessionContext | null = null;

// Module state
let apiKey: string | null = null;
let baseUrl: string = "https://traces.fallom.com";
let initialized = false;
let captureContent = true;
let debugMode = false;
let sdk: NodeSDK | null = null;

function log(...args: unknown[]): void {
  if (debugMode) console.log("[Fallom]", ...args);
}

/**
 * Custom SpanProcessor that injects fallom session context into every span.
 * This ensures all auto-instrumented LLM calls get our config_key and session_id.
 */
const fallomSpanProcessor = {
  onStart(
    span: { setAttribute: (key: string, value: string) => void; name?: string },
    _parentContext: Context
  ): void {
    log("📍 Span started:", (span as any).name || "unknown");
    const ctx = sessionStorage.getStore() || fallbackSession;
    if (ctx) {
      span.setAttribute("fallom.config_key", ctx.configKey);
      span.setAttribute("fallom.session_id", ctx.sessionId);
      if (ctx.customerId) {
        span.setAttribute("fallom.customer_id", ctx.customerId);
      }
      log(
        "   Added session context:",
        ctx.configKey,
        ctx.sessionId,
        ctx.customerId
      );
    } else {
      log("   No session context available");
    }
  },

  onEnd(span: ReadableSpan): void {
    log("✅ Span ended:", span.name, "duration:", span.duration);
  },

  shutdown(): Promise<void> {
    return Promise.resolve();
  },

  forceFlush(): Promise<void> {
    return Promise.resolve();
  },
};

/**
 * Initialize Fallom tracing. Auto-instruments all LLM calls.
 *
 * @param options - Configuration options
 * @param options.apiKey - Your Fallom API key. Defaults to FALLOM_API_KEY env var.
 * @param options.baseUrl - API base URL. Defaults to FALLOM_BASE_URL env var, or https://spans.fallom.com
 * @param options.captureContent - Whether to capture prompt/completion content in traces.
 *                                 Set to false for privacy/compliance. Defaults to true.
 *                                 Also respects FALLOM_CAPTURE_CONTENT env var ("true"/"false").
 *
 * @example
 * ```typescript
 * import fallom from 'fallom';
 *
 * // Normal usage (captures everything)
 * fallom.trace.init();
 *
 * // Privacy mode (no prompts/completions stored)
 * fallom.trace.init({ captureContent: false });
 *
 * fallom.trace.setSession("my-agent", sessionId);
 * await agent.run(message); // Automatically traced
 * ```
 */
export async function init(
  options: {
    apiKey?: string;
    baseUrl?: string;
    captureContent?: boolean;
    debug?: boolean;
  } = {}
): Promise<void> {
  if (initialized) return;

  debugMode = options.debug ?? false;

  log("🚀 Initializing Fallom tracing...");

  apiKey = options.apiKey || process.env.FALLOM_API_KEY || null;
  baseUrl =
    options.baseUrl ||
    process.env.FALLOM_TRACES_URL ||
    process.env.FALLOM_BASE_URL ||
    "https://traces.fallom.com";

  // Check env var for captureContent (explicit param takes precedence)
  const envCapture = process.env.FALLOM_CAPTURE_CONTENT?.toLowerCase();
  if (envCapture === "false" || envCapture === "0" || envCapture === "no") {
    captureContent = false;
  } else {
    captureContent = options.captureContent ?? true;
  }

  if (!apiKey) {
    throw new Error(
      "No API key provided. Set FALLOM_API_KEY environment variable or pass apiKey parameter."
    );
  }

  initialized = true;

  log("📡 Exporter URL:", `${baseUrl}/v1/traces`);

  // Set up OTEL exporter
  const exporter = new OTLPTraceExporter({
    url: `${baseUrl}/v1/traces`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  // Get instrumentations (async because of dynamic import for ESM compatibility)
  const instrumentations = await getInstrumentations();
  log("🔧 Loaded instrumentations:", instrumentations.length);

  // Initialize the SDK with instrumentations
  sdk = new NodeSDK({
    resource: new Resource({
      "service.name": "fallom-traced-app",
    }),
    traceExporter: exporter,
    spanProcessor: fallomSpanProcessor,
    instrumentations,
  });

  sdk.start();
  log("✅ SDK started");

  // Graceful shutdown
  process.on("SIGTERM", () => {
    sdk?.shutdown().catch(console.error);
  });
}

/**
 * Get instrumentations for supported LLM libraries.
 * Each instrumentation is optional - only loads if the package is installed.
 * Uses dynamic import() for ESM compatibility.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getInstrumentations(): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instrumentations: any[] = [];

  // OpenAI (also covers OpenRouter, LiteLLM, Azure OpenAI via OpenAI SDK)
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-openai",
    "OpenAIInstrumentation"
  );

  // Anthropic
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-anthropic",
    "AnthropicInstrumentation"
  );

  // Cohere
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-cohere",
    "CohereInstrumentation"
  );

  // AWS Bedrock
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-bedrock",
    "BedrockInstrumentation"
  );

  // Google AI (Gemini)
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-google-generativeai",
    "GoogleGenerativeAIInstrumentation"
  );

  // Azure OpenAI
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-azure",
    "AzureOpenAIInstrumentation"
  );

  // Vertex AI
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-vertexai",
    "VertexAIInstrumentation"
  );

  return instrumentations;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryAddInstrumentation(
  instrumentations: any[],
  pkg: string,
  className: string
): Promise<void> {
  try {
    const mod = await import(pkg);
    const InstrumentationClass = mod[className] || mod.default?.[className];
    if (InstrumentationClass) {
      instrumentations.push(
        new InstrumentationClass({ traceContent: captureContent })
      );
      log(`   ✅ Loaded ${pkg}`);
    } else {
      log(
        `   ⚠️ ${pkg} loaded but ${className} not found. Available:`,
        Object.keys(mod)
      );
    }
  } catch (e: any) {
    log(`   ❌ ${pkg} not installed`);
  }
}

/**
 * Set the current session context.
 *
 * All subsequent LLM calls in this async context will be
 * automatically tagged with this configKey, sessionId, and customerId.
 *
 * @param configKey - Your config name (e.g., "linkedin-agent")
 * @param sessionId - Your session/conversation ID
 * @param customerId - Optional customer/user identifier for analytics
 *
 * @example
 * ```typescript
 * trace.setSession("linkedin-agent", sessionId, "user_123");
 * await agent.run(message); // Automatically traced with session + customer
 * ```
 */
export function setSession(
  configKey: string,
  sessionId: string,
  customerId?: string
): void {
  // Try to update AsyncLocalStorage if we're inside runWithSession
  const store = sessionStorage.getStore();
  if (store) {
    store.configKey = configKey;
    store.sessionId = sessionId;
    store.customerId = customerId;
  }

  // Also set module-level fallback (mimics Python's contextvars behavior)
  // This ensures setSession works even without runWithSession for simple cases
  fallbackSession = { configKey, sessionId, customerId };
}

/**
 * Run a function with session context.
 * Use this to ensure session context propagates across async boundaries.
 *
 * @param configKey - Your config name
 * @param sessionId - Your session ID
 * @param customerId - Optional customer/user identifier
 * @param fn - Function to run with session context
 *
 * @example
 * ```typescript
 * await trace.runWithSession("my-agent", sessionId, "user_123", async () => {
 *   await agent.run(message); // Has session context
 * });
 * ```
 */
export function runWithSession<T>(
  configKey: string,
  sessionId: string,
  customerIdOrFn: string | (() => T),
  fn?: () => T
): T {
  // Support both (configKey, sessionId, fn) and (configKey, sessionId, customerId, fn)
  if (typeof customerIdOrFn === "function") {
    return sessionStorage.run({ configKey, sessionId }, customerIdOrFn);
  }
  return sessionStorage.run(
    { configKey, sessionId, customerId: customerIdOrFn },
    fn!
  );
}

/**
 * Get current session context, if any.
 */
export function getSession(): SessionContext | undefined {
  return sessionStorage.getStore() || fallbackSession || undefined;
}

/**
 * Clear session context.
 */
export function clearSession(): void {
  // Clear the module-level fallback
  fallbackSession = null;
  // Note: Can't clear AsyncLocalStorage store, it's scoped to runWithSession
}

/**
 * Record custom business metrics. Latest value per field wins.
 *
 * Use this for metrics that OTEL can't capture automatically:
 * - Outlier scores
 * - Engagement metrics
 * - Conversion rates
 * - Any business-specific outcome
 *
 * @param data - Dict of metrics to record
 * @param options - Optional session identifiers
 * @param options.configKey - Config name (optional if setSession was called)
 * @param options.sessionId - Session ID (optional if setSession was called)
 *
 * @example
 * ```typescript
 * // If session context is set:
 * trace.span({ outlier_score: 0.8, engagement: 42 });
 *
 * // Or explicitly:
 * trace.span(
 *   { outlier_score: 0.8 },
 *   { configKey: "linkedin-agent", sessionId: "user123-convo456" }
 * );
 * ```
 */
export function span(
  data: Record<string, unknown>,
  options: {
    configKey?: string;
    sessionId?: string;
  } = {}
): void {
  if (!initialized) {
    throw new Error("Fallom not initialized. Call trace.init() first.");
  }

  // Use context if configKey/sessionId not provided
  const ctx = sessionStorage.getStore() || fallbackSession;
  const configKey = options.configKey || ctx?.configKey;
  const sessionId = options.sessionId || ctx?.sessionId;

  if (!configKey || !sessionId) {
    throw new Error(
      "No session context. Either call setSession() first, or pass configKey and sessionId explicitly."
    );
  }

  // Send async (fire and forget)
  sendSpan(configKey, sessionId, data).catch(() => {});
}

async function sendSpan(
  configKey: string,
  sessionId: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    await fetch(`${baseUrl}/spans`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config_key: configKey,
        session_id: sessionId,
        data,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
  } catch {
    // Fail silently, don't crash user's code
  }
}

/**
 * Shutdown the tracing SDK gracefully.
 */
export async function shutdown(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    initialized = false;
  }
}

// ============================================================================
// LLM Client Wrappers - Works everywhere (ESM, CJS, Bun, Deno)
// ============================================================================

interface TraceData {
  config_key: string;
  session_id: string;
  customer_id?: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  kind?: string;
  model?: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  status: "OK" | "ERROR";
  error_message?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  time_to_first_token_ms?: number;
  is_streaming?: boolean;
  // OTEL-format attributes (matches Python SDK)
  attributes?: Record<string, unknown>;
  // Prompt context fields
  prompt_key?: string;
  prompt_version?: number;
  prompt_ab_test_key?: string;
  prompt_variant_index?: number;
}

/**
 * Convert OpenAI-style messages to OTEL GenAI semantic convention attributes.
 * This ensures TypeScript SDK traces match Python SDK format.
 */
function messagesToOtelAttributes(
  messages:
    | Array<{
        role: string;
        content: string | unknown[];
        tool_calls?: unknown[];
      }>
    | undefined,
  completion:
    | {
        role: string;
        content: string | unknown[] | null;
        tool_calls?: unknown[];
      }
    | undefined,
  model: string | undefined,
  responseId: string | undefined
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};

  // Request model
  if (model) {
    attrs["gen_ai.request.model"] = model;
    attrs["gen_ai.response.model"] = model;
  }

  // Response ID
  if (responseId) {
    attrs["gen_ai.response.id"] = responseId;
  }

  // Prompts (input messages)
  if (messages) {
    messages.forEach((msg, i) => {
      attrs[`gen_ai.prompt.${i}.role`] = msg.role;
      // Handle multimodal content (arrays) by JSON.stringify-ing
      attrs[`gen_ai.prompt.${i}.content`] =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
    });
  }

  // Completion (output)
  if (completion) {
    attrs["gen_ai.completion.0.role"] = completion.role;
    // Handle multimodal content in completions
    attrs["gen_ai.completion.0.content"] =
      typeof completion.content === "string"
        ? completion.content
        : JSON.stringify(completion.content);
    if (completion.tool_calls) {
      attrs["gen_ai.completion.0.tool_calls"] = JSON.stringify(
        completion.tool_calls
      );
    }
  }

  return attrs;
}

/**
 * Generate a random hex string of specified length.
 * Used for trace_id (32 chars) and span_id (16 chars).
 */
function generateHexId(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Current trace context for linking spans
interface TraceContext {
  traceId: string;
  parentSpanId?: string;
}

const traceContextStorage = new AsyncLocalStorage<TraceContext>();
let fallbackTraceContext: TraceContext | null = null;

async function sendTrace(trace: TraceData): Promise<void> {
  const url = `${baseUrl}/v1/traces`;
  log("📤 Sending trace to:", url);
  log("   Session:", trace.session_id, "Config:", trace.config_key);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(trace),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      log("❌ Trace send failed:", response.status, text);
    } else {
      log("✅ Trace sent:", trace.name, trace.model);
    }
  } catch (err) {
    log("❌ Trace send error:", err instanceof Error ? err.message : err);
  }
}

/**
 * Wrap an OpenAI client to automatically trace all chat completions.
 * Works with OpenAI, OpenRouter, Azure OpenAI, LiteLLM, and any OpenAI-compatible API.
 *
 * @param client - The OpenAI client instance
 * @returns The same client with tracing enabled
 *
 * @example
 * ```typescript
 * import OpenAI from "openai";
 * import { trace } from "@fallom/trace";
 *
 * const openai = trace.wrapOpenAI(new OpenAI());
 *
 * trace.setSession("my-config", sessionId);
 * const response = await openai.chat.completions.create({...}); // Automatically traced!
 * ```
 */
export function wrapOpenAI<
  T extends {
    chat: { completions: { create: (...args: any[]) => Promise<any> } };
  }
>(client: T): T {
  const originalCreate = client.chat.completions.create.bind(
    client.chat.completions
  );

  client.chat.completions.create = async function (...args: any[]) {
    const ctx = sessionStorage.getStore() || fallbackSession;
    if (!ctx || !initialized) {
      return originalCreate(...args);
    }

    // Get prompt context (one-shot - clears after read)
    let promptCtx: {
      promptKey: string;
      promptVersion: number;
      abTestKey?: string;
      variantIndex?: number;
    } | null = null;
    try {
      const { getPromptContext } = await import("./prompts");
      promptCtx = getPromptContext();
    } catch {
      // prompts module not available
    }

    // Generate trace context (reuse existing trace_id if in a trace, or create new)
    const traceCtx = traceContextStorage.getStore() || fallbackTraceContext;
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const params = args[0] || {};
    const startTime = Date.now();

    try {
      const response = await originalCreate(...args);
      const endTime = Date.now();

      // Build OTEL-format attributes (matches Python SDK)
      const attributes: Record<string, unknown> = captureContent
        ? messagesToOtelAttributes(
            params?.messages,
            response?.choices?.[0]?.message,
            response?.model || params?.model,
            response?.id
          )
        : {};

      // Send raw usage data so microservice can extract/debug without SDK updates
      if (response?.usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(response.usage);
      }
      if (response?.choices?.[0]?.finish_reason) {
        attributes["gen_ai.response.finish_reason"] =
          response.choices[0].finish_reason;
      }

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
        prompt_tokens: response?.usage?.prompt_tokens,
        completion_tokens: response?.usage?.completion_tokens,
        total_tokens: response?.usage?.total_tokens,
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
      }).catch(() => {});

      return response;
    } catch (error: any) {
      const endTime = Date.now();

      // For errors, still capture the input messages
      const attributes = captureContent
        ? messagesToOtelAttributes(
            params?.messages,
            undefined,
            params?.model,
            undefined
          )
        : undefined;
      if (attributes) {
        attributes["error.message"] = error?.message;
      }

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
        attributes,
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
      }).catch(() => {});

      throw error;
    }
  } as typeof client.chat.completions.create;

  return client;
}

/**
 * Wrap an Anthropic client to automatically trace all message creations.
 *
 * @param client - The Anthropic client instance
 * @returns The same client with tracing enabled
 *
 * @example
 * ```typescript
 * import Anthropic from "@anthropic-ai/sdk";
 * import { trace } from "@fallom/trace";
 *
 * const anthropic = trace.wrapAnthropic(new Anthropic());
 *
 * trace.setSession("my-config", sessionId);
 * const response = await anthropic.messages.create({...}); // Automatically traced!
 * ```
 */
export function wrapAnthropic<
  T extends { messages: { create: (...args: any[]) => Promise<any> } }
>(client: T): T {
  const originalCreate = client.messages.create.bind(client.messages);

  client.messages.create = async function (...args: any[]) {
    const ctx = sessionStorage.getStore() || fallbackSession;
    if (!ctx || !initialized) {
      return originalCreate(...args);
    }

    // Get prompt context (one-shot)
    let promptCtx: {
      promptKey: string;
      promptVersion: number;
      abTestKey?: string;
      variantIndex?: number;
    } | null = null;
    try {
      const { getPromptContext } = await import("./prompts");
      promptCtx = getPromptContext();
    } catch {
      // prompts module not available
    }

    // Generate trace context
    const traceCtx = traceContextStorage.getStore() || fallbackTraceContext;
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const params = args[0] || {};
    const startTime = Date.now();

    try {
      const response = await originalCreate(...args);
      const endTime = Date.now();

      // Build OTEL-format attributes for Anthropic
      const attributes: Record<string, unknown> = captureContent
        ? messagesToOtelAttributes(
            params?.messages,
            { role: "assistant", content: response?.content?.[0]?.text || "" },
            response?.model || params?.model,
            response?.id
          )
        : {};
      // Add system prompt if present (Anthropic-specific)
      if (params?.system) {
        attributes["gen_ai.system_prompt"] = params.system;
      }

      // Send raw usage data so microservice can extract/debug without SDK updates
      if (response?.usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(response.usage);
      }
      if (response?.stop_reason) {
        attributes["gen_ai.response.finish_reason"] = response.stop_reason;
      }

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
        prompt_tokens: response?.usage?.input_tokens,
        completion_tokens: response?.usage?.output_tokens,
        total_tokens:
          (response?.usage?.input_tokens || 0) +
          (response?.usage?.output_tokens || 0),
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
      }).catch(() => {});

      return response;
    } catch (error: any) {
      const endTime = Date.now();

      const attributes = captureContent
        ? messagesToOtelAttributes(
            params?.messages,
            undefined,
            params?.model,
            undefined
          )
        : undefined;
      if (attributes) {
        attributes["error.message"] = error?.message;
        if (params?.system) {
          attributes["gen_ai.system_prompt"] = params.system;
        }
      }

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
        attributes,
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
      }).catch(() => {});

      throw error;
    }
  } as typeof client.messages.create;

  return client;
}

/**
 * Wrap a Google Generative AI client to automatically trace all content generations.
 *
 * @param client - The GoogleGenerativeAI client instance
 * @returns The same client with tracing enabled
 *
 * @example
 * ```typescript
 * import { GoogleGenerativeAI } from "@google/generative-ai";
 * import { trace } from "@fallom/trace";
 *
 * const genAI = new GoogleGenerativeAI(apiKey);
 * const model = trace.wrapGoogleAI(genAI.getGenerativeModel({ model: "gemini-pro" }));
 *
 * trace.setSession("my-config", sessionId);
 * const response = await model.generateContent("Hello!"); // Automatically traced!
 * ```
 */
export function wrapGoogleAI<
  T extends { generateContent: (...args: any[]) => Promise<any> }
>(model: T): T {
  const originalGenerate = model.generateContent.bind(model);

  model.generateContent = async function (...args: any[]) {
    const ctx = sessionStorage.getStore() || fallbackSession;
    if (!ctx || !initialized) {
      return originalGenerate(...args);
    }

    // Get prompt context (one-shot)
    let promptCtx: {
      promptKey: string;
      promptVersion: number;
      abTestKey?: string;
      variantIndex?: number;
    } | null = null;
    try {
      const { getPromptContext } = await import("./prompts");
      promptCtx = getPromptContext();
    } catch {
      // prompts module not available
    }

    // Generate trace context
    const traceCtx = traceContextStorage.getStore() || fallbackTraceContext;
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const startTime = Date.now();

    try {
      const response = await originalGenerate(...args);
      const endTime = Date.now();

      const result = response?.response;
      const usage = result?.usageMetadata;
      const modelName = (model as any)?.model || "gemini";

      // Build OTEL-format attributes for Google AI
      const attributes: Record<string, unknown> = {};
      if (captureContent) {
        attributes["gen_ai.request.model"] = modelName;
        attributes["gen_ai.response.model"] = modelName;
        // Google AI input can be string or parts array
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
        // Output
        const outputText = result?.text?.();
        if (outputText) {
          attributes["gen_ai.completion.0.role"] = "assistant";
          attributes["gen_ai.completion.0.content"] = outputText;
        }
      }

      // Send raw usage data so microservice can extract/debug without SDK updates
      if (usage) {
        attributes["fallom.raw.usage"] = JSON.stringify(usage);
      }
      // Google AI finish reason
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
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
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
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
      }).catch(() => {});

      throw error;
    }
  } as typeof model.generateContent;

  return model;
}

// ============================================================================
// Vercel AI SDK Wrapper
// ============================================================================

/**
 * Wrap the Vercel AI SDK to automatically trace all LLM calls.
 * Works with generateText, streamText, generateObject, streamObject.
 *
 * @param ai - The ai module (import * as ai from "ai")
 * @returns Object with wrapped generateText, streamText, generateObject, streamObject
 *
 * @example
 * ```typescript
 * import * as ai from "ai";
 * import { createOpenAI } from "@ai-sdk/openai";
 * import { trace } from "@fallom/trace";
 *
 * await trace.init({ apiKey: process.env.FALLOM_API_KEY });
 * const { generateText, streamText } = trace.wrapAISDK(ai);
 *
 * const openrouter = createOpenAI({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   baseURL: "https://openrouter.ai/api/v1",
 * });
 *
 * trace.setSession("my-config", sessionId);
 * const { text } = await generateText({
 *   model: openrouter("openai/gpt-4o-mini"),
 *   prompt: "Hello!",
 * }); // Automatically traced!
 * ```
 */
/** Options for wrapAISDK */
interface WrapAISDKOptions {
  /**
   * Enable debug logging to see the raw Vercel AI SDK response structure.
   * Useful for debugging missing usage/token data.
   */
  debug?: boolean;
}

// Global debug flag for AI SDK wrappers
let aiSdkDebug = false;

/**
 * Extract usage data from Vercel AI SDK response.
 *
 * Different providers return usage in different locations:
 * - @ai-sdk/openai: result.usage.promptTokens (works correctly)
 * - @openrouter/ai-sdk-provider: result.usage is null, but data is in
 *   result.experimental_providerMetadata.openrouter.usage
 *
 * This helper checks all possible locations.
 */
interface ExtractedUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
}

function extractUsageFromResult(
  result: any,
  directUsage?: any
): ExtractedUsage {
  // Start with direct usage (for streaming where usage is awaited separately)
  let usage = directUsage ?? result?.usage;

  // Check if usage values are valid (not null/NaN)
  const isValidNumber = (v: any) =>
    v !== null && v !== undefined && !Number.isNaN(v);

  let promptTokens = isValidNumber(usage?.promptTokens)
    ? usage.promptTokens
    : undefined;
  let completionTokens = isValidNumber(usage?.completionTokens)
    ? usage.completionTokens
    : undefined;
  let totalTokens = isValidNumber(usage?.totalTokens)
    ? usage.totalTokens
    : undefined;
  let cost: number | undefined;

  // Fallback: Check experimental_providerMetadata.openrouter.usage
  // This is where @openrouter/ai-sdk-provider puts the real usage data
  const orUsage = result?.experimental_providerMetadata?.openrouter?.usage;
  if (orUsage) {
    if (promptTokens === undefined && isValidNumber(orUsage.promptTokens)) {
      promptTokens = orUsage.promptTokens;
    }
    if (
      completionTokens === undefined &&
      isValidNumber(orUsage.completionTokens)
    ) {
      completionTokens = orUsage.completionTokens;
    }
    if (totalTokens === undefined && isValidNumber(orUsage.totalTokens)) {
      totalTokens = orUsage.totalTokens;
    }
    if (isValidNumber(orUsage.cost)) {
      cost = orUsage.cost;
    }
  }

  // Calculate total if we have parts but not total
  if (
    totalTokens === undefined &&
    (promptTokens !== undefined || completionTokens !== undefined)
  ) {
    totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  }

  return { promptTokens, completionTokens, totalTokens, cost };
}

export function wrapAISDK<
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
  // Store reference to the module to preserve function bindings
  const aiModule = ai;

  // Set debug flag
  aiSdkDebug = options?.debug ?? false;

  return {
    generateText: createGenerateTextWrapper(aiModule),
    streamText: createStreamTextWrapper(aiModule),
    generateObject: aiModule.generateObject
      ? createGenerateObjectWrapper(aiModule)
      : undefined,
    streamObject: aiModule.streamObject
      ? createStreamObjectWrapper(aiModule)
      : undefined,
  } as any;
}

// Wrapper factory that preserves module context
function createGenerateTextWrapper(aiModule: any) {
  return async (...args: any[]) => {
    const ctx = sessionStorage.getStore() || fallbackSession;
    if (!ctx || !initialized) {
      return aiModule.generateText(...args);
    }

    // Get prompt context
    let promptCtx: {
      promptKey: string;
      promptVersion: number;
      abTestKey?: string;
      variantIndex?: number;
    } | null = null;
    try {
      const { getPromptContext } = await import("./prompts");
      promptCtx = getPromptContext();
    } catch {
      // prompts module not available
    }

    const traceCtx = traceContextStorage.getStore() || fallbackTraceContext;
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const params = args[0] || {};
    const startTime = Date.now();

    try {
      const result = await aiModule.generateText(...args);
      const endTime = Date.now();

      // Debug: log the full result structure
      if (aiSdkDebug) {
        console.log(
          "\n🔍 [Fallom Debug] generateText result keys:",
          Object.keys(result || {})
        );
        console.log(
          "🔍 [Fallom Debug] result.usage:",
          JSON.stringify(result?.usage, null, 2)
        );
        console.log(
          "🔍 [Fallom Debug] result.response keys:",
          Object.keys(result?.response || {})
        );
        console.log(
          "🔍 [Fallom Debug] result.response.usage:",
          JSON.stringify(result?.response?.usage, null, 2)
        );
        console.log(
          "🔍 [Fallom Debug] result.experimental_providerMetadata:",
          JSON.stringify(result?.experimental_providerMetadata, null, 2)
        );
      }

      // Extract model info from the result or params
      const modelId =
        result?.response?.modelId ||
        params?.model?.modelId ||
        String(params?.model || "unknown");

      // Build attributes
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

      // Send raw usage data so microservice can extract/debug without SDK updates
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

      // Extract usage from all possible locations (handles @openrouter/ai-sdk-provider)
      // Best-effort client-side extraction, microservice can override
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
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
      }).catch(() => {});

      throw error;
    }
  };
}

function createStreamTextWrapper(aiModule: any) {
  return async (...args: any[]) => {
    const ctx = sessionStorage.getStore() || fallbackSession;
    const params = args[0] || {};
    const startTime = Date.now();

    // Call the original function and await the result (Vercel AI SDK v4+ returns a Promise)
    const result = await aiModule.streamText(...args);

    if (!ctx || !initialized) {
      return result;
    }

    const traceCtx = traceContextStorage.getStore() || fallbackTraceContext;
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    let firstTokenTime: number | null = null;
    const modelId =
      params?.model?.modelId || String(params?.model || "unknown");

    let promptCtx: {
      promptKey: string;
      promptVersion: number;
      abTestKey?: string;
      variantIndex?: number;
    } | null = null;

    // Get prompt context if available
    try {
      const { getPromptContext } = await import("./prompts");
      promptCtx = getPromptContext();
    } catch {
      // prompts module not available
    }

    // Hook into the usage promise to capture when stream completes
    if (result?.usage) {
      result.usage
        .then(async (rawUsage: any) => {
          const endTime = Date.now();

          // Debug: log the usage structure
          if (aiSdkDebug) {
            console.log(
              "\n🔍 [Fallom Debug] streamText usage:",
              JSON.stringify(rawUsage, null, 2)
            );
            console.log(
              "🔍 [Fallom Debug] streamText result keys:",
              Object.keys(result || {})
            );
          }

          log("📊 streamText usage:", JSON.stringify(rawUsage, null, 2));

          // For streaming, experimental_providerMetadata might be a promise
          let providerMetadata = result?.experimental_providerMetadata;
          if (providerMetadata && typeof providerMetadata.then === "function") {
            try {
              providerMetadata = await providerMetadata;
            } catch {
              providerMetadata = undefined;
            }
          }

          // Extract usage from all possible locations
          const usage = extractUsageFromResult(
            { experimental_providerMetadata: providerMetadata },
            rawUsage
          );

          const attributes: Record<string, unknown> = {};
          if (captureContent) {
            attributes["gen_ai.request.model"] = modelId;
            if (params?.prompt) {
              attributes["gen_ai.prompt.0.role"] = "user";
              attributes["gen_ai.prompt.0.content"] = params.prompt;
            }
          }

          if (firstTokenTime) {
            attributes["gen_ai.time_to_first_token_ms"] =
              firstTokenTime - startTime;
          }

          // Send raw usage data so microservice can extract/debug without SDK updates
          if (rawUsage) {
            attributes["fallom.raw.usage"] = JSON.stringify(rawUsage);
          }
          if (providerMetadata) {
            attributes["fallom.raw.providerMetadata"] =
              JSON.stringify(providerMetadata);
          }

          const tracePayload: TraceData = {
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
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
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
            time_to_first_token_ms: firstTokenTime
              ? firstTokenTime - startTime
              : undefined,
            attributes: captureContent ? attributes : undefined,
            prompt_key: promptCtx?.promptKey,
            prompt_version: promptCtx?.promptVersion,
            prompt_ab_test_key: promptCtx?.abTestKey,
            prompt_variant_index: promptCtx?.variantIndex,
          };

          sendTrace(tracePayload).catch(() => {});
        })
        .catch((error: any) => {
          const endTime = Date.now();
          log("❌ streamText error:", error?.message);

          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
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
            prompt_key: promptCtx?.promptKey,
            prompt_version: promptCtx?.promptVersion,
            prompt_ab_test_key: promptCtx?.abTestKey,
            prompt_variant_index: promptCtx?.variantIndex,
          }).catch(() => {});
        });
    }

    // Create a wrapped textStream that captures first token time
    // We need to use a Proxy since textStream is a getter-only property
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

      // Return a proxy that intercepts textStream access
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

function createGenerateObjectWrapper(aiModule: any) {
  return async (...args: any[]) => {
    const ctx = sessionStorage.getStore() || fallbackSession;
    if (!ctx || !initialized) {
      return aiModule.generateObject(...args);
    }

    let promptCtx: {
      promptKey: string;
      promptVersion: number;
      abTestKey?: string;
      variantIndex?: number;
    } | null = null;
    try {
      const { getPromptContext } = await import("./prompts");
      promptCtx = getPromptContext();
    } catch {
      // prompts module not available
    }

    const traceCtx = traceContextStorage.getStore() || fallbackTraceContext;
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    const params = args[0] || {};
    const startTime = Date.now();

    try {
      const result = await aiModule.generateObject(...args);
      const endTime = Date.now();

      // Debug: log the full result structure
      if (aiSdkDebug) {
        console.log(
          "\n🔍 [Fallom Debug] generateObject result keys:",
          Object.keys(result || {})
        );
        console.log(
          "🔍 [Fallom Debug] result.usage:",
          JSON.stringify(result?.usage, null, 2)
        );
        console.log(
          "🔍 [Fallom Debug] result.response keys:",
          Object.keys(result?.response || {})
        );
        console.log(
          "🔍 [Fallom Debug] result.response.usage:",
          JSON.stringify(result?.response?.usage, null, 2)
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
        if (result?.object) {
          attributes["gen_ai.completion.0.role"] = "assistant";
          attributes["gen_ai.completion.0.content"] = JSON.stringify(
            result.object
          );
        }
      }

      // Send raw usage data so microservice can extract/debug without SDK updates
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

      // Extract usage from all possible locations (handles @openrouter/ai-sdk-provider)
      // Best-effort client-side extraction, microservice can override
      const usage = extractUsageFromResult(result);

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        name: "generateObject",
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
        name: "generateObject",
        kind: "llm",
        model: modelId,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "ERROR",
        error_message: error?.message,
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
      }).catch(() => {});

      throw error;
    }
  };
}

function createStreamObjectWrapper(aiModule: any) {
  return async (...args: any[]) => {
    const ctx = sessionStorage.getStore() || fallbackSession;
    const params = args[0] || {};
    const startTime = Date.now();

    // Call the original function and await the result (Vercel AI SDK v4+ returns a Promise)
    const result = await aiModule.streamObject(...args);

    log("🔍 streamObject result keys:", Object.keys(result || {}));

    if (!ctx || !initialized) {
      return result;
    }

    const traceCtx = traceContextStorage.getStore() || fallbackTraceContext;
    const traceId = traceCtx?.traceId || generateHexId(32);
    const spanId = generateHexId(16);
    const parentSpanId = traceCtx?.parentSpanId;

    let firstTokenTime: number | null = null;
    const modelId =
      params?.model?.modelId || String(params?.model || "unknown");

    let promptCtx: {
      promptKey: string;
      promptVersion: number;
      abTestKey?: string;
      variantIndex?: number;
    } | null = null;

    // Get prompt context if available
    try {
      const { getPromptContext } = await import("./prompts");
      promptCtx = getPromptContext();
    } catch {
      // prompts module not available
    }

    // Hook into usage promise for completion
    if (result?.usage) {
      result.usage
        .then(async (rawUsage: any) => {
          const endTime = Date.now();

          // Debug: log the usage structure
          if (aiSdkDebug) {
            console.log(
              "\n🔍 [Fallom Debug] streamObject usage:",
              JSON.stringify(rawUsage, null, 2)
            );
            console.log(
              "🔍 [Fallom Debug] streamObject result keys:",
              Object.keys(result || {})
            );
          }

          log("📊 streamObject usage:", JSON.stringify(rawUsage, null, 2));

          // For streaming, experimental_providerMetadata might be a promise
          let providerMetadata = result?.experimental_providerMetadata;
          if (providerMetadata && typeof providerMetadata.then === "function") {
            try {
              providerMetadata = await providerMetadata;
            } catch {
              providerMetadata = undefined;
            }
          }

          // Extract usage from all possible locations
          const usage = extractUsageFromResult(
            { experimental_providerMetadata: providerMetadata },
            rawUsage
          );

          const attributes: Record<string, unknown> = {};
          if (captureContent) {
            attributes["gen_ai.request.model"] = modelId;
          }

          if (firstTokenTime) {
            attributes["gen_ai.time_to_first_token_ms"] =
              firstTokenTime - startTime;
          }

          // Send raw usage data so microservice can extract/debug without SDK updates
          if (rawUsage) {
            attributes["fallom.raw.usage"] = JSON.stringify(rawUsage);
          }
          if (providerMetadata) {
            attributes["fallom.raw.providerMetadata"] =
              JSON.stringify(providerMetadata);
          }

          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: parentSpanId,
            name: "streamObject",
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
            prompt_key: promptCtx?.promptKey,
            prompt_version: promptCtx?.promptVersion,
            prompt_ab_test_key: promptCtx?.abTestKey,
            prompt_variant_index: promptCtx?.variantIndex,
          }).catch(() => {});
        })
        .catch((error: any) => {
          const endTime = Date.now();

          sendTrace({
            config_key: ctx.configKey,
            session_id: ctx.sessionId,
            customer_id: ctx.customerId,
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: parentSpanId,
            name: "streamObject",
            kind: "llm",
            model: modelId,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(endTime).toISOString(),
            duration_ms: endTime - startTime,
            status: "ERROR",
            error_message: error?.message,
            prompt_key: promptCtx?.promptKey,
            prompt_version: promptCtx?.promptVersion,
            prompt_ab_test_key: promptCtx?.abTestKey,
            prompt_variant_index: promptCtx?.variantIndex,
          }).catch(() => {});
        });
    }

    // Wrap the partial object stream to capture first token time
    // We need to use a Proxy since partialObjectStream is a getter-only property
    if (result?.partialObjectStream) {
      const originalStream = result.partialObjectStream;
      const wrappedStream = (async function* () {
        for await (const chunk of originalStream) {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            log("⏱️ Time to first token:", firstTokenTime - startTime, "ms");
          }
          yield chunk;
        }
      })();

      return new Proxy(result, {
        get(target, prop) {
          if (prop === "partialObjectStream") {
            return wrappedStream;
          }
          return (target as any)[prop];
        },
      });
    }

    return result;
  };
}

// ============================================================================
// Mastra Agent Wrapper
// ============================================================================

/**
 * Wrap a Mastra agent to automatically trace all generate() calls.
 *
 * @param agent - The Mastra Agent instance
 * @returns The same agent with tracing enabled
 *
 * @example
 * ```typescript
 * import { trace } from "@fallom/trace";
 * import { Agent } from "@mastra/core";
 *
 * await trace.init({ apiKey: "your-key" });
 *
 * const agent = new Agent({ ... });
 * const tracedAgent = trace.wrapMastraAgent(agent);
 *
 * trace.setSession("my-app", "session-123", "user-456");
 * const result = await tracedAgent.generate([{ role: "user", content: "Hello" }]);
 * // ^ Automatically traced!
 * ```
 */
export function wrapMastraAgent<
  T extends {
    generate: (...args: any[]) => Promise<any>;
    name?: string;
  }
>(agent: T): T {
  const originalGenerate = agent.generate.bind(agent);
  const agentName = agent.name || "MastraAgent";

  agent.generate = async function (...args: any[]) {
    const ctx = sessionStorage.getStore() || fallbackSession;
    if (!ctx || !initialized) {
      return originalGenerate(...args);
    }

    // Get prompt context
    let promptCtx: {
      promptKey: string;
      promptVersion: number;
      abTestKey?: string;
      variantIndex?: number;
    } | null = null;
    try {
      const { getPromptContext } = await import("./prompts");
      promptCtx = getPromptContext();
    } catch {
      // prompts module not available
    }

    const traceId = generateHexId(32);
    const spanId = generateHexId(16);
    const startTime = Date.now();
    const messages = args[0] || [];

    try {
      const result = await originalGenerate(...args);
      const endTime = Date.now();

      // Extract model from agent config or result
      const model = result?.model?.modelId || "unknown";

      // Extract tool calls from steps (Mastra stores them in steps)
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

      // Build OTEL-style attributes
      const attributes: Record<string, unknown> = {
        "gen_ai.system": "Mastra",
        "gen_ai.request.model": model,
        "gen_ai.response.model": model,
        "fallom.source": "mastra-agent",
        "llm.request.type": "chat",
      };

      // Add messages to attributes
      if (Array.isArray(messages)) {
        messages.forEach((msg: any, i: number) => {
          attributes[`gen_ai.prompt.${i}.role`] = msg.role || "user";
          attributes[`gen_ai.prompt.${i}.content`] =
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
        });
      }

      // Add response
      if (result?.text) {
        attributes["gen_ai.completion.0.role"] = "assistant";
        attributes["gen_ai.completion.0.content"] = result.text;
        attributes["gen_ai.completion.0.finish_reason"] = "stop";
      }

      // Add tool calls to attributes
      if (toolCalls.length > 0) {
        attributes["fallom.tool_calls"] = JSON.stringify(toolCalls);
        toolCalls.forEach((tc, i) => {
          attributes[`gen_ai.completion.0.tool_calls.${i}.name`] = tc.name;
          attributes[`gen_ai.completion.0.tool_calls.${i}.type`] = "function";
          attributes[`gen_ai.completion.0.tool_calls.${i}.arguments`] =
            JSON.stringify(tc.arguments);
        });
      }

      // Add usage
      if (result?.usage) {
        attributes["gen_ai.usage.prompt_tokens"] = result.usage.promptTokens;
        attributes["gen_ai.usage.completion_tokens"] =
          result.usage.completionTokens;
        attributes["llm.usage.total_tokens"] = result.usage.totalTokens;
      }

      // Build trace
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
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
      };

      // Send trace (non-blocking)
      sendTrace(traceData).catch(() => {});

      return result;
    } catch (error) {
      const endTime = Date.now();

      // Send error trace
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
        prompt_key: promptCtx?.promptKey,
        prompt_version: promptCtx?.promptVersion,
        prompt_ab_test_key: promptCtx?.abTestKey,
        prompt_variant_index: promptCtx?.variantIndex,
      };

      sendTrace(traceData).catch(() => {});
      throw error;
    }
  } as any;

  return agent;
}
