'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const http = require('node:http');

const {
  __resetLocalLLMTracerForTests,
  addSpanEvent,
  endSpan,
  getLocalLLMTracer,
  recordException,
  startSpan,
  startTraceServer,
  wrapChatModel,
  wrapOpenAIClient,
} = require('../dist/index.js');
const {
  deriveSessionNavItems,
  getDefaultExpandedSessionTreeNodeIds,
  resolveSessionTreeSelection,
  sortSessionNodesForNav,
} = require('../dist/session-nav.js');
const { runFullyFeaturedExample } = require('../examples/fully-featured.js');
const { createTraceServer } = require('../dist/server.js');
const { TraceStore } = require('../dist/store.js');

let nextPort = 4500;

function reservePort() {
  nextPort += 1;
  return nextPort;
}

async function listenOnPort(port, host = '127.0.0.1') {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return server;
}

function buildSessionTreeFixture() {
  return [
    {
      children: [
        {
          children: [
            {
              children: [],
              count: 1,
              id: 'trace:trace-stage',
              meta: { traceId: 'trace-stage' },
              traceIds: ['trace-stage'],
              type: 'trace',
            },
          ],
          count: 2,
          id: 'trace:trace-root',
          meta: { traceId: 'trace-root' },
          traceIds: ['trace-stage', 'trace-root'],
          type: 'trace',
        },
      ],
      count: 2,
      id: 'session:s1-newer',
      meta: { costUsd: 0.004, rootActorId: 'assistant', sessionId: 's1-newer' },
      traceIds: ['trace-stage', 'trace-root'],
      type: 'session',
    },
    {
      children: [
        {
          children: [],
          count: 1,
          id: 'trace:trace-older',
          meta: { traceId: 'trace-older' },
          traceIds: ['trace-older'],
          type: 'trace',
        },
      ],
      count: 1,
      id: 'session:s2-older',
      meta: { costUsd: 0.002, rootActorId: 'reviewer', sessionId: 's2-older' },
      traceIds: ['trace-older'],
      type: 'session',
    },
  ];
}

afterEach(() => {
  __resetLocalLLMTracerForTests();
  delete process.env.LLM_TRACE_ENABLED;
  delete process.env.LOUPE_OPEN_BROWSER;
  delete process.env.LLM_TRACE_PORT;
  delete process.env.LLM_TRACE_UI_HOT_RELOAD;
  delete process.env.CI;
  delete process.env.NODE_ENV;
});

test('OpenTelemetry-style span lifecycle exports record traces through the singleton tracer', async () => {
  process.env.LLM_TRACE_ENABLED = '1';
  const port = reservePort();
  const tracer = getLocalLLMTracer({ maxTraces: 10, port });
  tracer.store.clear();

  await startTraceServer({ port });

   const invokeSpanId = startSpan(
     { sessionId: 'session-low-level', rootActorId: 'root', actorId: 'root', provider: 'openai', model: 'gpt-4.1' },
     { mode: 'invoke', name: 'openai.chat.completions', request: { input: { messages: [{ role: 'user', content: 'hello' }] }, options: {} } },
   );
   endSpan(invokeSpanId, {
     message: { role: 'assistant', content: 'world' },
     tool_calls: [],
     usage: { tokens: { prompt: 1, completion: 2 }, pricing: { prompt: 0.1, completion: 0.2 } },
   });

   const streamSpanId = startSpan(
     { sessionId: 'session-low-level', rootActorId: 'root', actorId: 'root', provider: 'openai', model: 'gpt-4.1' },
     { mode: 'stream', name: 'openai.chat.completions', request: { input: { messages: [{ role: 'user', content: 'stream' }] }, options: {} } },
   );
   addSpanEvent(streamSpanId, { name: 'stream.begin', attributes: { role: 'assistant' } });
   addSpanEvent(streamSpanId, { name: 'stream.chunk', attributes: { content: 'abc' } });
   endSpan(streamSpanId, {
     type: 'finish',
     message: { role: 'assistant', content: 'abc' },
     tool_calls: [],
     usage: { tokens: { prompt: 2, completion: 3 }, pricing: { prompt: 0.01, completion: 0.02 } },
   });

   const errorSpanId = startSpan(
     { sessionId: 'session-low-level', rootActorId: 'root', actorId: 'root' },
     { mode: 'invoke', name: 'llm.invoke', request: { input: { messages: [] }, options: {} } },
   );
   recordException(errorSpanId, new Error('boom'));

   const traces = tracer.store.list().items;
   assert.equal(traces.length, 3);
   assert.equal(traces[0].status, 'error');
   assert.equal(traces[1].mode, 'stream');
   assert.equal(traces[2].mode, 'invoke');

   const span = tracer.store.get(traces[1].id);
   assert.equal(span.name, 'openai.chat.completions');
   assert.equal(span.spanKind, 'CLIENT');
   assert.equal(span.spanStatus.code, 'OK');
   assert.equal(span.attributes['gen_ai.request.model'], 'gpt-4.1');
   assert.equal(span.attributes['gen_ai.system'], 'openai');
   assert.equal(span.attributes['gen_ai.provider.name'], 'openai');
   assert.equal(span.attributes['gen_ai.operation.name'], 'chat');
   assert.equal(span.attributes['gen_ai.usage.input_tokens'], 2);
   assert.equal(span.attributes['gen_ai.usage.output_tokens'], 3);
   assert.equal(span.events[0].name, 'stream.begin');
   assert.equal(span.events[0].attributes['gen_ai.message.status'], 'in_progress');
   assert.equal(span.events[1].attributes.content, 'abc');
   assert.match(span.spanContext.traceId, /^[0-9a-f]{32}$/);
   assert.match(span.spanContext.spanId, /^[0-9a-f]{16}$/);
   assert.equal(Buffer.from(span.spanContext.traceId, 'hex').length, 16);
   assert.equal(Buffer.from(span.spanContext.spanId, 'hex').length, 8);
   assert.equal(Buffer.from(span.spanContext.traceId, 'hex').toString('hex'), span.spanContext.traceId);
   assert.equal(Buffer.from(span.spanContext.spanId, 'hex').toString('hex'), span.spanContext.spanId);
});

