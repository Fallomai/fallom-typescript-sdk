/**
 * Fallom models module.
 *
 * Provides model A/B testing with versioned configs.
 * Zero latency on get() - uses local hash + cached config.
 *
 * Design principles:
 * - Never block user's app if Fallom is down
 * - Very short timeouts (1-2 seconds max)
 * - Always return a usable model (fallback if needed)
 * - Background sync keeps configs fresh
 */

import { createHash } from "crypto";

// Module state
let apiKey: string | null = null;
let baseUrl: string = "https://configs.fallom.com";
let initialized = false;
let syncInterval: NodeJS.Timeout | null = null;
let debugMode = false;

// Config cache: key -> { versions: { version -> config }, latest: number }
const configCache: Map<
  string,
  {
    versions: Map<number, Config>;
    latest: number | null;
  }
> = new Map();

// Short timeouts - we'd rather return fallback than add latency
const SYNC_TIMEOUT = 2000; // ms
const RECORD_TIMEOUT = 1000; // ms

interface Variant {
  model: string;
  weight: number;
}

interface Config {
  key: string;
  version: number;
  variants: Variant[] | Record<string, Variant>;
}

function log(msg: string): void {
  if (debugMode) {
    console.log(`[Fallom] ${msg}`);
  }
}

/**
 * Initialize Fallom models.
 *
 * This is optional - get() will auto-init if needed.
 * Non-blocking: starts background config fetch immediately.
 */
