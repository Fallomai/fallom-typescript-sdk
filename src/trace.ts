/**
 * Fallom tracing module.
 *
 * Auto-instruments all LLM calls via OTEL and groups them by session.
 * Also supports custom spans for business metrics.
 *
 * This file re-exports from the modular trace/ directory.
 * Each wrapper is in its own file for better maintainability.
 */

// Re-export everything from the trace module
export * from "./trace/index";