test('ring buffer evicts the oldest traces', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 2 });
  tracer.store.clear();
  tracer.store.maxTraces = 2;

  const one = tracer.startSpan({ sessionId: 'session-1', actorId: 'actor-a' }, { mode: 'invoke', request: { input: { messages: [] }, options: {} } });
  tracer.endSpan(one, { message: { role: 'assistant', content: 'one' }, tool_calls: [], usage: {} });
  const two = tracer.startSpan({ sessionId: 'session-1', actorId: 'actor-b' }, { mode: 'invoke', request: { input: { messages: [] }, options: {} } });
  tracer.endSpan(two, { message: { role: 'assistant', content: 'two' }, tool_calls: [], usage: {} });
  const three = tracer.startSpan({ sessionId: 'session-1', actorId: 'actor-c' }, { mode: 'invoke', request: { input: { messages: [] }, options: {} } });
  tracer.endSpan(three, { message: { role: 'assistant', content: 'three' }, tool_calls: [], usage: {} });

  assert.equal(tracer.store.get(one), null);
  assert.ok(tracer.store.get(two));
  assert.ok(tracer.store.get(three));
});

test('NODE_ENV=development enables tracing implicitly', async () => {
  process.env.NODE_ENV = 'development';
  process.env.LOUPE_OPEN_BROWSER = '0';
  const port = reservePort();
  const tracer = getLocalLLMTracer({ maxTraces: 10, port });
  tracer.store.clear();

  const spanId = startSpan(
    { sessionId: 'implicit-dev-enable', actorId: 'actor-a' },
    { mode: 'invoke', request: { input: { messages: [] }, options: {} } },
    { port },
  );
  endSpan(spanId, { message: { role: 'assistant', content: 'ok' }, tool_calls: [], usage: {} }, { port });

  const traces = tracer.store.list().items;
  assert.equal(traces.length, 1);
  assert.equal(traces[0].status, 'ok');
});

test('NODE_ENV=development opens the dashboard automatically when the tracer is created', async () => {
  process.env.NODE_ENV = 'development';
  const originalIsTTY = process.stdout.isTTY;
  const originalSpawn = childProcess.spawn;
  const calls = [];
  process.stdout.isTTY = true;
  childProcess.spawn = (command, args, options) => {
    calls.push({ args, command, options });
    return {
      on() {},
      unref() {},
    };
  };

  try {
    const port = reservePort();
    const tracer = getLocalLLMTracer({ maxTraces: 10, port, uiHotReload: false });
    await tracer.startServer();

    assert.equal(calls.length, 1);
    assert.match(calls[0].args.at(-1), new RegExp(`^http://127\\.0\\.0\\.1:${port}$`));
  } finally {
    process.stdout.isTTY = originalIsTTY;
    childProcess.spawn = originalSpawn;
  }
});

