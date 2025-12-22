/**
 * Helper functions for creating models and datasets.
 */

import type {
  Model,
  ModelCallable,
  DatasetItem,
  CustomMetric,
  Message,
  Golden,
  LLMTestCase,
  ModelResponse,
} from "./types";

/**
 * Create a Model using OpenAI directly (for fine-tuned models or Azure OpenAI).
 *
 * @param modelId - The OpenAI model ID (e.g., "gpt-4o" or "ft:gpt-4o-2024-08-06:org::id")
 * @param options - Configuration options
 * @returns Model instance that can be used in compareModels()
 */
export function createOpenAIModel(
  modelId: string,
  options: {
    name?: string;
    apiKey?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  } = {}
): Model {
  const { name, apiKey, baseUrl, temperature, maxTokens } = options;

  const callFn: ModelCallable = async (messages: Message[]) => {
    // Dynamic import to avoid requiring openai if not used
    const openaiApiKey = apiKey || process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error(
        "OpenAI API key required. Set OPENAI_API_KEY env var or pass apiKey option."
      );
    }

    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages,
    };
    if (temperature !== undefined) requestBody.temperature = temperature;
    if (maxTokens !== undefined) requestBody.max_tokens = maxTokens;

    const response = await fetch(
      baseUrl || "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      content: data.choices[0].message.content || "",
      tokensIn: data.usage?.prompt_tokens,
      tokensOut: data.usage?.completion_tokens,
    };
  };

  return { name: name || modelId, callFn };
}

/**
 * Create a Model for any OpenAI-compatible API endpoint.
 *
 * Works with self-hosted models (vLLM, Ollama, LMStudio, etc.), custom endpoints,
 * or any service that follows the OpenAI chat completions API format.
 *
 * @param name - Display name for the model
 * @param options - Configuration options
 * @returns A Model instance
 */
export function createCustomModel(
  name: string,
  options: {
    endpoint: string;
    apiKey?: string;
    headers?: Record<string, string>;
    modelField?: string;
    modelValue?: string;
    extraParams?: Record<string, unknown>;
  }
): Model {
  const {
    endpoint,
    apiKey,
    headers = {},
    modelField = "model",
    modelValue,
    extraParams = {},
  } = options;

  const callFn: ModelCallable = async (messages: Message[]) => {
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
    };
    if (apiKey) {
      requestHeaders.Authorization = `Bearer ${apiKey}`;
    }

    const payload = {
      [modelField]: modelValue || name,
      messages,
      ...extraParams,
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
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
  };

  return { name, callFn };
}

/**
 * Create a Model from any callable function.
 *
 * This is the most flexible option - you provide a function that takes
 * messages and returns a response.
 *
 * @param name - Display name for the model
 * @param callFn - Function that takes messages and returns a response
 * @returns A Model instance
 */
export function createModelFromCallable(
  name: string,
  callFn: ModelCallable
): Model {
  return { name, callFn };
}

/**
 * Create a custom evaluation metric using G-Eval.
 *
 * @param name - Unique identifier for the metric (e.g., "brand_alignment")
 * @param criteria - Description of what the metric evaluates
 * @param steps - List of evaluation steps for the LLM judge to follow
 * @returns A CustomMetric instance
 */
export function customMetric(
  name: string,
  criteria: string,
  steps: string[]
): CustomMetric {
  return { name, criteria, steps };
}

/**
 * Create a dataset from Fallom trace data.
 *
 * @param traces - List of trace objects with attributes
 * @returns List of DatasetItem ready for evaluation
 */
