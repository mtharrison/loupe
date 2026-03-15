'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline/promises');
const process = require('node:process');

const { getLocalLLMTracer, wrapChatModel } = require('../dist/index.js');

const DEMO_TIMEOUT_MS = 15000;
const PORT = Number(process.env.LLM_TRACE_PORT) || 4319;
const SESSION_ID = `nested-tool-demo-${randomUUID().slice(0, 8)}`;

async function main() {
  process.env.LLM_TRACE_ENABLED ??= '1';

  const tracer = getLocalLLMTracer({ port: PORT });
  const serverInfo = await tracer.startServer();
  if (!serverInfo?.url) {
    throw new Error('Failed to start the Loupe dashboard.');
  }

  log(`[demo] Loupe dashboard: ${serverInfo.url}`);
  openBrowser(serverInfo.url);
  log(`[demo] Session: ${SESSION_ID}`);

  const nestedResearchModel = wrapChatModel(
    {
      async invoke(input) {
        const question = input?.messages?.[0]?.content || '';
        return {
          message: {
            role: 'assistant',
            content: `Tool research result for "${question}": compare rain gear, walking shoes, and a light sweater.`,
          },
          tool_calls: [],
          usage: {
            tokens: { prompt: 9, completion: 14 },
            pricing: { prompt: 0.000001, completion: 0.000002 },
          },
        };
      },
      async *stream(input) {
        const content = `Tool research stream for "${input?.messages?.[0]?.content || ''}".`;
        yield { type: 'begin', role: 'assistant' };
        yield { type: 'chunk', content };
        yield {
          type: 'finish',
          message: { role: 'assistant', content },
          tool_calls: [],
          usage: {
            tokens: { prompt: 9, completion: 14 },
            pricing: { prompt: 0.000001, completion: 0.000002 },
          },
        };
      },
    },
    () => ({
      sessionId: SESSION_ID,
      rootSessionId: SESSION_ID,
      rootActorId: 'travel-assistant',
      actorId: 'weather-research-tool',
      provider: 'mock-llm',
      model: 'tool-researcher-v1',
      stage: 'tool:research',
      tags: {
        example: 'nested-tool-call',
        role: 'tool-llm',
      },
    }),
    { port: PORT },
  );

  const rootAssistantModel = wrapChatModel(
    {
      async invoke(input) {
        const question = input?.messages?.[0]?.content || '';
        const toolResult = await nestedResearchModel.invoke(
          {
            messages: [
              {
                role: 'user',
                content: `Research facts needed for: ${question}`,
              },
            ],
          },
          {},
        );

        return {
          message: {
            role: 'assistant',
            content: [
              `Final answer for "${question}"`,
              '',
              toolResult.message.content,
              '',
              'Pack layers, waterproof gear, and comfortable shoes.',
            ].join('\n'),
          },
          tool_calls: [],
          usage: {
            tokens: { prompt: 12, completion: 18 },
            pricing: { prompt: 0.000001, completion: 0.000002 },
          },
        };
      },
      async *stream(input) {
        const question = input?.messages?.[0]?.content || '';
        yield { type: 'begin', role: 'assistant' };
        yield { type: 'chunk', content: 'Let me research that with the tool model.\n\n' };

        let toolContent = '';
        for await (const chunk of nestedResearchModel.stream(
          {
            messages: [
              {
                role: 'user',
                content: `Research facts needed for: ${question}`,
              },
            ],
          },
          {},
        )) {
          if (chunk?.type === 'chunk' && typeof chunk.content === 'string') {
            toolContent += chunk.content;
          }
        }

        const finalContent = [
          `Final answer for "${question}"`,
          '',
          toolContent,
          '',
          'Pack layers, waterproof gear, and comfortable shoes.',
        ].join('\n');

        yield { type: 'chunk', content: finalContent };
        yield {
          type: 'finish',
          message: { role: 'assistant', content: finalContent },
          tool_calls: [],
          usage: {
            tokens: { prompt: 12, completion: 18 },
            pricing: { prompt: 0.000001, completion: 0.000002 },
          },
        };
      },
    },
    () => ({
      sessionId: SESSION_ID,
      rootSessionId: SESSION_ID,
      rootActorId: 'travel-assistant',
      actorId: 'travel-assistant',
      provider: 'mock-llm',
      model: 'trip-planner-v1',
      stage: 'assistant',
      tags: {
        example: 'nested-tool-call',
        role: 'root-llm',
      },
    }),
    { port: PORT },
  );

  const prompt = 'I am taking a rainy weekend trip to London. What should I pack?';
  log(`[demo] User: ${prompt}`);
  const response = await rootAssistantModel.invoke({
    messages: [{ role: 'user', content: prompt }],
  });
  log(`[demo] Assistant:\n${response.message.content}`);
  log('[demo] This run creates a parent span for the assistant call and a child span for the tool LLM call.');
  log(`[demo] Keep this process alive while you inspect ${serverInfo.url}`);

  await waitForDashboardExit(serverInfo.url);
}

function openBrowser(url) {
  if (!process.stdout.isTTY || process.env.CI || process.env.LOUPE_OPEN_BROWSER === '0') {
    return;
  }

  const command =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'linux'
          ? ['xdg-open', [url]]
          : null;

  if (!command) {
    return;
  }

  try {
    const child = spawn(command[0], command[1], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch (_error) {
    // Ignore browser launch failures. The dashboard URL is already printed.
  }
}

async function waitForDashboardExit(url) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log(`[demo] Non-interactive terminal detected. Leaving the dashboard up for ${Math.round(DEMO_TIMEOUT_MS / 1000)} seconds: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, DEMO_TIMEOUT_MS));
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await rl.question('[demo] Press Enter to stop the demo and close the dashboard.\n');
  } finally {
    rl.close();
  }
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

main().catch((error) => {
  process.stderr.write(`[demo] ${error.message}\n`);
  process.exitCode = 1;
});