test('nested wrapped model calls create child spans on the same trace', async () => {
  process.env.LLM_TRACE_ENABLED = '1';
  const port = reservePort();
  const tracer = getLocalLLMTracer({ maxTraces: 10, port });
  tracer.store.clear();

  const innerModel = wrapChatModel(
    {
      async invoke(input) {
        return {
          message: { role: 'assistant', content: `inner:${input.messages[0].content}` },
          tool_calls: [],
          usage: { tokens: { prompt: 1, completion: 1 }, pricing: { prompt: 0.1, completion: 0.2 } },
        };
      },
      async *stream() {},
    },
    () => ({ sessionId: 'nested-session', rootActorId: 'assistant', actorId: 'tool-worker', provider: 'openai', model: 'gpt-4.1-mini' }),
    { port },
  );

  const outerModel = wrapChatModel(
    {
      async invoke(input) {
        await innerModel.invoke({ messages: [{ role: 'user', content: 'tool step' }] }, {});
        return {
          message: { role: 'assistant', content: `outer:${input.messages[0].content}` },
          tool_calls: [],
          usage: { tokens: { prompt: 2, completion: 2 }, pricing: { prompt: 0.1, completion: 0.2 } },
        };
      },
      async *stream() {},
    },
    () => ({ sessionId: 'nested-session', rootActorId: 'assistant', actorId: 'assistant', provider: 'openai', model: 'gpt-4.1' }),
    { port },
  );

  await outerModel.invoke({ messages: [{ role: 'user', content: 'outer step' }] }, {});

  const traces = tracer.store.list().items;
  assert.equal(traces.length, 2);
  const outer = tracer.store.get(traces.find((item) => item.model === 'gpt-4.1').id);
  const inner = tracer.store.get(traces.find((item) => item.model === 'gpt-4.1-mini').id);
  assert.equal(inner.parentSpanId, outer.spanContext.spanId);
  assert.equal(inner.spanContext.traceId, outer.spanContext.traceId);
});

test('fully featured example records guardrails, nested spans, errors, and streaming in one session', async () => {
  process.env.LLM_TRACE_ENABLED = '1';
  process.env.LLM_TRACE_PORT = String(reservePort());
  const port = Number(process.env.LLM_TRACE_PORT);

  const tracer = getLocalLLMTracer({ maxTraces: 20, port });
  tracer.store.clear();

  const result = await runFullyFeaturedExample({
    destination: 'Lisbon',
    keepAlive: false,
    openBrowser: false,
    port,
    sessionId: 'fully-featured-test',
  });

  assert.equal(result.sessionId, 'fully-featured-test');
  assert.equal(result.traceCount, 7);
  assert.match(result.invokeReply, /Day 1: start in Baixa and Chiado/);
  assert.match(result.streamReply, /Day 1 in Lisbon/);

  const items = tracer.store.list().items;
  assert.equal(items.length, 7);

  const traces = items.map((item) => tracer.store.get(item.id));
  assert.ok(traces.every((trace) => trace.hierarchy.sessionId === 'fully-featured-test'));
  assert.ok(traces.every((trace) => trace.tags.example === 'fully-featured'));

  const rootInvoke = traces.find((trace) => trace.name === 'llm.invoke' && trace.model === 'trip-planner-v2' && trace.kind === 'actor');
  const rootStream = traces.find((trace) => trace.name === 'llm.stream' && trace.model === 'trip-planner-v2');
  const childInvoke = traces.find((trace) => trace.name === 'llm.invoke' && trace.model === 'city-researcher-v1');
  const researchStage = traces.find((trace) => trace.name === 'workflow.research');
  const inputGuardrail = traces.find((trace) => trace.name === 'guardrail.input');
  const outputGuardrail = traces.find((trace) => trace.name === 'guardrail.output');
  const availabilityError = traces.find((trace) => trace.name === 'tool.availability-check');

  assert.ok(rootInvoke);
  assert.ok(rootStream);
  assert.ok(childInvoke);
  assert.ok(researchStage);
  assert.ok(inputGuardrail);
  assert.ok(outputGuardrail);
  assert.ok(availabilityError);

  assert.equal(childInvoke.parentSpanId, rootInvoke.spanContext.spanId);
  assert.equal(researchStage.parentSpanId, rootInvoke.spanContext.spanId);
  assert.equal(outputGuardrail.parentSpanId, rootInvoke.spanContext.spanId);
  assert.equal(researchStage.kind, 'stage');
  assert.equal(inputGuardrail.kind, 'guardrail');
  assert.equal(inputGuardrail.hierarchy.guardrailPhase, 'input');
  assert.equal(outputGuardrail.hierarchy.guardrailPhase, 'output');
  assert.equal(availabilityError.status, 'error');
  assert.equal(availabilityError.error.code, 'SUPPLIER_TIMEOUT');
  assert.equal(rootStream.stream.chunkCount, 3);
  assert.equal(rootStream.stream.reconstructed.message.content, result.streamReply);
  assert.equal(rootInvoke.usage.tokens.prompt, 42);
  assert.equal(rootInvoke.usage.tokens.completion, 68);
  assert.equal(rootStream.usage.tokens.prompt, 24);
  assert.equal(rootStream.usage.tokens.completion, 39);
});

