'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  __resetLocalLLMTracerForTests,
  getLocalLLMTracer,
  recordError,
  recordInvokeFinish,
  recordInvokeStart,
  recordStreamChunk,
  recordStreamFinish,
  recordStreamStart,
  startTraceServer,
  wrapChatModel,
} = require('../dist/index.js');

let nextPort = 4500;

function reservePort() {
  nextPort += 1;
  return nextPort;
}

afterEach(() => {
  __resetLocalLLMTracerForTests();
  delete process.env.LLM_TRACE_ENABLED;
  delete process.env.LLM_TRACE_PORT;
  delete process.env.LLM_TRACE_UI_HOT_RELOAD;
});

test('low-level lifecycle exports record traces through the singleton tracer', async () => {
  process.env.LLM_TRACE_ENABLED = '1';
  const port = reservePort();
  const tracer = getLocalLLMTracer({ maxTraces: 10, port });
  tracer.store.clear();

  await startTraceServer({ port });

  const invokeTraceId = recordInvokeStart(
    { sessionId: 'session-low-level', rootActorId: 'root', actorId: 'root', provider: 'openai', model: 'gpt-4.1' },
    { input: { messages: [{ role: 'user', content: 'hello' }] }, options: {} },
  );
  recordInvokeFinish(invokeTraceId, {
    message: { role: 'assistant', content: 'world' },
    tool_calls: [],
    usage: { tokens: { prompt: 1, completion: 2 }, pricing: { prompt: 0.1, completion: 0.2 } },
  });

  const streamTraceId = recordStreamStart(
    { sessionId: 'session-low-level', rootActorId: 'root', actorId: 'root', provider: 'openai', model: 'gpt-4.1' },
    { input: { messages: [{ role: 'user', content: 'stream' }] }, options: {} },
  );
  recordStreamChunk(streamTraceId, { type: 'begin', role: 'assistant' });
  recordStreamChunk(streamTraceId, { type: 'chunk', content: 'abc' });
  recordStreamFinish(streamTraceId, {
    type: 'finish',
    message: { role: 'assistant', content: 'abc' },
    tool_calls: [],
    usage: { tokens: { prompt: 2, completion: 3 }, pricing: { prompt: 0.01, completion: 0.02 } },
  });

  const errorTraceId = recordInvokeStart(
    { sessionId: 'session-low-level', rootActorId: 'root', actorId: 'root' },
    { input: { messages: [] }, options: {} },
  );
  recordError(errorTraceId, new Error('boom'));

  const traces = tracer.store.list().items;
  assert.equal(traces.length, 3);
  assert.equal(traces[0].status, 'error');
  assert.equal(traces[1].mode, 'stream');
  assert.equal(traces[2].mode, 'invoke');
});

test('ring buffer evicts the oldest traces', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 2 });
  tracer.store.clear();
  tracer.store.maxTraces = 2;

  const one = tracer.recordInvokeStart({ sessionId: 'session-1', actorId: 'actor-a' }, { input: { messages: [] }, options: {} });
  tracer.recordInvokeFinish(one, { message: { role: 'assistant', content: 'one' }, tool_calls: [], usage: {} });
  const two = tracer.recordInvokeStart({ sessionId: 'session-1', actorId: 'actor-b' }, { input: { messages: [] }, options: {} });
  tracer.recordInvokeFinish(two, { message: { role: 'assistant', content: 'two' }, tool_calls: [], usage: {} });
  const three = tracer.recordInvokeStart({ sessionId: 'session-1', actorId: 'actor-c' }, { input: { messages: [] }, options: {} });
  tracer.recordInvokeFinish(three, { message: { role: 'assistant', content: 'three' }, tool_calls: [], usage: {} });

  assert.equal(tracer.store.get(one), null);
  assert.ok(tracer.store.get(two));
  assert.ok(tracer.store.get(three));
});

