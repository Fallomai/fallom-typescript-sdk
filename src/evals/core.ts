/**
 * Core evaluation functions.
 */

import type {
  MetricInput,
  DatasetInput,
  DatasetItem,
  Model,
  EvalResult,
  InitOptions,
  EvaluateOptions,
  CompareModelsOptions,
  ModelResponse,
  MetricName,
  LLMTestCase,
} from "./types";
import { AVAILABLE_METRICS, isCustomMetric, getMetricName } from "./types";
import { METRIC_PROMPTS, buildGEvalPrompt } from "./prompts";
import { datasetFromFallom } from "./helpers";

// Module state
export let _apiKey: string | null = null;
export let _baseUrl = "https://app.fallom.com";
export let _initialized = false;

// Default judge model (via OpenRouter)
export const DEFAULT_JUDGE_MODEL = "openai/gpt-4o-mini";

/**
 * Initialize Fallom evals.
 */
export function init(options: InitOptions = {}): void {
  _apiKey = options.apiKey || process.env.FALLOM_API_KEY || null;
  _baseUrl =
    options.baseUrl || process.env.FALLOM_BASE_URL || "https://app.fallom.com";

  if (!_apiKey) {
    throw new Error(
      "No API key provided. Set FALLOM_API_KEY environment variable or pass apiKey option."
    );
  }

  _initialized = true;
}

/**
 * Run G-Eval for a single metric using OpenRouter.
 */
async function runGEval(
  metric: MetricInput,
  inputText: string,
  outputText: string,
  systemMessage: string | undefined,
  judgeModel: string
): Promise<{ score: number; reasoning: string }> {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    throw new Error(
      "OPENROUTER_API_KEY environment variable required for evaluations."
    );
  }

  // Get metric config - either from built-in or custom metric
  const config = isCustomMetric(metric)
    ? { criteria: metric.criteria, steps: metric.steps }
    : METRIC_PROMPTS[metric];

  const prompt = buildGEvalPrompt(
    config.criteria,
    config.steps,
    systemMessage,
    inputText,
    outputText
  );

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: judgeModel,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`G-Eval API error: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const result = JSON.parse(data.choices[0].message.content);
  return { score: result.score, reasoning: result.overall_reasoning };
}

/**
 * Resolve dataset input - either use directly or fetch from Fallom.
 */
async function resolveDataset(
  datasetInput: DatasetInput
): Promise<DatasetItem[]> {
  if (typeof datasetInput === "string") {
    // It's a dataset key - fetch from Fallom
    return datasetFromFallom(datasetInput, undefined, {
      _apiKey,
      _baseUrl,
      _initialized,
    });
  }
  return datasetInput;
}

/**
 * Call a model via OpenRouter.
 */
async function callModelOpenRouter(
  modelSlug: string,
  messages: Array<{ role: string; content: string }>,
  kwargs: Record<string, unknown>
): Promise<ModelResponse> {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    throw new Error(
      "OPENROUTER_API_KEY environment variable required for model comparison"
    );
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelSlug,
        messages,
        ...kwargs,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_cost?: number;
    };
  };
  return {
    content: data.choices[0].message.content,
    tokensIn: data.usage?.prompt_tokens,
    tokensOut: data.usage?.completion_tokens,
    cost: data.usage?.total_cost,
  };
}

/**
 * Evaluate outputs against specified metrics using G-Eval.
 *
 * Results are automatically uploaded to Fallom dashboard.
 *
 */
export async function evaluate(
  options: EvaluateOptions
): Promise<EvalResult[]> {
  const {
    dataset: datasetInput,
    metrics = [...AVAILABLE_METRICS],
    judgeModel = DEFAULT_JUDGE_MODEL,
    name,
    description,
    verbose = true,
    testCases,
    _skipUpload = false,
  } = options;

  // Handle testCases input (convert to DatasetItem format)
  let dataset: DatasetItem[];
  if (testCases !== undefined && testCases.length > 0) {
    dataset = testCases.map((tc: LLMTestCase) => ({
      input: tc.input,
      output: tc.actualOutput,
      systemMessage: tc.systemMessage,
      metadata: tc.metadata,
    }));
  } else if (datasetInput !== undefined) {
    // Resolve dataset - fetch from Fallom if it's a string
    dataset = await resolveDataset(datasetInput);
  } else {
    throw new Error("Either 'dataset' or 'testCases' must be provided");
  }

  // Validate built-in metrics (custom metrics don't need validation)
  for (const m of metrics) {
    if (typeof m === "string" && !AVAILABLE_METRICS.includes(m as MetricName)) {
      throw new Error(
        `Invalid metric: ${m}. Available: ${AVAILABLE_METRICS.join(", ")}. Or use CustomMetric for custom metrics.`
      );
    }
  }

  const results: EvalResult[] = [];

  for (let i = 0; i < dataset.length; i++) {
    const item = dataset[i];
    if (verbose) console.log(`Evaluating item ${i + 1}/${dataset.length}...`);

    const result: EvalResult = {
      input: item.input,
      output: item.output,
      systemMessage: item.systemMessage,
      model: "production",
      isProduction: true,
      reasoning: {},
    };

    for (const metric of metrics) {
      const metricName = getMetricName(metric);
      if (verbose) console.log(`  Running ${metricName}...`);

      try {
        const { score, reasoning } = await runGEval(
          metric,
          item.input,
          item.output,
          item.systemMessage,
          judgeModel
        );

        // Set score using camelCase key (for built-in) or metric name (for custom)
        const key = isCustomMetric(metric)
          ? metricName
          : metricName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        (result as unknown as Record<string, unknown>)[key] = score;
        result.reasoning[metricName] = reasoning;
      } catch (error) {
        if (verbose) console.log(`    Error: ${error}`);
        result.reasoning[metricName] = `Error: ${String(error)}`;
      }
    }

    results.push(result);
  }

  if (verbose) printSummary(results, metrics);

  // Auto-upload to Fallom (unless called from compareModels)
  if (!_skipUpload) {
    if (_initialized) {
      const runName =
        name ||
        `Production Eval ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      await uploadResults(results, runName, description, judgeModel, verbose);
    } else if (verbose) {
      console.log(
        "\n⚠️  Fallom not initialized - results not uploaded. Call evals.init() to enable auto-upload."
      );
    }
  }

  return results;
}