test('hierarchy nests spans by OpenTelemetry parent span id within each session', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 10 });
  tracer.store.clear();
  const usage = { tokens: { prompt: 100, completion: 50 }, pricing: { prompt: 0.000001, completion: 0.000002 } };
  const expectedCost = 0.0002;

  const root = tracer.startSpan(
    { sessionId: 'session-1', rootSessionId: 'session-1', rootActorId: 'root-actor', actorId: 'root-actor', model: 'gpt-4.1' },
    { mode: 'invoke', request: { input: { messages: [] }, options: {} } },
  );
  tracer.endSpan(root, { message: { role: 'assistant', content: 'root' }, tool_calls: [], usage });

  const rootSpan = tracer.store.get(root);
  assert.ok(rootSpan);

  const delegated = tracer.startSpan(
    { sessionId: 'session-1', rootSessionId: 'session-1', rootActorId: 'root-actor', actorId: 'child-actor', model: 'gpt-4.1' },
    { mode: 'invoke', parentSpanId: rootSpan.spanContext.spanId, request: { input: { messages: [] }, options: {} } },
  );
  tracer.endSpan(delegated, { message: { role: 'assistant', content: 'delegated' }, tool_calls: [], usage });

  const workflow = tracer.startSpan(
    {
      sessionId: 'session-1',
      rootSessionId: 'session-1',
      rootActorId: 'root-actor',
      actorId: 'root-actor',
      stage: 'triage',
      model: 'gpt-4.1',
    },
    { mode: 'invoke', parentSpanId: delegated, request: { input: { messages: [] }, options: {} } },
  );
  tracer.endSpan(workflow, { message: { role: 'assistant', content: 'workflow' }, tool_calls: [], usage });

  const guardrail = tracer.startSpan(
    {
      sessionId: 'session-1',
      rootSessionId: 'session-1',
      rootActorId: 'root-actor',
      actorId: 'output-guardrail',
      guardrailType: 'outputPolicyCheck',
      model: 'gpt-4.1',
    },
    { mode: 'invoke', parentSpanId: rootSpan.spanContext.spanId, request: { input: { messages: [] }, options: {} } },
  );
  tracer.endSpan(guardrail, { message: { role: 'assistant', content: 'guardrail' }, tool_calls: [], usage });

  const tree = tracer.store.hierarchy();
  assert.equal(tree.rootNodes.length, 1);
  const session = tree.rootNodes[0];
  assert.equal(session.type, 'session');
  assert.equal(session.meta.costUsd, expectedCost * 4);
  assert.equal(session.children.length, 1);
  const rootNode = session.children[0];
  assert.equal(rootNode.type, 'trace');
  assert.equal(rootNode.meta.traceId, root);
  assert.equal(rootNode.meta.costUsd, expectedCost * 4);
  assert.equal(rootNode.children.length, 2);

  const delegatedNode = rootNode.children.find((node) => node.meta.traceId === delegated);
  assert.ok(delegatedNode);
  assert.equal(delegatedNode.meta.costUsd, expectedCost * 2);
  assert.equal(delegatedNode.children.length, 1);
  assert.equal(delegatedNode.children[0].meta.traceId, workflow);

  const guardrailNode = rootNode.children.find((node) => node.meta.traceId === guardrail);
  assert.ok(guardrailNode);
  assert.equal(guardrailNode.meta.costUsd, expectedCost);
  assert.deepEqual(
    rootNode.children.map((node) => node.type),
    ['trace', 'trace'],
  );
});

test('legacy context aliases still normalize into the generic hierarchy model', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 10 });
  tracer.store.clear();

  const traceId = tracer.startSpan(
    {
      chatId: 'chat-legacy',
      rootChatId: 'chat-legacy',
      topLevelAgentId: 'root-agent',
      agentId: 'child-agent',
      workflowState: 'triage',
      systemType: 'outputFilterStopBot',
    },
    { mode: 'invoke', request: { input: { messages: [] }, options: {} } },
  );
  tracer.endSpan(traceId, { message: { role: 'assistant', content: 'done' }, tool_calls: [], usage: {} });

  const trace = tracer.store.get(traceId);
  assert.ok(trace);
  assert.equal(trace.context.sessionId, 'chat-legacy');
  assert.equal(trace.context.rootActorId, 'root-agent');
  assert.equal(trace.context.actorId, 'child-agent');
  assert.equal(trace.context.stage, 'triage');
  assert.equal(trace.context.guardrailType, 'outputFilterStopBot');
  assert.equal(trace.context.guardrailPhase, 'output');
  assert.equal(trace.hierarchy.sessionId, 'chat-legacy');
  assert.equal(trace.hierarchy.rootActorId, 'root-agent');
});

