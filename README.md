# @fallom/trace

Model A/B testing, prompt management, and tracing for LLM applications. Zero latency, production-ready, concurrent-safe.

## Installation

```bash
npm install @fallom/trace
```

## Quick Start

```typescript
import fallom from "@fallom/trace";
import * as ai from "ai";
import { createOpenAI } from "@ai-sdk/openai";

// Initialize Fallom once
await fallom.init({ apiKey: "your-api-key" });

// Create a session for this request/conversation
const session = fallom.session({
  configKey: "my-agent",
  sessionId: "session-123",
  customerId: "user-456", // optional
});

// Wrap AI SDK - all calls are now traced!
const { generateText } = session.wrapAISDK(ai);

const response = await generateText({
  model: createOpenAI()("gpt-4o"),
  prompt: "Hello!",
});
```

## Tracing

### Vercel AI SDK

```typescript
import * as ai from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import fallom from "@fallom/trace";

await fallom.init({ apiKey: "your-api-key" });

const session = fallom.session({
  configKey: "my-agent",
  sessionId: "session-123",
});

// Option 1: Wrap the SDK (our style)
const { generateText, streamText } = session.wrapAISDK(ai);

await generateText({ model: createOpenAI()("gpt-4o"), prompt: "Hello!" });
await streamText({ model: createAnthropic()("claude-3-5-sonnet"), prompt: "Hi!" });

// Option 2: Wrap the model directly (PostHog style)
const model = session.traceModel(createOpenAI()("gpt-4o"));
await ai.generateText({ model, prompt: "Hello!" });
```

### OpenAI SDK

```typescript
import OpenAI from "openai";
import fallom from "@fallom/trace";

await fallom.init({ apiKey: "your-api-key" });

const session = fallom.session({
  configKey: "my-agent",
  sessionId: "session-123",
});

// Works with any OpenAI-compatible API (OpenRouter, Azure, LiteLLM, etc.)
const openai = session.wrapOpenAI(
  new OpenAI({
    baseURL: "https://openrouter.ai/api/v1", // optional
    apiKey: "your-provider-key",
  })
);

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Anthropic SDK

```typescript
import Anthropic from "@anthropic-ai/sdk";
import fallom from "@fallom/trace";

await fallom.init({ apiKey: "your-api-key" });

const session = fallom.session({
  configKey: "my-agent",
  sessionId: "session-123",
});

const anthropic = session.wrapAnthropic(new Anthropic());

const response = await anthropic.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Google AI (Gemini)

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";
import fallom from "@fallom/trace";

await fallom.init({ apiKey: "your-api-key" });

const session = fallom.session({
  configKey: "my-agent",
  sessionId: "session-123",
});

const genAI = new GoogleGenerativeAI(apiKey);
const model = session.wrapGoogleAI(
  genAI.getGenerativeModel({ model: "gemini-pro" })
);

const response = await model.generateContent("Hello!");
```

## Concurrent Sessions

Sessions are isolated - safe for concurrent requests:

```typescript
async function handleRequest(userId: string, conversationId: string) {
  const session = fallom.session({
    configKey: "my-agent",
    sessionId: conversationId,
    customerId: userId,
  });

  const { generateText } = session.wrapAISDK(ai);
  
  // This session's context is isolated
  return await generateText({ model: openai("gpt-4o"), prompt: "..." });
}

// Safe to run concurrently!
await Promise.all([
  handleRequest("user-1", "conv-1"),
  handleRequest("user-2", "conv-2"),
  handleRequest("user-3", "conv-3"),
]);
```

## Model A/B Testing

Run A/B tests on models with zero latency. Same session always gets same model (sticky assignment).

```typescript
const session = fallom.session({
  configKey: "summarizer",
  sessionId: "session-123",
});

// Get assigned model for this session
const model = await session.getModel({ fallback: "gpt-4o-mini" });
// Returns: "gpt-4o" or "claude-3-5-sonnet" based on your config weights

const { generateText } = session.wrapAISDK(ai);
await generateText({ model: createOpenAI()(model), prompt: "..." });
```

### Standalone Model Assignment

```typescript
import { models } from "@fallom/trace";

