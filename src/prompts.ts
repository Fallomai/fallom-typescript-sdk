/**
 * Fallom prompts module.
 *
 * Provides prompt management and A/B testing.
 * Zero latency on get() - uses local cache + template interpolation.
 *
 * Design principles:
 * - Never block user's app if Fallom is down
 * - Very short timeouts (1-2 seconds max)
 * - Always return usable prompt (or throw if not found)
 * - Background sync keeps prompts fresh
 * - Auto-tag next trace with prompt context
 */

import { createHash } from "crypto";

// Module state
let apiKey: string | null = null;
let baseUrl: string = "https://prompts.fallom.com";
let initialized = false;
let syncInterval: NodeJS.Timeout | null = null;
let debugMode = false;

// Prompt cache: key -> { versions: { version -> content }, current: number }
const promptCache: Map<
  string,
  {
    versions: Map<number, PromptContent>;
    current: number | null;
  }
> = new Map();

// Prompt A/B cache: key -> { versions: { version -> variants }, current: number }
const promptABCache: Map<
  string,
  {
    versions: Map<number, PromptABVersion>;
    current: number | null;
  }
> = new Map();

// Prompt context for auto-tagging next trace (one-shot)
let promptContext: PromptContext | null = null;

// Short timeouts
const SYNC_TIMEOUT = 2000; // ms

interface PromptContent {
  systemPrompt: string;
  userTemplate: string;
}

interface PromptABVariant {
  prompt_key: string;
  prompt_version: number | null;
  weight: number;
}

interface PromptABVersion {
  variants: PromptABVariant[];
}

interface PromptContext {
  promptKey: string;
  promptVersion: number;
  abTestKey?: string;
  variantIndex?: number;
}

/**
 * Result from prompts.get() or prompts.getAB()
 */
export interface PromptResult {
  key: string;
  version: number;
  system: string;
  user: string;
  abTestKey?: string;
  variantIndex?: number;
}

function log(msg: string): void {
  if (debugMode) {
    console.log(`[Fallom Prompts] ${msg}`);
  }
}

/**
 * Initialize Fallom prompts.
 * This is called automatically by fallom.init().
 */
export function init(
  options: { apiKey?: string; baseUrl?: string } = {}
): void {
  apiKey = options.apiKey || process.env.FALLOM_API_KEY || null;
  baseUrl =
    options.baseUrl ||
    process.env.FALLOM_PROMPTS_URL ||
    process.env.FALLOM_BASE_URL ||
    "https://prompts.fallom.com";
  initialized = true;

  if (!apiKey) {
    return; // No API key - get() will throw
  }

  // Start background fetch immediately (non-blocking)
  fetchAll().catch(() => {});

  // Start background sync (every 30 seconds)
  if (!syncInterval) {
    syncInterval = setInterval(() => {
      fetchAll().catch(() => {});
    }, 30000);
    syncInterval.unref();
  }
}

function ensureInit(): void {
  if (!initialized) {
    try {
      init();
    } catch {
      // Ignore errors
    }
  }
}

async function fetchAll(): Promise<void> {
  await Promise.all([fetchPrompts(), fetchPromptABTests()]);
}