export function datasetFromTraces(
  traces: Array<{ attributes?: Record<string, unknown> }>
): DatasetItem[] {
  const items: DatasetItem[] = [];

  for (const trace of traces) {
    const attrs = trace.attributes || {};
    if (Object.keys(attrs).length === 0) continue;

    // Extract input (last user message)
    let inputText = "";
    for (let i = 0; i < 100; i++) {
      const role = attrs[`gen_ai.prompt.${i}.role`];
      if (role === undefined) break;
      if (role === "user") {
        inputText = (attrs[`gen_ai.prompt.${i}.content`] as string) || "";
      }
    }

    // Extract output
    const outputText = (attrs["gen_ai.completion.0.content"] as string) || "";

    // Extract system message
    let systemMessage: string | undefined;
    if (attrs["gen_ai.prompt.0.role"] === "system") {
      systemMessage = attrs["gen_ai.prompt.0.content"] as string;
    }

    if (inputText && outputText) {
      items.push({
        input: inputText,
        output: outputText,
        systemMessage,
      });
    }
  }

  return items;
}

/**
 * Fetch a dataset stored in Fallom by its key.
 *
 * @param datasetKey - The unique key of the dataset (e.g., "customer-support-qa")
 * @param version - Specific version number to fetch. If undefined, fetches latest.
 * @param config - Internal config (api key, base url, initialized flag)
 * @returns List of DatasetItem ready for evaluation
 */
