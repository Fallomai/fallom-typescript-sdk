/**
 * Fallom - Model A/B testing, prompt management, tracing, and evals for LLM applications.
 *
 * @example
 * ```typescript
 * import fallom from '@fallom/trace';
 * import * as ai from 'ai';
 * import { createOpenAI } from '@ai-sdk/openai';
 *
 * // Initialize once
 * await fallom.init({ apiKey: "your-api-key" });
 *
 * // Create a session for this conversation/request
 * const session = fallom.session({
 *   configKey: "my-agent",
 *   sessionId: "session-123",
 *   customerId: "user-456",
 * });
 *
 * // Option 1: Wrap the AI SDK (our style)
 * const { generateText } = session.wrapAISDK(ai);
 * await generateText({ model: openai("gpt-4o"), prompt: "Hello!" });
 *
 * // Option 2: Wrap the model directly (PostHog style)
 * const model = session.traceModel(openai("gpt-4o"));
 * await ai.generateText({ model, prompt: "Hello!" });
 *
 * // Get A/B tested model within session
 * const modelName = await session.getModel({ fallback: "gpt-4o-mini" });
 *
 * // Run evaluations
 * fallom.evals.init({ apiKey: "your-api-key" });
 * const results = await fallom.evals.evaluate({
 *   dataset: [{ input: "...", output: "...", systemMessage: "..." }],
 *   metrics: ["answer_relevancy", "faithfulness"]
 * });
 * await fallom.evals.uploadResults(results, "My Eval Run");
 * ```
 */

export * as trace from "./trace";
export * as models from "./models";
export * as prompts from "./prompts";
export * as evals from "./evals";
export { init } from "./init";
export type { InitOptions } from "./init";
export type { PromptResult } from "./prompts";
export type {
  DatasetItem,
  EvalResult,
  MetricName,
  EvaluateOptions,
  CompareModelsOptions,
} from "./evals";

// G-Eval core exports for direct import (used by eval-worker)
export {
  runGEval,
  calculateAggregateScores,
  detectRegression,
  buildGEvalPrompt,
  type GEvalScore,
} from "./evals";

// Session-scoped tracing exports
export { session, FallomSession, FallomSpan, wrapTraced } from "./trace";
export type { SessionOptions, SessionContext, SpanOptions } from "./trace";

// Mastra integration
export {
  FallomExporter,
  setMastraPrompt,
  setMastraPromptAB,
  clearMastraPrompt,
} from "./mastra";
export type { FallomExporterOptions } from "./mastra";

// Re-import for default export
import * as trace from "./trace";
import * as models from "./models";
import * as prompts from "./prompts";
import * as evals from "./evals";
import { init } from "./init";
import { session } from "./trace";

export default {
  init,
  trace,
  models,
  prompts,
  evals,
  session,
};