async function fetchPrompts(timeout = SYNC_TIMEOUT): Promise<void> {
  if (!apiKey) return;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const resp = await fetch(`${baseUrl}/prompts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (resp.ok) {
      const data = (await resp.json()) as {
        prompts: Array<{
          key: string;
          version: number;
          system_prompt: string;
          user_template: string;
        }>;
      };

      for (const p of data.prompts || []) {
        if (!promptCache.has(p.key)) {
          promptCache.set(p.key, { versions: new Map(), current: null });
        }
        const cached = promptCache.get(p.key)!;
        cached.versions.set(p.version, {
          systemPrompt: p.system_prompt,
          userTemplate: p.user_template,
        });
        cached.current = p.version;
      }
    }
  } catch {
    // Keep using cached - don't crash
  }
}

async function fetchPromptABTests(timeout = SYNC_TIMEOUT): Promise<void> {
  if (!apiKey) return;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const resp = await fetch(`${baseUrl}/prompt-ab-tests`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (resp.ok) {
      const data = (await resp.json()) as {
        prompt_ab_tests: Array<{
          key: string;
          version: number;
          variants: PromptABVariant[];
        }>;
      };

      for (const t of data.prompt_ab_tests || []) {
        if (!promptABCache.has(t.key)) {
          promptABCache.set(t.key, { versions: new Map(), current: null });
        }
        const cached = promptABCache.get(t.key)!;
        cached.versions.set(t.version, { variants: t.variants });
        cached.current = t.version;
      }
    }
  } catch {
    // Keep using cached
  }
}

/**
 * Replace {{variable}} placeholders in template.
 */
function replaceVariables(
  template: string,
  variables: Record<string, unknown> | undefined
): string {
  if (!variables) return template;

  return template.replace(/\{\{(\s*\w+\s*)\}\}/g, (match, varName) => {
    const key = varName.trim();
    return key in variables ? String(variables[key]) : match;
  });
}

/**
 * Set prompt context for next trace (one-shot).
 */
function setPromptContext(ctx: PromptContext): void {
  promptContext = ctx;
}

/**
 * Get and clear prompt context (one-shot).
 */
export function getPromptContext(): PromptContext | null {
  const ctx = promptContext;
  promptContext = null; // Clear after use
  return ctx;
}

/**
 * Get a prompt (non-A/B).
 *
 * Zero latency - uses local cache + string interpolation.
 * Also sets prompt context for next trace auto-tagging.
 *
 * @param promptKey - Your prompt key (e.g., "onboarding")
 * @param options - Optional settings
 * @param options.variables - Template variables (e.g., { userName: "John" })
 * @param options.version - Pin to specific version. undefined = current
 * @param options.debug - Enable debug logging
 *
 * @example
 * ```typescript
 * const prompt = await prompts.get("onboarding", {
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
 * ```
 */
export async function get(
  promptKey: string,
  options: {
    variables?: Record<string, unknown>;
    version?: number;
    debug?: boolean;
  } = {}
): Promise<PromptResult> {
  const { variables, version, debug = false } = options;
  debugMode = debug;

  ensureInit();
  log(`get() called: promptKey=${promptKey}`);

  // Get from cache
  let promptData = promptCache.get(promptKey);

  // If not in cache, try fetching
  if (!promptData) {
    log("Not in cache, fetching...");
    await fetchPrompts(SYNC_TIMEOUT);
    promptData = promptCache.get(promptKey);
  }

  if (!promptData) {
    throw new Error(
      `Prompt '${promptKey}' not found. Check that it exists in your Fallom dashboard.`
    );
  }

  // Get specific version or current
  const targetVersion = version ?? promptData.current!;
  const content = promptData.versions.get(targetVersion);

  if (!content) {
    throw new Error(
      `Prompt '${promptKey}' version ${targetVersion} not found.`
    );
  }

  // Replace variables
  const system = replaceVariables(content.systemPrompt, variables);
  const user = replaceVariables(content.userTemplate, variables);

  // Set context for next trace
  setPromptContext({
    promptKey,
    promptVersion: targetVersion,
  });

  log(`✅ Got prompt: ${promptKey} v${targetVersion}`);

  return {
    key: promptKey,
    version: targetVersion,
    system,
    user,
  };
}

/**
 * Get a prompt from an A/B test.
 *
 * Uses sessionId hash for deterministic, sticky assignment.
 * Same session always gets same variant.
 *
 * Also sets prompt context for next trace auto-tagging.
 *
 * @param abTestKey - Your A/B test key (e.g., "onboarding-experiment")
 * @param sessionId - Your session/conversation ID (for sticky assignment)
 * @param options - Optional settings
 * @param options.variables - Template variables
 * @param options.debug - Enable debug logging
 *
 * @example
 * ```typescript
 * const prompt = await prompts.getAB("onboarding-test", sessionId, {
 *   variables: { userName: "John" }
 * });
 * ```
 */
export async function getAB(
  abTestKey: string,
  sessionId: string,
  options: {
    variables?: Record<string, unknown>;
    debug?: boolean;
  } = {}
): Promise<PromptResult> {
  const { variables, debug = false } = options;
  debugMode = debug;

  ensureInit();
  log(`getAB() called: abTestKey=${abTestKey}, sessionId=${sessionId}`);

  // Get A/B test from cache
  let abData = promptABCache.get(abTestKey);

  // If not in cache, try fetching
  if (!abData) {
    log("Not in cache, fetching...");
    await fetchPromptABTests(SYNC_TIMEOUT);
    abData = promptABCache.get(abTestKey);
  }

  if (!abData) {
    throw new Error(
      `Prompt A/B test '${abTestKey}' not found. Check that it exists in your Fallom dashboard.`
    );
  }

  // Get current version
  const currentVersion = abData.current!;
  const versionData = abData.versions.get(currentVersion);

  if (!versionData) {
    throw new Error(`Prompt A/B test '${abTestKey}' has no current version.`);
  }

  const { variants } = versionData;

  log(`A/B test '${abTestKey}' has ${variants?.length ?? 0} variants`);
  log(`Version data: ${JSON.stringify(versionData, null, 2)}`);

  if (!variants || variants.length === 0) {
    throw new Error(
      `Prompt A/B test '${abTestKey}' has no variants configured.`
    );
  }

  // Deterministic assignment from sessionId hash
  const hashBytes = createHash("md5").update(sessionId).digest();
  const hashVal = hashBytes.readUInt32BE(0) % 1_000_000;

  // Walk through variants by weight
  let cumulative = 0;
  let selectedVariant = variants[variants.length - 1];
  let selectedIndex = variants.length - 1;

  for (let i = 0; i < variants.length; i++) {
    cumulative += variants[i].weight * 10000;
    if (hashVal < cumulative) {
      selectedVariant = variants[i];
      selectedIndex = i;
      break;
    }
  }

  // Get the actual prompt content
  const promptKey = selectedVariant.prompt_key;
  const promptVersion = selectedVariant.prompt_version;

  // Fetch prompt content
  let promptData = promptCache.get(promptKey);
  if (!promptData) {
    await fetchPrompts(SYNC_TIMEOUT);
    promptData = promptCache.get(promptKey);
  }

  if (!promptData) {
    throw new Error(
      `Prompt '${promptKey}' (from A/B test '${abTestKey}') not found.`
    );
  }

  // Get specific version or current
  const targetVersion = promptVersion ?? promptData.current!;
  const content = promptData.versions.get(targetVersion);

  if (!content) {
    throw new Error(
      `Prompt '${promptKey}' version ${targetVersion} not found.`
    );
  }

  // Replace variables
  const system = replaceVariables(content.systemPrompt, variables);
  const user = replaceVariables(content.userTemplate, variables);

  // Set context for next trace
  setPromptContext({
    promptKey,
    promptVersion: targetVersion,
    abTestKey,
    variantIndex: selectedIndex,
  });

  log(
    `✅ Got prompt from A/B: ${promptKey} v${targetVersion} (variant ${selectedIndex})`
  );

  return {
    key: promptKey,
    version: targetVersion,
    system,
    user,
    abTestKey,
    variantIndex: selectedIndex,
  };
}

/**
 * Manually clear prompt context.
 */
export function clearPromptContext(): void {
  promptContext = null;
}
