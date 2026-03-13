'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { __resetLocalLLMTracerForTests, getLocalLLMTracer, wrapChatModel } = require('../index');

let nextPort = 4500;

function reservePort() {
  nextPort += 1;
  return nextPort;
}

afterEach(() => {
  __resetLocalLLMTracerForTests();
  delete process.env.LLM_TRACE_ENABLED;
  delete process.env.LLM_TRACE_PORT;
});

test('ring buffer evicts the oldest traces', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 2 });
  tracer.store.clear();
  tracer.store.maxTraces = 2;

  const one = tracer.recordInvokeStart({ chatId: 'chat-1', agentId: 'agent-a' }, { input: { messages: [] }, options: {} });
  tracer.recordInvokeFinish(one, { message: { role: 'assistant', content: 'one' }, tool_calls: [], usage: {} });
  const two = tracer.recordInvokeStart({ chatId: 'chat-1', agentId: 'agent-b' }, { input: { messages: [] }, options: {} });
  tracer.recordInvokeFinish(two, { message: { role: 'assistant', content: 'two' }, tool_calls: [], usage: {} });
  const three = tracer.recordInvokeStart({ chatId: 'chat-1', agentId: 'agent-c' }, { input: { messages: [] }, options: {} });
  tracer.recordInvokeFinish(three, { message: { role: 'assistant', content: 'three' }, tool_calls: [], usage: {} });

  assert.equal(tracer.store.get(one), null);
  assert.ok(tracer.store.get(two));
  assert.ok(tracer.store.get(three));
});

test('hierarchy nests chat, agent, delegated agents, workflow states, and watchdogs', async () => {
  const tracer = getLocalLLMTracer({ maxTraces: 10 });
  tracer.store.clear();

  const root = tracer.recordInvokeStart(
    { chatId: 'chat-1', rootChatId: 'chat-1', topLevelAgentId: 'root-agent', agentId: 'root-agent', model: 'gpt-4.1' },
    { input: { messages: [] }, options: {} },
  );
  tracer.recordInvokeFinish(root, { message: { role: 'assistant', content: 'root' }, tool_calls: [], usage: {} });

  const delegated = tracer.recordInvokeStart(
    { chatId: 'chat-1', rootChatId: 'chat-1', topLevelAgentId: 'root-agent', agentId: 'sub-agent', model: 'gpt-4.1' },
    { input: { messages: [] }, options: {} },
  );
  tracer.recordInvokeFinish(delegated, { message: { role: 'assistant', content: 'delegated' }, tool_calls: [], usage: {} });

  const workflow = tracer.recordInvokeStart(
    {
      chatId: 'chat-1',
      rootChatId: 'chat-1',
      topLevelAgentId: 'root-agent',
      agentId: 'root-agent',
      workflowState: 'triage',
      model: 'gpt-4.1',
    },
    { input: { messages: [] }, options: {} },
  );
  tracer.recordInvokeFinish(workflow, { message: { role: 'assistant', content: 'workflow' }, tool_calls: [], usage: {} });

  const watchdog = tracer.recordInvokeStart(
    {
      chatId: 'chat-1',
      rootChatId: 'chat-1',
      topLevelAgentId: 'root-agent',
      agentId: 'output-filter',
      systemType: 'outputFilterStopBot',
      model: 'gpt-4.1',
    },
    { input: { messages: [] }, options: {} },
  );
  tracer.recordInvokeFinish(watchdog, { message: { role: 'assistant', content: 'watchdog' }, tool_calls: [], usage: {} });

  const tree = tracer.store.hierarchy();
  assert.equal(tree.rootNodes.length, 1);
  const chat = tree.rootNodes[0];
  assert.equal(chat.type, 'chat');
  const agent = chat.children.find((node) => node.type === 'agent');
  assert.ok(agent);
  assert.ok(agent.children.find((node) => node.type === 'delegated-agent'));
  assert.ok(agent.children.find((node) => node.type === 'workflow-state'));
  assert.ok(agent.children.find((node) => node.type === 'watchdog'));
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
        const traceId = tracer.recordInvokeStart({ chatId: 'chat-2', agentId: 'agent-a' }, { input: { messages: [] }, options: {} });
        tracer.recordInvokeFinish(traceId, { message: { role: 'assistant', content: 'done' }, tool_calls: [], usage: {} });
      }, 25);
    });

    req.on('error', reject);
    req.end();
  });

  assert.ok(chunks.join('').includes('"type":"trace:add"'));
  assert.ok(chunks.join('').includes('"type":"trace:update"'));
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
        return { message: { role: 'assistant', content: input.messages[0].content }, tool_calls: [], usage: { tokens: { prompt: 1, completion: 1 } } };
      },
      async *stream(input) {
        yield { type: 'begin', role: 'assistant' };
        yield { type: 'chunk', content: input.messages[0].content };
        yield {
          type: 'finish',
          message: { role: 'assistant', content: input.messages[0].content },
          tool_calls: [],
          usage: { tokens: { prompt: 1, completion: 1 } },
        };
      },
    },
    () => ({ chatId: 'chat-3', topLevelAgentId: 'root', agentId: 'root', model: 'gpt-4.1', provider: 'openai' }),
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
});