test('generic guardrail metadata does not hide delegated agents', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 10 });
  tracer.store.clear();

  const traceId = tracer.startSpan(
    {
      sessionId: 'session-subagent',
      rootSessionId: 'session-subagent',
      rootActorId: 'assistant',
      actorId: 'searchKnowledgeBase',
      guardrailType: 'guardrail',
      model: 'gpt-4.1',
    },
    { mode: 'invoke', request: { input: { messages: [] }, options: {} } },
  );
  tracer.endSpan(traceId, { message: { role: 'assistant', content: 'done' }, tool_calls: [], usage: {} });

  const trace = tracer.store.get(traceId);
  assert.ok(trace);
  assert.equal(trace.kind, 'child-actor');
  assert.equal(trace.hierarchy.childActorId, 'searchKnowledgeBase');
  assert.equal(trace.hierarchy.guardrailType, 'guardrail');
});

test('gen_ai.conversation.id overrides the session identifier used for hierarchy', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 10 });
  tracer.store.clear();

  const traceId = tracer.startSpan(
    { sessionId: 'context-session', rootActorId: 'assistant', actorId: 'assistant' },
    {
      attributes: { 'gen_ai.conversation.id': 'otel-session' },
      mode: 'invoke',
      request: { input: { messages: [] }, options: {} },
    },
  );
  tracer.endSpan(traceId, { message: { role: 'assistant', content: 'done' }, tool_calls: [], usage: {} });

  const trace = tracer.store.get(traceId);
  assert.ok(trace);
  assert.equal(trace.attributes['gen_ai.conversation.id'], 'otel-session');
  assert.equal(trace.context.sessionId, 'otel-session');
  assert.equal(trace.hierarchy.sessionId, 'otel-session');

  const tree = tracer.store.hierarchy();
  assert.equal(tree.rootNodes.length, 1);
  assert.equal(tree.rootNodes[0].id, 'session:otel-session');
  assert.equal(tree.rootNodes[0].meta.sessionId, 'otel-session');
});

test('derived insights surface structured input and guardrail context', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 10 });
  tracer.store.clear();

  const traceId = tracer.startSpan(
    {
      sessionId: 'session-insights',
      rootSessionId: 'session-insights',
      rootActorId: 'translator',
      actorId: 'output-guardrail',
      guardrailPhase: 'output',
      guardrailType: 'outputPolicyCheck',
      systemType: 'outputPolicyCheck',
      model: 'gpt-4.1',
      provider: 'openai',
    },
    {
      mode: 'invoke',
      request: {
        input: {
          messages: [
            {
              role: 'system',
              content: 'You are a translation assistant. '.repeat(80),
            },
            {
              role: 'user',
              content:
                '<user><instruction priority="high">Translate carefully.</instruction><option tone="formal">Formal</option></user>',
            },
          ],
        },
        options: {},
      },
    },
  );
  tracer.endSpan(traceId, {
    message: { role: 'assistant', content: 'Translated.' },
    tool_calls: [],
    usage: {},
  });

  const trace = tracer.store.get(traceId);
  assert.ok(trace);
  assert.ok(trace.insights);
  assert.equal(trace.insights.structuredInputs.length, 1);
  assert.deepEqual(trace.insights.structuredInputs[0].tags.slice(0, 3), ['user', 'instruction', 'option']);
  assert.ok(trace.insights.highlights.some((item) => item.kind === 'structured-input'));
  assert.ok(trace.insights.highlights.some((item) => item.kind === 'long-message'));
  assert.ok(trace.insights.highlights.some((item) => item.kind === 'guardrail-context'));

  const summary = tracer.store.list().items[0];
  assert.deepEqual(summary.flags, {
    hasHighlights: true,
    hasStructuredInput: true,
  });
});

