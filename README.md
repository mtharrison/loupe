<p align="center">
  <img src="./assets/loupe-logo.svg" alt="Loupe" width="320" />
</p>

# @mtharrison/loupe

Loupe is a lightweight local tracing dashboard for LLM applications and agent systems. It captures full request and response payloads with tags and hierarchy context, then serves an inspector UI on `127.0.0.1` with no database, no containers, and no persistence.

This package is for local development. Traces live in memory and are cleared on restart.

## Why Loupe

Most tracing tools assume hosted infrastructure, persistent storage, or production telemetry. Loupe is deliberately smaller:

- local-only dashboard
- in-memory ring buffer
- full request and response visibility
- streaming chunk capture and reconstruction
- hierarchy for sessions, actors, child actors, stages, and guardrails
- cost rollups when token usage and pricing are available
- zero external services

## Installation

```sh
npm install @mtharrison/loupe
```

### Requirements

- Node.js 18 or newer

## Quick Start

Enable tracing:

```bash
export LLM_TRACE_ENABLED=1
```

Start the dashboard during app startup, then instrument a model call:

```ts
import {
  getLocalLLMTracer,
  isTraceEnabled,
  recordError,
  recordInvokeFinish,
  recordInvokeStart,
  type TraceContext,
} from '@mtharrison/loupe';

if (isTraceEnabled()) {
  await getLocalLLMTracer().startServer();
}

const context: TraceContext = {
  sessionId: 'session-123',
  rootSessionId: 'session-123',
  rootActorId: 'support-assistant',
  actorId: 'support-assistant',
  provider: 'openai',
  model: 'gpt-4.1',
  tags: {
    environment: 'local',
    feature: 'customer-support',
  },
};

const request = {
  input: {
    messages: [{ role: 'user', content: 'Summarize the latest notes.' }],
    tools: [],
  },
  options: {},
};

const traceId = recordInvokeStart(context, request);

try {
  const response = await model.invoke(request.input, request.options);
  recordInvokeFinish(traceId, response);
  return response;
} catch (error) {
  recordError(traceId, error);
  throw error;
}
```

If you do not call `startServer()` yourself, the dashboard starts lazily on the first recorded trace.

When the server starts, Loupe prints the local URL:

```text
[llm-trace] dashboard: http://127.0.0.1:4319
```

## Streaming

Streaming works the same way. Loupe records each chunk event, first-chunk latency, and the reconstructed final response.

```ts
import {
  recordError,
  recordStreamChunk,
  recordStreamFinish,
  recordStreamStart,
} from '@mtharrison/loupe';

const traceId = recordStreamStart(context, request);

try {
  for await (const chunk of model.stream(request.input, request.options)) {
    if (chunk?.type === 'finish') {
      recordStreamFinish(traceId, chunk);
    } else {
      recordStreamChunk(traceId, chunk);
    }

    yield chunk;
  }
} catch (error) {
  recordError(traceId, error);
  throw error;
}
```

## Trace Context

Loupe gets its hierarchy and filters from the context you pass to `recordInvokeStart()` and `recordStreamStart()`.

### Generic context fields

- `sessionId`
- `rootSessionId`
- `parentSessionId`
- `rootActorId`
- `actorId`
- `actorType`
- `provider`
- `model`
- `tenantId`
- `userId`
- `stage`
- `guardrailType`
- `guardrailPhase`
- `tags`

Loupe derives higher-level kinds automatically:

- `actor`
- `child-actor`
- `stage`
- `guardrail`

If you pass `guardrailType` values that start with `input` or `output`, Loupe also derives `guardrailPhase`.

### Compatibility aliases

Loupe still accepts the older project-specific field names below so existing integrations do not need to change immediately:

