/**
 * Fallom Exporter for Mastra
 *
 * Custom OpenTelemetry exporter that sends traces from Mastra agents to Fallom.
 * Session context should be passed to the exporter constructor.
 *
 * Usage with Mastra:
 * ```typescript
 * import { trace, FallomExporter } from "@fallom/trace";
 * import { Mastra } from "@mastra/core/mastra";
 *
 * // Initialize trace module
 * await trace.init({ apiKey: process.env.FALLOM_API_KEY });
 *
 * // Create session for this request
 * const session = trace.session({
 *   configKey: "my-app",
 *   sessionId: "session-123",
 *   customerId: "user-456"
 * });
 *
 * // Create Mastra with Fallom exporter (pass session context)
 * const mastra = new Mastra({
 *   agents: { myAgent },
 *   telemetry: {
 *     serviceName: "my-agent",
 *     enabled: true,
 *     export: {
 *       type: "custom",
 *       exporter: new FallomExporter({
 *         session: session.getContext()
 *       }),
 *     },
 *   },
 * });
 *
 * const result = await mastra.getAgent("myAgent").generate("Hello!");
 * ```
 */

import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { SessionContext } from "./trace";

// Prompt context (set per-request)
interface PromptContext {
  promptKey?: string;
  promptVersion?: number;
  promptAbTestKey?: string;
  promptVariantIndex?: number;
}

// Module-level prompt context
let promptContext: PromptContext = {};

export interface FallomExporterOptions {
  /** Fallom API key. Defaults to FALLOM_API_KEY env var. */
  apiKey?: string;
  /** Base URL for traces endpoint (defaults to https://traces.fallom.com) */
  baseUrl?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Session context for tracing */
  session?: SessionContext;
}

/**
 * Set prompt tracking info.
 * Call this after prompts.get() to track which prompt was used.
 */
export function setMastraPrompt(promptKey: string, version?: number): void {
  promptContext = {
    promptKey,
    promptVersion: version,
    promptAbTestKey: undefined,
    promptVariantIndex: undefined,
  };
}

/**
 * Set A/B test prompt tracking info.
 * Call this after prompts.getAB() to track which variant was used.
 */
export function setMastraPromptAB(
  abTestKey: string,
  variantIndex: number
): void {
  promptContext = {
    promptKey: undefined,
    promptVersion: undefined,
    promptAbTestKey: abTestKey,
    promptVariantIndex: variantIndex,
  };
}

/**
 * Clear prompt tracking info.
 */
export function clearMastraPrompt(): void {
  promptContext = {};
}

/**
 * OpenTelemetry SpanExporter that sends traces to Fallom.
 *
 * Pass session context via constructor options.
 * Compatible with Mastra's custom exporter interface.
 */
export class FallomExporter implements SpanExporter {
  private apiKey: string;
  private baseUrl: string;
  private debug: boolean;
  private session?: SessionContext;
  private pendingExports: Promise<void>[] = [];

  constructor(options: FallomExporterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.FALLOM_API_KEY ?? "";
    this.baseUrl = options.baseUrl ?? "https://traces.fallom.com";
    this.debug = options.debug ?? false;
    this.session = options.session;

    if (this.debug) {
      console.log("[FallomExporter] Constructor called");
      console.log("[FallomExporter] API key present:", !!this.apiKey);
      console.log("[FallomExporter] Base URL:", this.baseUrl);
      console.log("[FallomExporter] Session:", this.session);
    }

    if (!this.apiKey) {
      console.warn(
        "[FallomExporter] No API key provided. Set FALLOM_API_KEY env var or pass apiKey option."
      );
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log("[FallomExporter]", ...args);
    }
  }