test('hierarchy nests sessions, actors, child actors, stages, and guardrails', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 10 });
  tracer.store.clear();
  const usage = { tokens: { prompt: 100, completion: 50 }, pricing: { prompt: 0.000001, completion: 0.000002 } };
  const expectedCost = 0.0002;

  const root = tracer.recordInvokeStart(
    { sessionId: 'session-1', rootSessionId: 'session-1', rootActorId: 'root-actor', actorId: 'root-actor', model: 'gpt-4.1' },
    { input: { messages: [] }, options: {} },
  );
  tracer.recordInvokeFinish(root, { message: { role: 'assistant', content: 'root' }, tool_calls: [], usage });

  const delegated = tracer.recordInvokeStart(
    { sessionId: 'session-1', rootSessionId: 'session-1', rootActorId: 'root-actor', actorId: 'child-actor', model: 'gpt-4.1' },
    { input: { messages: [] }, options: {} },
  );
  tracer.recordInvokeFinish(delegated, { message: { role: 'assistant', content: 'delegated' }, tool_calls: [], usage });

  const workflow = tracer.recordInvokeStart(
    {
      sessionId: 'session-1',
      rootSessionId: 'session-1',
      rootActorId: 'root-actor',
      actorId: 'root-actor',
      stage: 'triage',
      model: 'gpt-4.1',
    },
    { input: { messages: [] }, options: {} },
  );
  tracer.recordInvokeFinish(workflow, { message: { role: 'assistant', content: 'workflow' }, tool_calls: [], usage });

  const guardrail = tracer.recordInvokeStart(
    {
      sessionId: 'session-1',
      rootSessionId: 'session-1',
      rootActorId: 'root-actor',
      actorId: 'output-guardrail',
      guardrailType: 'outputPolicyCheck',
      model: 'gpt-4.1',
    },
    { input: { messages: [] }, options: {} },
  );
  tracer.recordInvokeFinish(guardrail, { message: { role: 'assistant', content: 'guardrail' }, tool_calls: [], usage });

  const tree = tracer.store.hierarchy();
  assert.equal(tree.rootNodes.length, 1);
  const session = tree.rootNodes[0];
  assert.equal(session.type, 'session');
  assert.equal(session.meta.costUsd, expectedCost * 4);
  const actor = session.children.find((node) => node.type === 'actor');
  assert.ok(actor);
  assert.equal(actor.meta.costUsd, expectedCost * 4);
  const childActorNode = actor.children.find((node) => node.type === 'child-actor');
  assert.ok(childActorNode);
  assert.equal(childActorNode.meta.costUsd, expectedCost);
  const stageNode = actor.children.find((node) => node.type === 'stage');
  assert.ok(stageNode);
  assert.equal(stageNode.meta.costUsd, expectedCost);
  const guardrailNode = actor.children.find((node) => node.type === 'guardrail');
  assert.ok(guardrailNode);
  assert.equal(guardrailNode.meta.costUsd, expectedCost);
});

test('legacy context aliases still normalize into the generic hierarchy model', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 10 });
  tracer.store.clear();

  const traceId = tracer.recordInvokeStart(
    {
      chatId: 'chat-legacy',
      rootChatId: 'chat-legacy',
      topLevelAgentId: 'root-agent',
      agentId: 'child-agent',
      workflowState: 'triage',
      systemType: 'outputFilterStopBot',
    },
    { input: { messages: [] }, options: {} },
  );
  tracer.recordInvokeFinish(traceId, { message: { role: 'assistant', content: 'done' }, tool_calls: [], usage: {} });

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

test('SSE emits trace lifecycle events', async () => {
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
        if (chunks.join('').includes('"type":"trace:update"')) {
          res.destroy();
          resolve();
        }
      });

      setTimeout(() => {
        const traceId = tracer.recordInvokeStart({ sessionId: 'session-2', actorId: 'actor-a' }, { input: { messages: [] }, options: {} });
        tracer.recordInvokeFinish(traceId, { message: { role: 'assistant', content: 'done' }, tool_calls: [], usage: {} });
      }, 25);
    });

    req.on('error', reject);
    req.end();
  });

  assert.ok(chunks.join('').includes('"type":"trace:add"'));
  assert.ok(chunks.join('').includes('"type":"trace:update"'));
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
          traceId: null,
          type: 'ui:reload',
        });
      }, 25);
    });

    req.on('error', reject);
    req.end();
  });

  assert.ok(chunks.join('').includes('"type":"ui:reload"'));
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
