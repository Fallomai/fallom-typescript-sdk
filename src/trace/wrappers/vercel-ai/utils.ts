/**
 * Shared utilities for Vercel AI SDK wrappers.
 */

/**
 * Extract usage data from Vercel AI SDK response.
 * Different providers return usage in different locations.
 */
export interface ExtractedUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export function extractUsageFromResult(
  result: any,
  directUsage?: any
): ExtractedUsage {
  let usage = directUsage ?? result?.usage;

  const isValidNumber = (v: any) =>
    v !== null && v !== undefined && !Number.isNaN(v);

  // Vercel AI SDK uses inputTokens/outputTokens, OpenAI uses prompt_tokens/completion_tokens
  let promptTokens = isValidNumber(usage?.promptTokens)
    ? usage.promptTokens
    : isValidNumber(usage?.inputTokens)
    ? usage.inputTokens
    : isValidNumber(usage?.prompt_tokens)
    ? usage.prompt_tokens
    : undefined;
  let completionTokens = isValidNumber(usage?.completionTokens)
    ? usage.completionTokens
    : isValidNumber(usage?.outputTokens)
    ? usage.outputTokens
    : isValidNumber(usage?.completion_tokens)
    ? usage.completion_tokens
    : undefined;
  let totalTokens = isValidNumber(usage?.totalTokens)
    ? usage.totalTokens
    : isValidNumber(usage?.total_tokens)
    ? usage.total_tokens
    : undefined;
  let cost: number | undefined;

  // Fallback: Check experimental_providerMetadata.openrouter.usage
  const orUsage = result?.experimental_providerMetadata?.openrouter?.usage;
  if (orUsage) {
    if (promptTokens === undefined && isValidNumber(orUsage.promptTokens)) {
      promptTokens = orUsage.promptTokens;
    }
    if (
      completionTokens === undefined &&
      isValidNumber(orUsage.completionTokens)
    ) {
      completionTokens = orUsage.completionTokens;
    }
    if (totalTokens === undefined && isValidNumber(orUsage.totalTokens)) {
      totalTokens = orUsage.totalTokens;
    }
    if (isValidNumber(orUsage.cost)) {
      cost = orUsage.cost;
    }
  }

  // Calculate total if we have parts but not total
  if (
    totalTokens === undefined &&
    (promptTokens !== undefined || completionTokens !== undefined)
  ) {
    totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  }

  return { promptTokens, completionTokens, totalTokens, cost };
}