/**
 * Compare multiple models on the same dataset.
 *
 * Results are automatically uploaded to Fallom dashboard.
 */
export async function compareModels(
  options: CompareModelsOptions
): Promise<Record<string, EvalResult[]>> {
  const {
    dataset: datasetInput,
    models,
    metrics = [...AVAILABLE_METRICS],
    judgeModel = DEFAULT_JUDGE_MODEL,
    includeProduction = true,
    modelKwargs = {},
    name,
    description,
    verbose = true,
  } = options;

  if (!datasetInput) {
    throw new Error("'dataset' is required for compareModels()");
  }

  // Resolve dataset - fetch from Fallom if it's a string
  const dataset = await resolveDataset(datasetInput);

  const results: Record<string, EvalResult[]> = {};

  // Evaluate production outputs first
  if (includeProduction) {
    if (verbose) console.log("\n=== Evaluating Production Outputs ===");
    results.production = await evaluate({
      dataset,
      metrics,
      judgeModel,
      verbose,
      _skipUpload: true,
    });
  }

  // Run each model
  for (const modelInput of models) {
    const model: Model =
      typeof modelInput === "string" ? { name: modelInput } : modelInput;

    if (verbose) console.log(`\n=== Testing Model: ${model.name} ===`);

    const modelResults: EvalResult[] = [];

    for (let i = 0; i < dataset.length; i++) {
      const item = dataset[i];
      if (verbose)
        console.log(`Item ${i + 1}/${dataset.length}: Generating output...`);

      const start = Date.now();

      const messages: Array<{ role: string; content: string }> = [];
      if (item.systemMessage) {
        messages.push({ role: "system", content: item.systemMessage });
      }
      messages.push({ role: "user", content: item.input });

      try {
        // Call the model - either custom function or OpenRouter
        let response: ModelResponse;
        if (model.callFn) {
          response = await model.callFn(
            messages as Array<{
              role: "system" | "user" | "assistant";
              content: string;
            }>
          );
        } else {
          response = await callModelOpenRouter(
            model.name,
            messages,
            modelKwargs
          );
        }

        const latencyMs = Date.now() - start;
        const output = response.content;

        const result: EvalResult = {
          input: item.input,
          output,
          systemMessage: item.systemMessage,
          model: model.name,
          isProduction: false,
          reasoning: {},
          latencyMs,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          cost: response.cost,
        };

        // Run metrics
        for (const metric of metrics) {
          const metricName = getMetricName(metric);
          if (verbose) console.log(`  Running ${metricName}...`);

          try {
            const { score, reasoning } = await runGEval(
              metric,
              item.input,
              output,
              item.systemMessage,
              judgeModel
            );

            const key = isCustomMetric(metric)
              ? metricName
              : metricName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
            (result as unknown as Record<string, unknown>)[key] = score;
            result.reasoning[metricName] = reasoning;
          } catch (error) {
            if (verbose) console.log(`    Error: ${error}`);
            result.reasoning[metricName] = `Error: ${String(error)}`;
          }
        }

        modelResults.push(result);
      } catch (error) {
        if (verbose) console.log(`  Error generating output: ${error}`);
        modelResults.push({
          input: item.input,
          output: `Error: ${String(error)}`,
          systemMessage: item.systemMessage,
          model: model.name,
          isProduction: false,
          reasoning: { error: String(error) },
        });
      }
    }

    results[model.name] = modelResults;
  }

  if (verbose) printComparisonSummary(results, metrics);

  // Auto-upload to Fallom
  if (_initialized) {
    const runName =
      name ||
      `Model Comparison ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    await uploadResults(results, runName, description, judgeModel, verbose);
  } else if (verbose) {
    console.log(
      "\n⚠️  Fallom not initialized - results not uploaded. Call evals.init() to enable auto-upload."
    );
  }

  return results;
}

/**
 * Print evaluation summary.
 */
function printSummary(results: EvalResult[], metrics: MetricInput[]): void {
  console.log("\n" + "=".repeat(50));
  console.log("EVALUATION SUMMARY");
  console.log("=".repeat(50));

  for (const metric of metrics) {
    const metricName = getMetricName(metric);
    const key = isCustomMetric(metric)
      ? metricName
      : metricName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const scores = results
      .map(
        (r) =>
          (r as unknown as Record<string, unknown>)[key] as number | undefined
      )
      .filter((s): s is number => s !== undefined);

    if (scores.length > 0) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      console.log(`${metricName}: ${(avg * 100).toFixed(1)}% avg`);
    }
  }
}

/**
 * Print model comparison summary.
 */
function printComparisonSummary(
  results: Record<string, EvalResult[]>,
  metrics: MetricInput[]
): void {
  console.log("\n" + "=".repeat(70));
  console.log("MODEL COMPARISON SUMMARY");
  console.log("=".repeat(70));

  // Header
  let header = "Model".padEnd(30);
  for (const metric of metrics) {
    const metricName = getMetricName(metric);
    header += metricName.slice(0, 12).padEnd(15);
  }
  console.log(header);
  console.log("-".repeat(70));

  // Rows
  for (const [model, modelResults] of Object.entries(results)) {
    let row = model.padEnd(30);
    for (const metric of metrics) {
      const metricName = getMetricName(metric);
      const key = isCustomMetric(metric)
        ? metricName
        : metricName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const scores = modelResults
        .map(
          (r) =>
            (r as unknown as Record<string, unknown>)[key] as number | undefined
        )
        .filter((s): s is number => s !== undefined);

      if (scores.length > 0) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        row += `${(avg * 100).toFixed(1)}%`.padEnd(15);
      } else {
        row += "N/A".padEnd(15);
      }
    }
    console.log(row);
  }
}

/**
 * Upload results to Fallom.
 */
async function uploadResults(
  results: EvalResult[] | Record<string, EvalResult[]>,
  name: string,
  description: string | undefined,
  judgeModel: string,
  verbose: boolean
): Promise<string> {
  // Normalize results format
  const allResults: EvalResult[] = Array.isArray(results)
    ? results
    : Object.values(results).flat();

  // Calculate dataset size
  const uniqueItems = new Set(
    allResults.map((r) => `${r.input}|||${r.systemMessage || ""}`)
  );

  const payload = {
    name,
    description,
    dataset_size: uniqueItems.size,
    judge_model: judgeModel,
    results: allResults.map((r) => ({
      input: r.input,
      system_message: r.systemMessage,
      model: r.model,
      output: r.output,
      is_production: r.isProduction,
      answer_relevancy: r.answerRelevancy,
      hallucination: r.hallucination,
      toxicity: r.toxicity,
      faithfulness: r.faithfulness,
      completeness: r.completeness,
      reasoning: r.reasoning,
      latency_ms: r.latencyMs,
      tokens_in: r.tokensIn,
      tokens_out: r.tokensOut,
      cost: r.cost,
    })),
  };

  try {
    const response = await fetch(`${_baseUrl}/api/sdk-evals`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${_apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`);
    }

    const data = (await response.json()) as { run_id: string };
    const dashboardUrl = `${_baseUrl}/evals/${data.run_id}`;

    if (verbose) {
      console.log(`\n✅ Results uploaded to Fallom! View at: ${dashboardUrl}`);
    }
    return dashboardUrl;
  } catch (error) {
    if (verbose) {
      console.log(`\n⚠️  Failed to upload results: ${error}`);
    }
    return "";
  }
}

/**
 * Public function to upload results manually.
 */
export async function uploadResultsPublic(
  results: EvalResult[] | Record<string, EvalResult[]>,
  options: {
    name: string;
    description?: string;
    judgeModel?: string;
  }
): Promise<string> {
  if (!_initialized) {
    throw new Error("Fallom evals not initialized. Call evals.init() first.");
  }
  return uploadResults(
    results,
    options.name,
    options.description,
    options.judgeModel || DEFAULT_JUDGE_MODEL,
    true
  );
}
