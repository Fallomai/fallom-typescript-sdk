/**
 * Core Fallom tracing functionality.
 *
 * Handles initialization and trace sending.
 * Session management is now handled by FallomSession.
 */

import { AsyncLocalStorage } from "async_hooks";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { Context } from "@opentelemetry/api";

import type { TraceContext, TraceData } from "./types";

// =============================================================================
// Module State
// =============================================================================

const traceContextStorage = new AsyncLocalStorage<TraceContext>();
let fallbackTraceContext: TraceContext | null = null;

let apiKey: string | null = null;
let baseUrl: string = "https://traces.fallom.com";
let initialized = false;
let captureContent = true;
let debugMode = false;
let sdk: NodeSDK | null = null;

// =============================================================================
// Logging
// =============================================================================

function log(...args: unknown[]): void {
  if (debugMode) console.log("[Fallom]", ...args);
}

// =============================================================================
// State Accessors (for use by wrappers and session)
// =============================================================================

export function getTraceContextStorage(): AsyncLocalStorage<TraceContext> {
  return traceContextStorage;
}

export function getFallbackTraceContext(): TraceContext | null {
  return fallbackTraceContext;
}

export function isInitialized(): boolean {
  return initialized;
}

export function shouldCaptureContent(): boolean {
  return captureContent;
}

export function getApiKey(): string | null {
  return apiKey;
}

export function getBaseUrl(): string {
  return baseUrl;
}

export function isDebugMode(): boolean {
  return debugMode;
}

// =============================================================================
// OTEL Span Processor (for auto-instrumentation compatibility)
// =============================================================================

const fallomSpanProcessor = {
  onStart(
    span: { setAttribute: (key: string, value: string) => void; name?: string },
    _parentContext: Context
  ): void {
    log("📍 Span started:", (span as any).name || "unknown");
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

// =============================================================================
// Instrumentations (for auto-instrumentation mode)
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getInstrumentations(): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instrumentations: any[] = [];

  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-openai",
    "OpenAIInstrumentation"
  );
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-anthropic",
    "AnthropicInstrumentation"
  );
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-cohere",
    "CohereInstrumentation"
  );
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-bedrock",
    "BedrockInstrumentation"
  );
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-google-generativeai",
    "GoogleGenerativeAIInstrumentation"
  );
  await tryAddInstrumentation(
    instrumentations,
    "@traceloop/instrumentation-azure",
    "AzureOpenAIInstrumentation"
  );
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
  } catch {
    log(`   ❌ ${pkg} not installed`);
  }
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize Fallom tracing.
 *
 * @param options - Configuration options
 * @param options.apiKey - Your Fallom API key. Defaults to FALLOM_API_KEY env var.
 * @param options.baseUrl - API base URL. Defaults to https://traces.fallom.com
 * @param options.captureContent - Whether to capture prompt/completion content.
 * @param options.debug - Enable debug logging.
 *
 * @example
 * ```typescript
 * import fallom from '@fallom/trace';
 *
 * await fallom.init({ apiKey: process.env.FALLOM_API_KEY });
 *
 * const session = fallom.session({
 *   configKey: "my-agent",
 *   sessionId: "session-123",
 * });
 *
 * const { generateText } = session.wrapAISDK(ai);
 * await generateText({ model: openai("gpt-4o"), prompt: "Hello!" });
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

  const exporter = new OTLPTraceExporter({
    url: `${baseUrl}/v1/traces`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const instrumentations = await getInstrumentations();
  log("🔧 Loaded instrumentations:", instrumentations.length);

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

  process.on("SIGTERM", () => {
    sdk?.shutdown().catch(console.error);
  });
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

// =============================================================================
// Trace Sending
// =============================================================================

/**
 * Send a trace to the Fallom API.
 * Used internally by wrappers.
 */
export async function sendTrace(trace: TraceData): Promise<void> {
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