test('session nav items sort by latest activity and aggregate status metadata', async () => {
  const sessionNodes = [
    {
      children: [
        { children: [], count: 1, id: 'trace:trace-pending', meta: { traceId: 'trace-pending' }, traceIds: ['trace-pending'], type: 'trace' },
        { children: [], count: 1, id: 'trace:trace-ok', meta: { traceId: 'trace-ok' }, traceIds: ['trace-ok'], type: 'trace' },
      ],
      count: 2,
      id: 'session:b8cf8aa5-newest',
      meta: { costUsd: 0.0072, rootActorId: 'globalDefault', sessionId: 'b8cf8aa5-newest' },
      traceIds: ['trace-pending', 'trace-ok'],
      type: 'session',
    },
    {
      children: [{ children: [], count: 1, id: 'trace:trace-error', meta: { traceId: 'trace-error' }, traceIds: ['trace-error'], type: 'trace' }],
      count: 1,
      id: 'session:d1e2f3a4-error',
      meta: { costUsd: 0.0025, rootActorId: 'reviewer', sessionId: 'd1e2f3a4-error' },
      traceIds: ['trace-error'],
      type: 'session',
    },
    {
      children: [],
      count: 1,
      id: 'session:e9f0a1b2-missing',
      meta: { costUsd: 0.0011, sessionId: 'e9f0a1b2-missing' },
      traceIds: ['trace-missing'],
      type: 'session',
    },
  ];
  const traceById = new Map([
    [
      'trace-ok',
      {
        costUsd: 0.003,
        flags: { hasHighlights: false },
        hierarchy: { rootActorId: 'globalDefault', sessionId: 'b8cf8aa5-newest' },
        id: 'trace-ok',
        startedAt: '2026-03-14T08:44:00.000Z',
        status: 'ok',
      },
    ],
    [
      'trace-pending',
      {
        costUsd: 0.0042,
        flags: { hasHighlights: true },
        hierarchy: { rootActorId: 'globalDefault', sessionId: 'b8cf8aa5-newest' },
        id: 'trace-pending',
        startedAt: '2026-03-14T08:46:00.000Z',
        status: 'pending',
      },
    ],
    [
      'trace-error',
      {
        costUsd: 0.0025,
        flags: { hasHighlights: false },
        hierarchy: { rootActorId: 'reviewer', sessionId: 'd1e2f3a4-error' },
        id: 'trace-error',
        startedAt: '2026-03-14T08:45:00.000Z',
        status: 'error',
      },
    ],
  ]);

  const items = deriveSessionNavItems(sessionNodes, traceById);
  const sortedNodes = sortSessionNodesForNav(sessionNodes, traceById);

  assert.deepEqual(
    items.map((item) => item.id),
    ['session:b8cf8aa5-newest', 'session:d1e2f3a4-error', 'session:e9f0a1b2-missing'],
  );
  assert.deepEqual(
    sortedNodes.map((node) => node.id),
    items.map((item) => item.id),
  );
  assert.equal(items[0].primaryLabel, 'globalDefault');
  assert.equal(items[0].status, 'pending');
  assert.equal(items[0].hasHighlights, true);
  assert.equal(items[0].callCount, 2);
  assert.equal(items[0].costUsd, 0.0072);
  assert.equal(items[0].shortSessionId, 'b8cf8aa5');
  assert.ok(items[0].latestTimestamp);

  assert.equal(items[1].status, 'error');
  assert.equal(items[1].primaryLabel, 'reviewer');

  assert.equal(items[2].primaryLabel, 'e9f0a1b2');
  assert.equal(items[2].shortSessionId, 'e9f0a1b2');
});

test('session tree selection keeps the selected structure node and falls back to its newest descendant trace', async () => {
  const sessionNodes = buildSessionTreeFixture();

  const selection = resolveSessionTreeSelection(
    sessionNodes,
    'session:s1-newer',
    'missing-trace',
  );

  assert.deepEqual(selection, {
    selectedNodeId: 'session:s1-newer',
    selectedTraceId: 'trace-stage',
  });
});

test('session tree selection falls back to the first visible session when the previous session is filtered out', async () => {
  const sessionNodes = buildSessionTreeFixture().slice(1);

  const selection = resolveSessionTreeSelection(
    sessionNodes,
    'session:s1-newer',
    'trace-root',
  );

  assert.deepEqual(selection, {
    selectedNodeId: 'session:s2-older',
    selectedTraceId: 'trace-older',
  });
});

test('default session tree expansion opens only the active session and its selected path', async () => {
  const sessionNodes = buildSessionTreeFixture();

  const expanded = getDefaultExpandedSessionTreeNodeIds(
    sessionNodes,
    'session:s1-newer',
    'session:s1-newer',
    'trace-stage',
  );

  assert.deepEqual(
    [...expanded].sort(),
    [
      'session:s1-newer',
      'trace:trace-root',
    ].sort(),
  );
  assert.equal(expanded.has('session:s2-older'), false);
  assert.equal(expanded.has('trace:trace-older'), false);
});

