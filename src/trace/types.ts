/**
 * Type definitions for Fallom tracing module.
 */

/**
 * Session context for grouping traces.
 */
export interface SessionContext {
  configKey: string;
  sessionId: string;
  customerId?: string;
}

/**
 * Trace context for linking spans together.
 */
export interface TraceContext {
  traceId: string;
  parentSpanId?: string;
}

/**
 * Data structure for a trace sent to the Fallom API.
 * 
 * SDK sends minimal structured data + raw attributes.
 * Microservice extracts tokens, costs, previews, etc. from attributes.
 */
export interface TraceData {
  // Required identifiers
  config_key: string;
  session_id: string;
  customer_id?: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  
  // Basic span info
  name: string;
  kind?: string;
  model?: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  status: "OK" | "ERROR";
  error_message?: string;
  
  // Streaming info (SDK knows this)
  time_to_first_token_ms?: number;
  is_streaming?: boolean;
  
  // Raw data container - microservice parses everything from here
  attributes?: Record<string, unknown>;
  
  // Prompt management (SDK knows which prompt was used)
  prompt_key?: string;
  prompt_version?: number;
  prompt_ab_test_key?: string;
  prompt_variant_index?: number;
}

/**
 * Options for creating a Fallom session.
 */
export interface SessionOptions {
  /** Your config name (e.g., "linkedin-agent") */
  configKey: string;
  /** Your session/conversation ID */
  sessionId: string;
  /** Optional customer/user identifier for analytics */
  customerId?: string;
}

/**
 * Options for wrapAISDK.
 */
export interface WrapAISDKOptions {
  /**
   * Enable debug logging to see the raw Vercel AI SDK response structure.
   * Useful for debugging token extraction issues with different providers.
   */
  debug?: boolean;
}
