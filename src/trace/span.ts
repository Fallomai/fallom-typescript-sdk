/**
 * FallomSpan - Manual span for custom operations.
 *
 * Use for non-LLM operations like RAG retrieval, preprocessing, tool execution, etc.
 *
 * @example
 * ```typescript
 * const session = fallom.session({ configKey: "my-agent", sessionId });
 *
 * // Create a manual span
 * const span = session.span("rag.retrieve");
 * span.set({ "rag.query": userQuery, "rag.topK": 5 });
 *
 * const docs = await retrieveDocuments(userQuery);
 * span.set({ "rag.documents.count": docs.length });
 *
 * span.end(); // Sends the span
 * ```
 */

import { sendTrace, isInitialized } from "./core";
import { generateHexId } from "./utils";
import type { SessionContext } from "./types";

export interface SpanOptions {
  /** Parent span ID for nested spans */
  parentSpanId?: string;
  /** Trace ID to continue an existing trace */
  traceId?: string;
  /** Span kind (defaults to "custom") */
  kind?: "custom" | "tool" | "retrieval" | "preprocessing" | "postprocessing";
}

export class FallomSpan {
  private attrs: Record<string, unknown> = {};
  private startTime: number;
  private ended = false;
  private _status: "OK" | "ERROR" = "OK";
  private _errorMessage?: string;

  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly kind: string;

  constructor(
    private name: string,
    private ctx: SessionContext,
    options: SpanOptions = {}
  ) {
    this.spanId = generateHexId(16);
    this.traceId = options.traceId || generateHexId(32);
    this.parentSpanId = options.parentSpanId;
    this.kind = options.kind || "custom";
    this.startTime = Date.now();
  }

  /**
   * Set attributes on the span.
   * Can be called multiple times - attributes are merged.
   */
  set(attributes: Record<string, unknown>): this {
    if (this.ended) {
      console.warn("[Fallom] Cannot set attributes on ended span");
      return this;
    }
    Object.assign(this.attrs, attributes);
    return this;
  }

  /**
   * Mark the span as errored.
   */
  setError(error: Error | string): this {
    this._status = "ERROR";
    this._errorMessage = error instanceof Error ? error.message : error;
    return this;
  }

  /**
   * Get span context for creating child spans.
   */
  context(): { traceId: string; spanId: string } {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
    };
  }

  /**
   * End the span and send it.
   * Must be called for the span to be recorded.
   */
  end(): void {
    if (this.ended) {
      console.warn("[Fallom] Span already ended");
      return;
    }
    this.ended = true;

    if (!isInitialized()) {
      return;
    }

    const endTime = Date.now();

    sendTrace({
      config_key: this.ctx.configKey,
      session_id: this.ctx.sessionId,
      customer_id: this.ctx.customerId,
      metadata: this.ctx.metadata,
      tags: this.ctx.tags,
      trace_id: this.traceId,
      span_id: this.spanId,
      parent_span_id: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      start_time: new Date(this.startTime).toISOString(),
      end_time: new Date(endTime).toISOString(),
      duration_ms: endTime - this.startTime,
      status: this._status,
      error_message: this._errorMessage,
      attributes: {
        "fallom.sdk_version": "2",
        "fallom.span_type": "manual",
        ...this.attrs,
      },
    }).catch(() => {});
  }
}

/**
 * Wrap a function to automatically create a span around it.
 * Similar to Braintrust's wrapTraced().
 *
 * @example
 * ```typescript
 * const fetchDocuments = wrapTraced(
 *   session,
 *   "rag.fetch",
 *   async (query: string) => {
 *     const docs = await vectorDb.search(query);
 *     return docs;
 *   }
 * );
 *
 * // Function input/output automatically captured
 * const docs = await fetchDocuments("user query");
 * ```
 */
export function wrapTraced<T extends (...args: any[]) => Promise<any>>(
  session: { span: (name: string, options?: SpanOptions) => FallomSpan },
  name: string,
  fn: T,
  options: SpanOptions = {}
): T {
  return (async (...args: Parameters<T>) => {
    const span = session.span(name, options);

    // Capture input (first arg or all args)
    if (args.length === 1) {
      span.set({ input: args[0] });
    } else if (args.length > 1) {
      span.set({ input: args });
    }

    try {
      const result = await fn(...args);
      span.set({ output: result });
      span.end();
      return result;
    } catch (error) {
      span.setError(error instanceof Error ? error : String(error));
      span.end();
      throw error;
    }
  }) as T;
}
