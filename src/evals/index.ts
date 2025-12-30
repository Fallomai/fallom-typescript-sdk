/**
 * Fallom Evals - Run LLM evaluations locally using G-Eval with LLM as a Judge.
 *
 * Evaluate production outputs or compare different models on your dataset.
 * Results are uploaded to Fallom dashboard for visualization.
 *
 * @example
 * import fallom from "@fallom/trace";
 *
 * // Initialize
 * fallom.evals.init({ apiKey: "flm_xxx" });
 *
 * // Method 1: Direct dataset evaluation
 * const results = await fallom.evals.evaluate({
 *   dataset: [...],
 *   metrics: ["answer_relevancy", "faithfulness"],
 * });
 *
 * // Method 2: Use EvaluationDataset with your own LLM pipeline
 * const dataset = new fallom.evals.EvaluationDataset();
 * await dataset.pull("my-dataset-key");
 *
 * for (const golden of dataset.goldens) {
 *   const actualOutput = await myLLMApp(golden.input);
 *   dataset.addTestCase({
 *     input: golden.input,
 *     actualOutput,
 *   });
 * }
 *
 * const results = await fallom.evals.evaluate({
 *   testCases: dataset.testCases,
 *   metrics: ["answer_relevancy", "faithfulness"],
 * });
 */

// Types
export type {
  MetricName,
  MetricInput,
  DatasetInput,
  DatasetItem,
  EvalResult,
  ModelResponse,
  Message,
  ModelCallable,
  Model,
  CustomMetric,
  Golden,
  LLMTestCase,
  InitOptions,
  EvaluateOptions,
  CompareModelsOptions,
} from "./types";

export { AVAILABLE_METRICS, isCustomMetric, getMetricName } from "./types";

// Prompts and G-Eval core
export {
  METRIC_PROMPTS,
  buildGEvalPrompt,
  runGEval,
  calculateAggregateScores,
  detectRegression,
  type GEvalScore,
  type RunGEvalOptions,
} from "./prompts";

// Core functions
export {
  init,
  evaluate,
  compareModels,
  uploadResultsPublic as uploadResults,
  DEFAULT_JUDGE_MODEL,
} from "./core";

// Helper functions and classes
export {
  createOpenAIModel,
  createCustomModel,
  createModelFromCallable,
  customMetric,
  datasetFromTraces,
  datasetFromFallom,
  EvaluationDataset,
} from "./helpers";