  /**
   * Export spans to Fallom.
   */
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): void {
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    this.log(`Exporting ${spans.length} spans...`);

    if (this.debug) {
      for (const span of spans) {
        this.log(`  - ${span.name}`, {
          attributes: Object.fromEntries(
            Object.entries(span.attributes).filter(
              ([k]) => k.startsWith("gen_ai") || k.startsWith("llm")
            )
          ),
        });
      }
    }

    const exportPromise = this.sendSpans(spans)
      .then(() => {
        this.log("Export successful");
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch((error) => {
        console.error("[FallomExporter] Export failed:", error);
        resultCallback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

    this.pendingExports.push(exportPromise);
  }

  /**
   * Shutdown the exporter, waiting for pending exports.
   */
  async shutdown(): Promise<void> {
    await Promise.all(this.pendingExports);
    this.pendingExports = [];
  }

  /**
   * Force flush pending exports.
   */
  async forceFlush(): Promise<void> {
    await Promise.all(this.pendingExports);
  }

  /**
   * Send spans to Fallom's OTLP endpoint.
   */
  private async sendSpans(spans: ReadableSpan[]): Promise<void> {
    const resourceSpans = this.spansToOtlpJson(spans);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    // Add session context headers
    if (this.session?.configKey) {
      headers["X-Fallom-Config-Key"] = this.session.configKey;
    }
    if (this.session?.sessionId) {
      headers["X-Fallom-Session-Id"] = this.session.sessionId;
    }
    if (this.session?.customerId) {
      headers["X-Fallom-Customer-Id"] = this.session.customerId;
    }

    // Add prompt tracking headers
    if (promptContext.promptKey) {
      headers["X-Fallom-Prompt-Key"] = promptContext.promptKey;
    }
    if (promptContext.promptVersion !== undefined) {
      headers["X-Fallom-Prompt-Version"] = String(promptContext.promptVersion);
    }
    if (promptContext.promptAbTestKey) {
      headers["X-Fallom-Prompt-AB-Test"] = promptContext.promptAbTestKey;
    }
    if (promptContext.promptVariantIndex !== undefined) {
      headers["X-Fallom-Prompt-Variant"] = String(
        promptContext.promptVariantIndex
      );
    }

    const endpoint = `${this.baseUrl}/v1/traces`;

    this.log("Sending to", endpoint);
    this.log("Headers:", {
      ...headers,
      Authorization: "Bearer ***",
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ resourceSpans }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to export: ${response.status} ${text}`);
    }
  }

  /**
   * Convert OpenTelemetry spans to OTLP JSON format.
   */
  private spansToOtlpJson(spans: ReadableSpan[]): any[] {
    const resourceMap = new Map<string, ReadableSpan[]>();

    for (const span of spans) {
      const resourceKey = JSON.stringify(span.resource.attributes);
      if (!resourceMap.has(resourceKey)) {
        resourceMap.set(resourceKey, []);
      }
      resourceMap.get(resourceKey)!.push(span);
    }

    const resourceSpans: any[] = [];

    for (const [_resourceKey, resourceSpanList] of resourceMap) {
      const firstSpan = resourceSpanList[0];

      resourceSpans.push({
        resource: {
          attributes: this.attributesToOtlp(firstSpan.resource.attributes),
        },
        scopeSpans: [
          {
            scope: {
              name: firstSpan.instrumentationLibrary.name,
              version: firstSpan.instrumentationLibrary.version,
            },
            spans: resourceSpanList.map((span) => this.spanToOtlp(span)),
          },
        ],
      });
    }

    return resourceSpans;
  }

  /**
   * Convert a single span to OTLP format.
   */
  private spanToOtlp(span: ReadableSpan): any {
    return {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTimeUnixNano: this.hrTimeToNanos(span.startTime),
      endTimeUnixNano: this.hrTimeToNanos(span.endTime),
      attributes: this.attributesToOtlp(span.attributes),
      status: {
        code: span.status.code,
        message: span.status.message,
      },
      events: span.events.map((event) => ({
        timeUnixNano: this.hrTimeToNanos(event.time),
        name: event.name,
        attributes: this.attributesToOtlp(event.attributes || {}),
      })),
    };
  }

  /**
   * Convert attributes to OTLP format.
   */
  private attributesToOtlp(
    attrs: Record<string, any>
  ): Array<{ key: string; value: any }> {
    return Object.entries(attrs).map(([key, value]) => ({
      key,
      value: this.valueToOtlp(value),
    }));
  }

  /**
   * Convert a value to OTLP AnyValue format.
   */
  private valueToOtlp(value: any): any {
    if (typeof value === "string") {
      return { stringValue: value };
    }
    if (typeof value === "number") {
      if (Number.isInteger(value)) {
        return { intValue: value };
      }
      return { doubleValue: value };
    }
    if (typeof value === "boolean") {
      return { boolValue: value };
    }
    if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map((v) => this.valueToOtlp(v)),
        },
      };
    }
    return { stringValue: String(value) };
  }

  /**
   * Convert HrTime to nanoseconds string.
   */
  private hrTimeToNanos(hrTime: [number, number]): string {
    const [seconds, nanos] = hrTime;
    return String(BigInt(seconds) * BigInt(1e9) + BigInt(nanos));
  }
}