export function init(
  options: {
    apiKey?: string;
    baseUrl?: string;
  } = {}
): void {
  apiKey = options.apiKey || process.env.FALLOM_API_KEY || null;
  baseUrl =
    options.baseUrl ||
    process.env.FALLOM_CONFIGS_URL ||
    process.env.FALLOM_BASE_URL ||
    "https://configs.fallom.com";
  initialized = true;

  if (!apiKey) {
    return; // No API key - get() will return fallback
  }

  // Start background fetch immediately (non-blocking)
  fetchConfigs().catch(() => {});

  // Start background sync (every 30 seconds)
  if (!syncInterval) {
    syncInterval = setInterval(() => {
      fetchConfigs().catch(() => {});
    }, 30000);
    // Don't prevent process from exiting
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

async function fetchConfigs(timeout = SYNC_TIMEOUT): Promise<void> {
  if (!apiKey) {
    log("_fetchConfigs: No API key, skipping");
    return;
  }

  try {
    log(`Fetching configs from ${baseUrl}/configs`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const resp = await fetch(`${baseUrl}/configs`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    log(`Response status: ${resp.status}`);

    if (resp.ok) {
      const data = (await resp.json()) as { configs: Config[] };
      const configs = data.configs || [];
      log(`Got ${configs.length} configs: ${configs.map((c) => c.key)}`);

      for (const c of configs) {
        const key = c.key;
        const version = c.version || 1;
        log(`Config '${key}' v${version}: ${JSON.stringify(c.variants)}`);

        if (!configCache.has(key)) {
          configCache.set(key, { versions: new Map(), latest: null });
        }
        const cached = configCache.get(key)!;
        cached.versions.set(version, c);
        cached.latest = version;
      }
    } else {
      log(`Fetch failed: ${resp.statusText}`);
    }
  } catch (e) {
    log(`Fetch exception: ${e}`);
    // Keep using cached configs - don't crash
  }
}

async function fetchSpecificVersion(
  configKey: string,
  version: number,
  timeout = SYNC_TIMEOUT
): Promise<Config | null> {
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const resp = await fetch(
      `${baseUrl}/configs/${configKey}/version/${version}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (resp.ok) {
      const config = (await resp.json()) as Config;

      if (!configCache.has(configKey)) {
        configCache.set(configKey, { versions: new Map(), latest: null });
      }
      configCache.get(configKey)!.versions.set(version, config);

      return config;
    }
  } catch {
    // Fail silently
  }
  return null;
}

/**
 * Get model assignment for a session.
 *
 * This is zero latency - uses local hash computation + cached config.
 * No network call on the hot path.
 *
 * Same session_id always returns same model (sticky assignment).
 *
 * @param configKey - Your config name (e.g., "linkedin-agent")
 * @param sessionId - Your session/conversation ID (must be consistent)
 * @param options - Optional settings
 * @param options.version - Pin to specific version (1, 2, etc). undefined = latest
 * @param options.fallback - Model to return if config not found or Fallom is down
 * @param options.debug - Enable debug logging
 * @returns Model string (e.g., "claude-opus", "gpt-4o")
 * @throws Error if config not found AND no fallback provided
 */
export async function get(
  configKey: string,
  sessionId: string,
  options: {
    version?: number;
    fallback?: string;
    debug?: boolean;
  } = {}
): Promise<string> {
  const { version, fallback, debug = false } = options;
  debugMode = debug;

  ensureInit();
  log(
    `get() called: configKey=${configKey}, sessionId=${sessionId}, fallback=${fallback}`
  );

  try {
    let configData = configCache.get(configKey);
    log(
      `Cache lookup for '${configKey}': ${configData ? "found" : "not found"}`
    );

    // If not in cache, try fetching (handles cold start / first call)
    if (!configData) {
      log("Not in cache, fetching...");
      await fetchConfigs(SYNC_TIMEOUT);
      configData = configCache.get(configKey);
      log(
        `After fetch, cache lookup: ${configData ? "found" : "still not found"}`
      );
    }

    if (!configData) {
      log(`Config not found, using fallback: ${fallback}`);
      if (fallback) {
        console.warn(
          `[Fallom WARNING] Config '${configKey}' not found, using fallback model: ${fallback}`
        );
        return returnModel(configKey, sessionId, fallback, 0);
      }
      throw new Error(
        `Config '${configKey}' not found. Check that it exists in your Fallom dashboard.`
      );
    }

    // Get specific version or latest
    let config: Config | undefined;
    let targetVersion: number;

    if (version !== undefined) {
      // User wants a specific version
      config = configData.versions.get(version);
      if (!config) {
        // Not in cache - try fetching it
        config =
          (await fetchSpecificVersion(configKey, version, SYNC_TIMEOUT)) ||
          undefined;
      }
      if (!config) {
        if (fallback) {
          console.warn(
            `[Fallom WARNING] Config '${configKey}' version ${version} not found, using fallback: ${fallback}`
          );
          return returnModel(configKey, sessionId, fallback, 0);
        }
        throw new Error(`Config '${configKey}' version ${version} not found.`);
      }
      targetVersion = version;
    } else {
      // Use latest (cached, zero latency)
      targetVersion = configData.latest!;
      config = configData.versions.get(targetVersion);
      if (!config) {
        if (fallback) {
          console.warn(
            `[Fallom WARNING] Config '${configKey}' has no cached version, using fallback: ${fallback}`
          );
          return returnModel(configKey, sessionId, fallback, 0);
        }
        throw new Error(`Config '${configKey}' has no cached version.`);
      }
    }

    const variantsRaw = config.variants;
    const configVersion = config.version || targetVersion;

    // Handle both list and dict formats for variants
    const variants: Variant[] = Array.isArray(variantsRaw)
      ? variantsRaw
      : Object.values(variantsRaw);

    log(
      `Config found! Version: ${configVersion}, Variants: ${JSON.stringify(
        variants
      )}`
    );

    // Deterministic assignment from session_id hash
    // Same session_id always gets same model (sticky)
    // Using 1M buckets for 0.01% granularity
    const hashBytes = createHash("md5").update(sessionId).digest();
    const hashVal = hashBytes.readUInt32BE(0) % 1_000_000;
    log(`Session hash: ${hashVal} (out of 1,000,000)`);

    // Walk through variants by weight
    let cumulative = 0;
    let assignedModel = variants[variants.length - 1].model; // Fallback to last

    for (const v of variants) {
      const oldCumulative = cumulative;
      cumulative += v.weight * 10000;
      log(
        `Variant ${v.model}: weight=${
          v.weight
        }%, range=${oldCumulative}-${cumulative}, hash=${hashVal}, match=${
          hashVal < cumulative
        }`
      );
      if (hashVal < cumulative) {
        assignedModel = v.model;
        break;
      }
    }

    log(`✅ Assigned model: ${assignedModel}`);
    return returnModel(configKey, sessionId, assignedModel, configVersion);
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      throw e; // Re-throw "not found" errors
    }
    // Any other error - return fallback if provided
    if (fallback) {
      console.warn(
        `[Fallom WARNING] Error getting model for '${configKey}': ${e}. Using fallback: ${fallback}`
      );
      return returnModel(configKey, sessionId, fallback, 0);
    }
    throw e;
  }
}

function returnModel(
  configKey: string,
  sessionId: string,
  model: string,
  version: number
): string {
  // Record session async (non-blocking)
  if (version > 0) {
    recordSession(configKey, version, sessionId, model).catch(() => {});
  }

  return model;
}

async function recordSession(
  configKey: string,
  version: number,
  sessionId: string,
  model: string
): Promise<void> {
  if (!apiKey) return;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RECORD_TIMEOUT);

    await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config_key: configKey,
        config_version: version,
        session_id: sessionId,
        assigned_model: model,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
  } catch {
    // Fail silently - never impact user's app
  }
}
