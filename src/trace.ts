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
let baseUrl: string = "https://spans.fallom.com";
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
    process.env.FALLOM_BASE_URL ||
    "https://spans.fallom.com";

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
  name: string;
  model?: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  status: "OK" | "ERROR";
  error_message?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input?: string;
  output?: string;
  // Prompt context fields
  prompt_key?: string;
  prompt_version?: number;
  prompt_ab_test_key?: string;
  prompt_variant_index?: number;
}

async function sendTrace(trace: TraceData): Promise<void> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    await fetch(`${baseUrl}/v1/traces`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(trace),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    log("📤 Trace sent:", trace.name, trace.model);
  } catch {
    // Fail silently
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
  },
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

    const params = args[0] || {};
    const startTime = Date.now();

    try {
      const response = await originalCreate(...args);
      const endTime = Date.now();

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        name: "chat.completions.create",
        model: response?.model || params?.model,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "OK",
        prompt_tokens: response?.usage?.prompt_tokens,
        completion_tokens: response?.usage?.completion_tokens,
        total_tokens: response?.usage?.total_tokens,
        input: captureContent ? JSON.stringify(params?.messages) : undefined,
        output: captureContent
          ? response?.choices?.[0]?.message?.content
          : undefined,
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
        name: "chat.completions.create",
        model: params?.model,
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
  T extends { messages: { create: (...args: any[]) => Promise<any> } },
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

    const params = args[0] || {};
    const startTime = Date.now();

    try {
      const response = await originalCreate(...args);
      const endTime = Date.now();

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        name: "messages.create",
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
        input: captureContent ? JSON.stringify(params?.messages) : undefined,
        output: captureContent ? response?.content?.[0]?.text : undefined,
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
        name: "messages.create",
        model: params?.model,
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
  T extends { generateContent: (...args: any[]) => Promise<any> },
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

    const startTime = Date.now();

    try {
      const response = await originalGenerate(...args);
      const endTime = Date.now();

      const result = response?.response;
      const usage = result?.usageMetadata;

      sendTrace({
        config_key: ctx.configKey,
        session_id: ctx.sessionId,
        customer_id: ctx.customerId,
        name: "generateContent",
        model: (model as any)?.model || "gemini",
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        duration_ms: endTime - startTime,
        status: "OK",
        prompt_tokens: usage?.promptTokenCount,
        completion_tokens: usage?.candidatesTokenCount,
        total_tokens: usage?.totalTokenCount,
        input: captureContent ? JSON.stringify(args[0]) : undefined,
        output: captureContent ? result?.text?.() : undefined,
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
        name: "generateContent",
        model: (model as any)?.model || "gemini",
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
  } as typeof model.generateContent;

  return model;
}