test('SSE emits span lifecycle events', async () => {
  process.env.LLM_TRACE_ENABLED = '1';
  process.env.LLM_TRACE_PORT = String(reservePort());
  const port = Number(process.env.LLM_TRACE_PORT);

  const tracer = getLocalLLMTracer({ maxTraces: 10, port });
  tracer.store.clear();
  await tracer.startServer();

  const chunks = [];
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' });

    req.on('response', (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        chunks.push(chunk);
        if (chunks.join('').includes('"type":"span:end"')) {
          res.destroy();
          resolve();
        }
      });

      setTimeout(() => {
        const traceId = tracer.startSpan(
          { sessionId: 'session-2', actorId: 'actor-a' },
          { mode: 'invoke', request: { input: { messages: [] }, options: {} } },
        );
        tracer.endSpan(traceId, { message: { role: 'assistant', content: 'done' }, tool_calls: [], usage: {} });
      }, 25);
    });

    req.on('error', reject);
    req.end();
  });

  assert.ok(chunks.join('').includes('"type":"span:start"'));
  assert.ok(chunks.join('').includes('"type":"span:end"'));
  assert.ok(chunks.join('').includes('"spanId"'));
  assert.ok(chunks.join('').includes('"insights"'));
});

test('SSE emits UI reload events', async () => {
  process.env.LLM_TRACE_ENABLED = '1';
  process.env.LLM_TRACE_PORT = String(reservePort());
  const port = Number(process.env.LLM_TRACE_PORT);

  const tracer = getLocalLLMTracer({ maxTraces: 10, port, uiHotReload: false });
  await tracer.startServer();

  const chunks = [];
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' });

    req.on('response', (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        chunks.push(chunk);
        if (chunks.join('').includes('"type":"ui:reload"')) {
          res.destroy();
          resolve();
        }
      });

      setTimeout(() => {
        tracer.server.broadcast({
          timestamp: new Date().toISOString(),
          spanId: null,
          type: 'ui:reload',
        });
      }, 25);
    });

    req.on('error', reject);
    req.end();
  });

  assert.ok(chunks.join('').includes('"type":"ui:reload"'));
});

