/**
 * Vercel AI SDK wrapper for automatic tracing.
 */

import type { SessionContext, WrapAISDKOptions } from "../../types";
import { createGenerateTextWrapper } from "./generate-text";
import { createStreamTextWrapper } from "./stream-text";
import { createGenerateObjectWrapper } from "./generate-object";
import { createStreamObjectWrapper } from "./stream-object";

/**
 * Wrap the Vercel AI SDK to automatically trace all LLM calls.
 * Requires a session context (use via FallomSession).
 */
export function wrapAISDK<
  T extends {
    generateText: (...args: any[]) => Promise<any>;
    streamText: (...args: any[]) => any;
    generateObject?: (...args: any[]) => Promise<any>;
    streamObject?: (...args: any[]) => any;
  }
>(
  ai: T,
  sessionCtx: SessionContext,
  options?: WrapAISDKOptions
): {
  generateText: T["generateText"];
  streamText: T["streamText"];
  generateObject: T["generateObject"];
  streamObject: T["streamObject"];
} {
  const debug = options?.debug ?? false;

  return {
    generateText: createGenerateTextWrapper(ai, sessionCtx, debug),
    streamText: createStreamTextWrapper(ai, sessionCtx, debug),
    generateObject: ai.generateObject
      ? createGenerateObjectWrapper(ai, sessionCtx, debug)
      : undefined,
    streamObject: ai.streamObject
      ? createStreamObjectWrapper(ai, sessionCtx, debug)
      : undefined,
  } as any;
}

export { createGenerateTextWrapper } from "./generate-text";
export { createStreamTextWrapper } from "./stream-text";
export { createGenerateObjectWrapper } from "./generate-object";
export { createStreamObjectWrapper } from "./stream-object";
export { extractUsageFromResult } from "./utils";
