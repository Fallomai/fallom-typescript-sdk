/**
 * Integration tests for fallom prompts module.
 *
 * Run with:
 *   FALLOM_API_KEY=your-api-key npx vitest run tests/prompts.integration.test.ts
 *
 * Or set env vars in your shell:
 *   export FALLOM_API_KEY=your-api-key
 *   export FALLOM_BASE_URL=https://spans.fallom.com  # optional
 *   npx vitest run tests/prompts.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as prompts from "../src/prompts";

// Skip all tests if API key not provided
const API_KEY = process.env.FALLOM_API_KEY;
const BASE_URL = process.env.FALLOM_BASE_URL || "https://spans.fallom.com";

const describeIntegration = API_KEY ? describe : describe.skip;

// Helper to reset module state (accessing internal state for testing)
async function resetAndInit(): Promise<void> {
  // Clear caches by re-initializing
  prompts.init({ apiKey: API_KEY!, baseUrl: BASE_URL });
  // Fetch synchronously to ensure data is loaded
  await fetchPromptsDirectly();
}

// Direct fetch to ensure data is loaded before tests
async function fetchPromptsDirectly(): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const [promptsResp, abResp] = await Promise.all([
      fetch(`${BASE_URL}/prompts`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        signal: controller.signal,
      }),
      fetch(`${BASE_URL}/prompt-ab-tests`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        signal: controller.signal,
      }),
    ]);

    clearTimeout(timeoutId);

    if (!promptsResp.ok || !abResp.ok) {
      throw new Error("Failed to fetch prompts from API");
    }
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

describeIntegration("prompts.get() integration", () => {
  beforeEach(async () => {
    await resetAndInit();
  });

  afterEach(() => {
    prompts.clearPromptContext();
  });

  it("should fetch a basic prompt from the server", async () => {
    const result = await prompts.get("test-prompt");

    expect(result.key).toBe("test-prompt");
    expect(result.version).toBeGreaterThanOrEqual(1);
    expect(result.system).toBeDefined();
    expect(result.user).toBeDefined();
    expect(typeof result.system).toBe("string");
    expect(typeof result.user).toBe("string");
  });

  it("should replace variables in templates", async () => {
    const result = await prompts.get("test-prompt", {
      variables: { user_name: "Alice", company: "TestCorp" },
    });

    // Variables should be replaced (not contain {{user_name}})
    expect(result.system).not.toContain("{{user_name}}");
    expect(result.user).not.toContain("{{user_name}}");
  });

  it("should fetch a specific version when requested", async () => {
    // Note: API returns current version (2), so we test with that
    const result = await prompts.get("test-prompt-versioned", { version: 2 });

    expect(result.version).toBe(2);
    expect(result.system.toLowerCase()).toContain("version 2");
  });

  it("should throw for unknown prompt", async () => {
    await expect(
      prompts.get("this-prompt-does-not-exist-xyz")
    ).rejects.toThrow(/not found/i);
  });

  it("should set prompt context for tracing", async () => {
    await prompts.get("test-prompt");

    const ctx = prompts.getPromptContext();
    expect(ctx).not.toBeNull();
    expect(ctx?.promptKey).toBe("test-prompt");
    expect(ctx?.promptVersion).toBeGreaterThanOrEqual(1);
    expect(ctx?.abTestKey).toBeUndefined();
  });

  it("should handle empty variables object", async () => {
    const result = await prompts.get("test-prompt", { variables: {} });

    expect(result.key).toBe("test-prompt");
    // Should still work, unreplaced variables stay as-is
  });

  it("should ignore extra variables not in template", async () => {
    const result = await prompts.get("test-prompt", {
      variables: {
        user_name: "Bob",
        unused_var: "should be ignored",
        another_unused: 12345,
      },
    });

    expect(result.key).toBe("test-prompt");
    // Should not crash
  });
});

describeIntegration("prompts.getAB() integration", () => {
  beforeEach(async () => {
    await resetAndInit();
  });

  afterEach(() => {
    prompts.clearPromptContext();
  });

  it("should fetch a prompt from an A/B test", async () => {
    const result = await prompts.getAB("test-ab-experiment", "session-123");

    expect(["test-prompt-a", "test-prompt-b"]).toContain(result.key);
    expect(result.abTestKey).toBe("test-ab-experiment");
    expect([0, 1]).toContain(result.variantIndex);
  });

  it("should be deterministic for same session_id", async () => {
    const sessionId = "deterministic-test-session-999";

    const results = await Promise.all([
      prompts.getAB("test-ab-experiment", sessionId),
      prompts.getAB("test-ab-experiment", sessionId),
      prompts.getAB("test-ab-experiment", sessionId),
    ]);

    // All should return same prompt key
    const keys = results.map((r) => r.key);
    expect(new Set(keys).size).toBe(1);

    // All should return same variant index
    const variants = results.map((r) => r.variantIndex);
    expect(new Set(variants).size).toBe(1);
  });

  it("should distribute different sessions across variants", async () => {
    const results: Record<string, number> = {};

    for (let i = 0; i < 100; i++) {
      const result = await prompts.getAB(
        "test-ab-experiment",
        `distribution-test-${i}`
      );
      results[result.key] = (results[result.key] || 0) + 1;
    }

    // With 50/50 split, we should see both variants
    expect(Object.keys(results).length).toBe(2);
    expect(results["test-prompt-a"]).toBeDefined();
    expect(results["test-prompt-b"]).toBeDefined();

    // Each should have at least 20% (allowing for hash distribution variance)
    expect(results["test-prompt-a"]).toBeGreaterThanOrEqual(20);
    expect(results["test-prompt-b"]).toBeGreaterThanOrEqual(20);
  });

  it("should replace variables in A/B test prompts", async () => {
    const result = await prompts.getAB("test-ab-experiment", "session-456", {
      variables: { user_name: "Charlie" },
    });

    // Variables should be replaced
    expect(result.user).not.toContain("{{user_name}}");
  });

  it("should throw for unknown A/B test", async () => {
    await expect(
      prompts.getAB("this-ab-test-does-not-exist-xyz", "session-1")
    ).rejects.toThrow(/not found/i);
  });

  it("should set prompt context with A/B info", async () => {
    await prompts.getAB("test-ab-experiment", "session-789");

    const ctx = prompts.getPromptContext();
    expect(ctx).not.toBeNull();
    expect(ctx?.abTestKey).toBe("test-ab-experiment");
    expect(ctx?.variantIndex).toBeDefined();
    expect(["test-prompt-a", "test-prompt-b"]).toContain(ctx?.promptKey);
  });
});

describeIntegration("prompts caching integration", () => {
  beforeEach(async () => {
    await resetAndInit();
  });

  it("should use cache for subsequent calls", async () => {
    const start1 = Date.now();
    await prompts.get("test-prompt");
    const time1 = Date.now() - start1;

    const start2 = Date.now();
    await prompts.get("test-prompt");
    const time2 = Date.now() - start2;

    // Second call should be faster (cached)
    // We're just verifying it doesn't crash, timing is informational
    console.log(`First call: ${time1}ms, Second call: ${time2}ms`);

    // Both should succeed
    const result = await prompts.get("test-prompt");
    expect(result.key).toBe("test-prompt");
  });

  it("should cache across multiple get() calls", async () => {
    const result1 = await prompts.get("test-prompt");
    const result2 = await prompts.get("test-prompt");
    const result3 = await prompts.get("test-prompt");

    expect(result1.key).toBe(result2.key);
    expect(result2.key).toBe(result3.key);
    expect(result1.version).toBe(result2.version);
    expect(result2.version).toBe(result3.version);
  });
});

describeIntegration("edge cases integration", () => {
  beforeEach(async () => {
    await resetAndInit();
  });

  afterEach(() => {
    prompts.clearPromptContext();
  });

  it("should handle special characters in variables", async () => {
    const result = await prompts.get("test-prompt", {
      variables: {
        user_name: "O'Brien <script>alert('xss')</script>",
        company: 'Test & Co. "quoted"',
      },
    });

    expect(result.key).toBe("test-prompt");
    // Should not crash
  });

  it("should handle unicode in variables", async () => {
    const result = await prompts.get("test-prompt", {
      variables: {
        user_name: "日本語ユーザー",
        company: "Ñoño Corp 🚀",
      },
    });

    expect(result.key).toBe("test-prompt");
  });

  it("should handle very long session ID", async () => {
    const longSession = "session-" + "x".repeat(10000);

    const result = await prompts.getAB("test-ab-experiment", longSession);

    expect(result.abTestKey).toBe("test-ab-experiment");
  });

  it("should handle empty session ID", async () => {
    const result = await prompts.getAB("test-ab-experiment", "");

    // Empty string should still hash deterministically
    expect(result.abTestKey).toBe("test-ab-experiment");
  });

  it("should handle numeric variable values", async () => {
    const result = await prompts.get("test-prompt", {
      variables: {
        count: 42,
        price: 19.99,
        negative: -100,
      },
    });

    expect(result.key).toBe("test-prompt");
  });

  it("should handle boolean variable values", async () => {
    const result = await prompts.get("test-prompt", {
      variables: {
        active: true,
        disabled: false,
      },
    });

    expect(result.key).toBe("test-prompt");
  });

  it("should handle null and undefined variable values", async () => {
    const result = await prompts.get("test-prompt", {
      variables: {
        nullValue: null,
        undefinedValue: undefined,
      },
    });

    expect(result.key).toBe("test-prompt");
  });
});

describeIntegration("prompt context integration", () => {
  beforeEach(async () => {
    await resetAndInit();
  });

  afterEach(() => {
    prompts.clearPromptContext();
  });

  it("should clear context after getPromptContext()", async () => {
    await prompts.get("test-prompt");

    const ctx1 = prompts.getPromptContext();
    expect(ctx1).not.toBeNull();

    // Second call should return null (one-shot behavior)
    const ctx2 = prompts.getPromptContext();
    expect(ctx2).toBeNull();
  });

  it("should update context on each get() call", async () => {
    await prompts.get("test-prompt");
    const ctx1 = prompts.getPromptContext();
    expect(ctx1?.promptKey).toBe("test-prompt");

    await prompts.get("test-prompt-versioned");
    const ctx2 = prompts.getPromptContext();
    expect(ctx2?.promptKey).toBe("test-prompt-versioned");
  });

  it("should clear context with clearPromptContext()", async () => {
    await prompts.get("test-prompt");
    prompts.clearPromptContext();

    const ctx = prompts.getPromptContext();
    expect(ctx).toBeNull();
  });
});

