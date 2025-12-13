/**
 * Fallom - Model A/B testing, prompt management, and tracing for LLM applications.
 *
 * @example
 * ```typescript
 * import fallom from 'fallom';
 *
 * // Initialize (call this early, before LLM imports if possible)
 * fallom.init({ apiKey: "your-api-key" });
 *
 * // Set session context for tracing
 * fallom.trace.setSession("my-agent", sessionId);
 *
 * // Get A/B tested model
 * const model = await fallom.models.get("my-config", sessionId, {
 *   fallback: "gpt-4o-mini"
 * });
 *
 * // Get managed prompts (with optional A/B testing)
 * const prompt = await fallom.prompts.get("onboarding", {
 *   variables: { userName: "John" }
 * });
 *
 * // Use with OpenAI
 * const response = await openai.chat.completions.create({
 *   model,
 *   messages: [
 *     { role: "system", content: prompt.system },
 *     { role: "user", content: prompt.user }
 *   ]
 * });
 *
 * // Record custom metrics
 * fallom.trace.span({ user_satisfaction: 5 });
 * ```
 */

export * as trace from "./trace";
export * as models from "./models";
export * as prompts from "./prompts";
export { init } from "./init";
export type { InitOptions } from "./init";
export type { PromptResult } from "./prompts";

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
import { init } from "./init";

export default {
  init,
  trace,
  models,
  prompts,
};