test('createTraceServer falls back to a free port when the preferred default port is occupied', async () => {
  const blockedPort = reservePort();
  const blocker = await listenOnPort(blockedPort);
  const server = createTraceServer(new TraceStore(), {
    allowPortFallback: true,
    host: '127.0.0.1',
    port: blockedPort,
  });

  try {
    const info = await server.start();
    assert.ok(info);
    assert.equal(info.host, '127.0.0.1');
    assert.notEqual(info.port, blockedPort);
    assert.match(info.url, new RegExp(`^http://127\\.0\\.0\\.1:${info.port}$`));
  } finally {
    server.close();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('wrapChatModel records invoke and stream traces', async () => {
  process.env.LLM_TRACE_ENABLED = '1';
  process.env.LLM_TRACE_PORT = String(reservePort());
  const port = Number(process.env.LLM_TRACE_PORT);

  const tracer = getLocalLLMTracer({ maxTraces: 10, port });
  tracer.store.clear();

  const model = wrapChatModel(
    {
      async invoke(input) {
        return {
          message: { role: 'assistant', content: input.messages[0].content },
          tool_calls: [],
          usage: { tokens: { prompt: 1, completion: 1 }, pricing: { prompt: 0.1, completion: 0.2 } },
        };
      },
      async *stream(input) {
        yield { type: 'begin', role: 'assistant' };
        yield { type: 'chunk', content: input.messages[0].content };
        yield {
          type: 'finish',
          message: { role: 'assistant', content: input.messages[0].content },
          tool_calls: [],
          usage: { tokens: { prompt: 1, completion: 1 }, pricing: { prompt: 0.1, completion: 0.2 } },
        };
      },
    },
    () => ({ sessionId: 'session-3', rootActorId: 'root', actorId: 'root', model: 'gpt-4.1', provider: 'openai' }),
    { port },
  );

  await model.invoke({ messages: [{ role: 'user', content: 'hello' }], tools: [] }, {});

  const streamChunks = [];
  for await (const chunk of model.stream({ messages: [{ role: 'user', content: 'stream me' }], tools: [] }, {})) {
    streamChunks.push(chunk);
  }

  assert.equal(streamChunks.length, 3);
  const traces = tracer.store.list().items;
  assert.equal(traces.length, 2);
  assert.equal(traces[0].mode, 'stream');
  assert.equal(traces[1].mode, 'invoke');
  assert.equal(traces[0].costUsd, 0.3);
  assert.equal(traces[1].costUsd, 0.3);
});

test('wrapOpenAIClient records chat.completions invoke traces', async () => {
  process.env.LLM_TRACE_ENABLED = '1';
  process.env.LLM_TRACE_PORT = String(reservePort());
  const port = Number(process.env.LLM_TRACE_PORT);

  const tracer = getLocalLLMTracer({ maxTraces: 10, port });
  tracer.store.clear();

  const client = wrapOpenAIClient(
    {
      chat: {
        completions: {
          async create(params) {
            return {
              id: 'chatcmpl-invoke',
              model: params.model,
              object: 'chat.completion',
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: `echo:${params.messages[0].content}`,
                  },
                },
              ],
              usage: {
                prompt_tokens: 3,
                completion_tokens: 4,
                total_tokens: 7,
              },
            };
          },
        },
        ping() {
          return 'pong';
        },
      },
    },
    () => ({ sessionId: 'openai-invoke', rootActorId: 'root', actorId: 'root' }),
    { port },
  );

  assert.equal(client.chat.ping(), 'pong');

  const response = await client.chat.completions.create(
    {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hello invoke' }],
    },
    {
      headers: {
        authorization: 'Bearer secret',
        'x-trace-id': 'trace-123',
      },
    },
  );

  assert.equal(response.choices[0].message.content, 'echo:hello invoke');

  const traces = tracer.store.list().items;
  assert.equal(traces.length, 1);
  assert.equal(traces[0].mode, 'invoke');
  assert.equal(traces[0].provider, 'openai');
  assert.equal(traces[0].model, 'gpt-4.1');

  const trace = tracer.store.get(traces[0].id);
  assert.equal(trace.request.options.headers.authorization, '[REDACTED]');
  assert.equal(trace.request.options.headers['x-trace-id'], 'trace-123');
  assert.equal(trace.response.message.content, 'echo:hello invoke');
  assert.equal(trace.usage.tokens.prompt, 3);
  assert.equal(trace.usage.tokens.completion, 4);
  assert.equal(trace.response.raw.id, 'chatcmpl-invoke');
});

test('wrapOpenAIClient records chat.completions stream traces', async () => {
  process.env.LLM_TRACE_ENABLED = '1';
  process.env.LLM_TRACE_PORT = String(reservePort());
  const port = Number(process.env.LLM_TRACE_PORT);

  const tracer = getLocalLLMTracer({ maxTraces: 10, port });
  tracer.store.clear();

  const client = wrapOpenAIClient(
    {
      chat: {
        completions: {
          async create() {
            return {
              toReadableStream() {
                return 'readable';
              },
              async *[Symbol.asyncIterator]() {
                yield {
                  id: 'chatcmpl-stream-1',
                  choices: [
                    {
                      delta: { role: 'assistant' },
                      finish_reason: null,
                      index: 0,
                    },
                  ],
                };
                yield {
                  id: 'chatcmpl-stream-2',
                  choices: [
                    {
                      delta: { content: 'hello ' },
                      finish_reason: null,
                      index: 0,
                    },
                  ],
                };
                yield {
                  id: 'chatcmpl-stream-3',
                  choices: [
                    {
                      delta: { content: 'world' },
                      finish_reason: 'stop',
                      index: 0,
                    },
                  ],
                  usage: {
                    prompt_tokens: 5,
                    completion_tokens: 2,
                    total_tokens: 7,
                  },
                };
              },
            };
          },
        },
      },
    },
    () => ({ sessionId: 'openai-stream', rootActorId: 'root', actorId: 'root' }),
    { port },
  );

  const stream = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: 'hello stream' }],
    stream: true,
  });

  assert.equal(stream.toReadableStream(), 'readable');

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 3);

  const traces = tracer.store.list().items;
  assert.equal(traces.length, 1);
  assert.equal(traces[0].mode, 'stream');
  assert.equal(traces[0].provider, 'openai');
  assert.equal(traces[0].model, 'gpt-4.1-mini');
  assert.equal(traces[0].responsePreview, 'hello world');

  const trace = tracer.store.get(traces[0].id);
  assert.equal(trace.stream.reconstructed.message.role, 'assistant');
  assert.equal(trace.stream.reconstructed.message.content, 'hello world');
  assert.equal(trace.usage.tokens.prompt, 5);
  assert.equal(trace.usage.tokens.completion, 2);
  assert.equal(trace.response.type, 'finish');
});