export async function datasetFromFallom(
  datasetKey: string,
  version?: number,
  config?: {
    _apiKey?: string | null;
    _baseUrl?: string;
    _initialized?: boolean;
  }
): Promise<DatasetItem[]> {
  // Import here to avoid circular dependency
  const { _apiKey, _baseUrl, _initialized } = await import("./core").then(
    (m) => ({
      _apiKey: config?._apiKey ?? m._apiKey,
      _baseUrl: config?._baseUrl ?? m._baseUrl,
      _initialized: config?._initialized ?? m._initialized,
    })
  );

  if (!_initialized) {
    throw new Error("Fallom evals not initialized. Call evals.init() first.");
  }

  // Build URL
  let url = `${_baseUrl}/api/datasets/${encodeURIComponent(datasetKey)}`;
  if (version !== undefined) {
    url += `?version=${version}`;
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${_apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 404) {
    throw new Error(`Dataset '${datasetKey}' not found`);
  } else if (response.status === 403) {
    throw new Error(`Access denied to dataset '${datasetKey}'`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch dataset: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    entries?: Array<{
      input: string;
      output: string;
      systemMessage?: string;
      metadata?: Record<string, unknown>;
    }>;
    dataset?: { name?: string };
    version?: { version?: number };
  };

  // Convert to DatasetItem list
  const items: DatasetItem[] = [];
  for (const entry of data.entries || []) {
    items.push({
      input: entry.input,
      output: entry.output,
      systemMessage: entry.systemMessage,
      metadata: entry.metadata,
    });
  }

  const datasetName = data.dataset?.name || datasetKey;
  const versionNum = data.version?.version || "latest";
  console.log(
    `✓ Loaded dataset '${datasetName}' (version ${versionNum}) with ${items.length} entries`
  );

  return items;
}

/**
 * A dataset for evaluation that supports pulling from Fallom and adding test cases.
 *
 * This provides a workflow where you:
 * 1. Pull a dataset (goldens) from Fallom
 * 2. Run your own LLM pipeline on each golden to generate outputs
 * 3. Add the results as test cases
 * 4. Evaluate the test cases
 *
 */
export class EvaluationDataset {
  private _goldens: Golden[] = [];
  private _testCases: LLMTestCase[] = [];
  private _datasetKey: string | null = null;
  private _datasetName: string | null = null;
  private _version: number | null = null;

  /** List of golden records (inputs with optional expected outputs). */
  get goldens(): Golden[] {
    return this._goldens;
  }

  /** List of test cases (inputs with actual outputs from your LLM). */
  get testCases(): LLMTestCase[] {
    return this._testCases;
  }

  /** The Fallom dataset key if pulled from Fallom. */
  get datasetKey(): string | null {
    return this._datasetKey;
  }

  /**
   * Pull a dataset from Fallom.
   *
   * @param alias - The dataset key/alias in Fallom
   * @param version - Specific version to pull (default: latest)
   * @returns Self for chaining
   */
  async pull(alias: string, version?: number): Promise<EvaluationDataset> {
    // Import core to get api key and base url
    const { _apiKey, _baseUrl, _initialized } = await import("./core");

    if (!_initialized) {
      throw new Error("Fallom evals not initialized. Call evals.init() first.");
    }

    // Build URL with include_entries
    const params = new URLSearchParams({ include_entries: "true" });
    if (version !== undefined) {
      params.set("version", String(version));
    }
    const url = `${_baseUrl}/api/datasets/${encodeURIComponent(alias)}?${params}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${_apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 404) {
      throw new Error(`Dataset '${alias}' not found`);
    } else if (response.status === 403) {
      throw new Error(`Access denied to dataset '${alias}'`);
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch dataset: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      entries?: Array<{
        input?: string;
        output?: string;
        systemMessage?: string;
        metadata?: Record<string, unknown>;
      }>;
      dataset?: { name?: string };
      version?: { version?: number };
    };

    // Store metadata
    this._datasetKey = alias;
    this._datasetName = data.dataset?.name || alias;
    this._version = data.version?.version || null;

    // Convert entries to goldens
    this._goldens = [];
    for (const entry of data.entries || []) {
      this._goldens.push({
        input: entry.input || "",
        expectedOutput: entry.output,
        systemMessage: entry.systemMessage,
        metadata: entry.metadata,
      });
    }

    console.log(
      `✓ Pulled dataset '${this._datasetName}' (version ${this._version}) with ${this._goldens.length} goldens`
    );
    return this;
  }

  /**
   * Add a golden record manually.
   * @param golden - A Golden object
   * @returns Self for chaining
   */
  addGolden(golden: Golden): EvaluationDataset {
    this._goldens.push(golden);
    return this;
  }

  /**
   * Add multiple golden records.
   * @param goldens - Array of Golden objects
   * @returns Self for chaining
   */
  addGoldens(goldens: Golden[]): EvaluationDataset {
    this._goldens.push(...goldens);
    return this;
  }

  /**
   * Add a test case with actual LLM output.
   * @param testCase - An LLMTestCase object
   * @returns Self for chaining
   */
  addTestCase(testCase: LLMTestCase): EvaluationDataset {
    this._testCases.push(testCase);
    return this;
  }

  /**
   * Add multiple test cases.
   * @param testCases - Array of LLMTestCase objects
   * @returns Self for chaining
   */
  addTestCases(testCases: LLMTestCase[]): EvaluationDataset {
    this._testCases.push(...testCases);
    return this;
  }

  /**
   * Automatically generate test cases by running all goldens through your LLM app.
   *
   * @param llmApp - A callable that takes messages and returns response
   * @param options - Configuration options
   * @returns Self for chaining
   */
  async generateTestCases(
    llmApp: (messages: Message[]) => Promise<ModelResponse>,
    options: { includeContext?: boolean } = {}
  ): Promise<EvaluationDataset> {
    const { includeContext = false } = options;

    console.log(`Generating test cases for ${this._goldens.length} goldens...`);

    for (let i = 0; i < this._goldens.length; i++) {
      const golden = this._goldens[i];

      // Build messages
      const messages: Message[] = [];
      if (golden.systemMessage) {
        messages.push({ role: "system", content: golden.systemMessage });
      }
      messages.push({ role: "user", content: golden.input });

      // Call the LLM app
      const response = await llmApp(messages);

      // Create test case
      const testCase: LLMTestCase = {
        input: golden.input,
        actualOutput: response.content,
        expectedOutput: golden.expectedOutput,
        systemMessage: golden.systemMessage,
        context: includeContext
          ? (response as ModelResponse & { context?: string[] }).context
          : golden.context,
        metadata: golden.metadata,
      };
      this._testCases.push(testCase);

      console.log(
        `  [${i + 1}/${this._goldens.length}] Generated output for: ${golden.input.slice(0, 50)}...`
      );
    }

    console.log(`✓ Generated ${this._testCases.length} test cases`);
    return this;
  }

  /** Clear all test cases (useful for re-running with different LLM). */
  clearTestCases(): EvaluationDataset {
    this._testCases = [];
    return this;
  }

  /** Return the number of goldens. */
  get length(): number {
    return this._goldens.length;
  }
}
