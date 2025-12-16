/**
 * Utility functions for Fallom tracing module.
 */

/**
 * Generate a random hex string of specified length.
 * Used for trace_id (32 chars) and span_id (16 chars).
 */
export function generateHexId(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert OpenAI-style messages to OTEL GenAI semantic convention attributes.
 * This ensures TypeScript SDK traces match Python SDK format.
 */
export function messagesToOtelAttributes(
  messages:
    | Array<{
        role: string;
        content: string | unknown[];
        tool_calls?: unknown[];
      }>
    | undefined,
  completion:
    | {
        role: string;
        content: string | unknown[] | null;
        tool_calls?: unknown[];
      }
    | undefined,
  model: string | undefined,
  responseId: string | undefined
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};

  // Request model
  if (model) {
    attrs["gen_ai.request.model"] = model;
    attrs["gen_ai.response.model"] = model;
  }

  // Response ID
  if (responseId) {
    attrs["gen_ai.response.id"] = responseId;
  }

  // Prompts (input messages)
  if (messages) {
    messages.forEach((msg, i) => {
      attrs[`gen_ai.prompt.${i}.role`] = msg.role;
      // Handle multimodal content (arrays) by JSON.stringify-ing
      attrs[`gen_ai.prompt.${i}.content`] =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
    });
  }

  // Completion (output)
  if (completion) {
    attrs["gen_ai.completion.0.role"] = completion.role;
    // Handle multimodal content in completions
    attrs["gen_ai.completion.0.content"] =
      typeof completion.content === "string"
        ? completion.content
        : JSON.stringify(completion.content);
    if (completion.tool_calls) {
      attrs["gen_ai.completion.0.tool_calls"] = JSON.stringify(
        completion.tool_calls
      );
    }
  }

  return attrs;
}