| Generic field | Legacy alias |
| --- | --- |
| `sessionId` | `chatId` |
| `rootSessionId` | `rootChatId` |
| `parentSessionId` | `parentChatId` |
| `rootActorId` | `topLevelAgentId` |
| `actorId` | `agentId` |
| `actorType` | `contextType` |
| `stage` | `workflowState` |
| `guardrailType` | `systemType` |
| `guardrailPhase` | `watchdogPhase` |

Loupe normalizes those aliases into the generic model before storing traces.

## What Gets Captured

Each trace stores:

- request input and options
- sanitized request headers
- final response payload
- stream chunk events and reconstructed stream output
- usage payload
- error payloads
- tags and hierarchy context
- timings and durations

Sensitive headers such as `authorization`, `api-key`, `x-api-key`, and `openai-api-key` are redacted before storage.

## Cost Tracking

Loupe calculates per-call and rolled-up cost when your model returns usage in this shape:

```ts
{
  usage: {
    tokens: {
      prompt: 123,
      completion: 456,
    },
    pricing: {
      prompt: 0.000001,
      completion: 0.000002,
    },
  },
}
```

If usage or pricing is missing, Loupe still records the trace, but cost will show as unavailable.

## Dashboard

The local dashboard includes:

- `Traces` and `Sessions` navigation
- hierarchy-aware browsing
- conversation, request, response, context, and stream views
- formatted and raw JSON modes
- cost and latency badges
- live updates over SSE
- light and dark themes

This UI is intended for local inspection, not production monitoring.

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_TRACE_ENABLED` | `false` | Enables Loupe. |
| `LLM_TRACE_HOST` | `127.0.0.1` | Host for the local dashboard server. |
| `LLM_TRACE_PORT` | `4319` | Port for the local dashboard server. |
| `LLM_TRACE_MAX_TRACES` | `1000` | Maximum number of traces kept in memory. |
| `LLM_TRACE_UI_HOT_RELOAD` | auto in local interactive dev | Enables UI rebuild + reload while developing the dashboard itself. |

Programmatic configuration is also available through `getLocalLLMTracer(config)`.

## API

The supported public API is the low-level tracer lifecycle API.

### `isTraceEnabled()`

Returns whether tracing is enabled from environment configuration.

### `getLocalLLMTracer(config?)`

Returns the singleton tracer instance. This is useful if you want to:

- start the dashboard during app startup
- override host, port, or trace retention
- access the in-memory store in tests

### `startTraceServer(config?)`

Starts the local dashboard server eagerly instead of waiting for the first trace.

### `recordInvokeStart(context, request, config?)`

Creates an `invoke` trace and returns a `traceId`.

### `recordInvokeFinish(traceId, response, config?)`

Marks an `invoke` trace as complete and stores the response payload.

### `recordStreamStart(context, request, config?)`

Creates a `stream` trace and returns a `traceId`.

### `recordStreamChunk(traceId, chunk, config?)`

Appends a non-final stream chunk to an existing trace.

### `recordStreamFinish(traceId, chunk, config?)`

Stores the final stream payload and marks the trace complete.

### `recordError(traceId, error, config?)`

Marks a trace as failed and stores a serialized error payload.

All of these functions forward to the singleton tracer returned by `getLocalLLMTracer()`.

## HTTP Endpoints

Loupe serves a small local API alongside the UI:

- `GET /`
- `GET /api/traces`
- `GET /api/traces/:id`
- `GET /api/hierarchy`
- `GET /api/events`
- `DELETE /api/traces`

## Development

The package lives in the `llm-trace/` workspace folder, even though the public package name is `@mtharrison/loupe`.

```bash
cd llm-trace
npm install
npm run build
npm test
```

Relevant directories:

- `src/` runtime, store, server, and HTML bootstrapping
- `client/src/` React dashboard
- `scripts/` UI build helpers
- `test/` package tests

## Non-Goals

Loupe is intentionally not:

- a production observability platform
- a multi-process collector
- a persistent trace database
- a hosted SaaS product

If you need long-term retention, team sharing, or production-grade telemetry, Loupe is the wrong tool.

## License

MIT.
