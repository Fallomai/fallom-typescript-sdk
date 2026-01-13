/**
 * Fallom tracing module.
 *
 * Use session() to create a session-scoped tracer, then wrap your LLM clients.
 */

// Types
export type {
  SessionContext,
  TraceContext,
  TraceData,
  SessionOptions,
  WrapAISDKOptions,
} from "./types";

// Core functions
export { init, shutdown } from "./core";

// Session - the main API
export { FallomSession, session } from "./session";

// Manual spans
export { FallomSpan, wrapTraced } from "./span";
export type { SpanOptions } from "./span";
