# CLAUDE.md - TypeScript SDK (@fallom/trace)

TypeScript SDK for Fallom - model A/B testing, prompt management, and tracing for LLM applications.

## Deployment Rules

**NEVER push without explicit permission.** Pushes can trigger npm publishes.

## Package Manager

**Always use `bun`:**
```bash
bun install
bun run build
bun run dev
bun test
```

## Development

```bash
bun install           # Install dependencies
bun run build         # Build CJS, ESM, and .d.ts files
bun run dev           # Watch mode for development
bun test              # Run tests
```

## Publishing

```bash
bun run publish:patch   # Bump patch version and publish to npm
bun run publish:minor   # Bump minor version
bun run publish:major   # Bump major version
```

## Architecture

The SDK uses session-based tracing with automatic instrumentation:

- **Session pattern**: Each request/conversation creates a session for tracing
- **Wrapping**: Wraps Vercel AI SDK, OpenAI, Anthropic, Google AI, Mastra
- **Zero-latency A/B testing**: Model assignment happens locally with sticky sessions
- **Concurrent-safe**: Multiple sessions can run simultaneously

## Code Style

### Keep APIs Wide

Design APIs to be flexible and accept broad inputs. Avoid overly restrictive types that force users into specific patterns.

```typescript
// Good - flexible
session.wrapOpenAI(client)

// Avoid - too narrow
session.wrapOpenAI(client, { strictMode: true, version: "v1" })
```

### DRY and Simple

- Keep code DRY - extract shared logic
- Prefer simple, readable implementations
- Files over 500 lines likely need refactoring

## Testing with Integration Tests

After making SDK changes, test against the monorepo integration tests:

```bash
# 1. Build the SDK
bun run build

# 2. Run integration tests from the monorepo
cd ../../fallom-monorepo/typescript-integration-tests
FALLOM_TEST_ENV=local doppler run -- bun test
```

Iterate on SDK changes until integration tests pass.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main entry point and exports |
| `src/session.ts` | Session management |
| `src/wrappers/` | Provider wrappers (OpenAI, Anthropic, etc.) |
| `src/models.ts` | Model A/B testing |
| `src/prompts.ts` | Prompt management |