// Get model without creating a session
const model = await models.get("summarizer-config", sessionId, {
  fallback: "gpt-4o-mini",
});
```

## Prompt Management

Manage prompts centrally and A/B test them.

```typescript
import { prompts } from "@fallom/trace";

// Get a managed prompt (with template variables)
const prompt = await prompts.get("onboarding", {
  variables: { userName: "John", company: "Acme" },
});

// Use the prompt
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ],
});
```

### Prompt A/B Testing

```typescript
// Get prompt from A/B test (sticky assignment)
const prompt = await prompts.getAB("onboarding-test", sessionId, {
  variables: { userName: "John" },
});
```

## What Gets Traced

For each LLM call, Fallom automatically captures:
- ✅ Model name
- ✅ Duration (latency)
- ✅ Token counts (prompt, completion, total)
- ✅ Input/output content (can be disabled)
- ✅ Errors
- ✅ Config key + session ID
- ✅ Customer ID
- ✅ Time to first token (streaming)

## Configuration

### Environment Variables

```bash
FALLOM_API_KEY=your-api-key
FALLOM_TRACES_URL=https://traces.fallom.com
FALLOM_CONFIGS_URL=https://configs.fallom.com
FALLOM_PROMPTS_URL=https://prompts.fallom.com
FALLOM_CAPTURE_CONTENT=true  # set to "false" for privacy mode
```

### Privacy Mode

Disable prompt/completion capture:

```typescript
fallom.init({ captureContent: false });
```

## API Reference

### `fallom.init(options?)`

Initialize the SDK. Call once at app startup.

```typescript
await fallom.init({
  apiKey: "your-api-key",     // or FALLOM_API_KEY env var
  captureContent: true,        // capture prompts/completions
  debug: false,                // enable debug logging
});
```

### `fallom.session(options)`

Create a session-scoped tracer.

```typescript
const session = fallom.session({
  configKey: "my-agent",       // required: your config name
  sessionId: "session-123",    // required: conversation/request ID
  customerId: "user-456",      // optional: user identifier
});
```

Returns a `FallomSession` with these methods:

| Method | Description |
|--------|-------------|
| `wrapAISDK(ai)` | Wrap Vercel AI SDK |
| `wrapOpenAI(client)` | Wrap OpenAI client |
| `wrapAnthropic(client)` | Wrap Anthropic client |
| `wrapGoogleAI(model)` | Wrap Google AI model |
| `wrapMastraAgent(agent)` | Wrap Mastra agent |
| `traceModel(model)` | Wrap a model directly (PostHog style) |
| `getModel(options?)` | Get A/B tested model assignment |
| `getContext()` | Get the session context |

### `fallom.models.get(configKey, sessionId, options?)`

Get model assignment for A/B testing.

```typescript
const model = await models.get("my-config", sessionId, {
  fallback: "gpt-4o-mini",  // used if config not found
  version: 2,               // pin to specific config version
});
```

### `fallom.prompts.get(promptKey, options?)`

Get a managed prompt.

```typescript
const prompt = await prompts.get("my-prompt", {
  variables: { name: "John" },
  version: 2,  // optional: pin version
});
// Returns: { key, version, system, user }
```

### `fallom.prompts.getAB(abTestKey, sessionId, options?)`

Get a prompt from an A/B test.

```typescript
const prompt = await prompts.getAB("my-test", sessionId, {
  variables: { name: "John" },
});
// Returns: { key, version, system, user, abTestKey, variantIndex }
```

## Mastra Integration

```typescript
import { FallomExporter } from "@fallom/trace";
import { Mastra } from "@mastra/core/mastra";

const session = fallom.session({
  configKey: "my-agent",
  sessionId: "session-123",
});

const mastra = new Mastra({
  agents: { myAgent },
  telemetry: {
    serviceName: "my-agent",
    enabled: true,
    export: {
      type: "custom",
      exporter: new FallomExporter({
        session: session.getContext(),
      }),
    },
  },
});
```

## Requirements

- Node.js >= 18.0.0

Works with ESM and CommonJS. Compatible with tsx, ts-node, Bun, and compiled JavaScript.

## License

MIT
