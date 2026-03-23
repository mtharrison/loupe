'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline/promises');
const process = require('node:process');

const {
  addSpanEvent,
  endSpan,
  getLocalLLMTracer,
  recordException,
  startSpan,
  wrapChatModel,
} = require('../dist/index.js');

const DEMO_TIMEOUT_MS = 15000;

const GUIDE_DATA = {
  kyoto: {
    coffee: ['Weekenders Coffee Tominokoji', 'Kurasu Kyoto Stand'],
    museum: 'Kyoto National Museum',
    neighborhood: 'Gion',
    pack: ['layers', 'comfortable walking shoes', 'a compact umbrella'],
    walk: 'Philosopher\'s Path and Higashiyama backstreets',
  },
  lisbon: {
    coffee: ['Hello, Kristof', 'The Folks'],
    museum: 'MAAT',
    neighborhood: 'Baixa and Chiado',
    pack: ['layers', 'comfortable walking shoes', 'a light rain shell'],
    walk: 'Alfama viewpoints loop',
  },
};

async function runFullyFeaturedExample(options = {}) {
  process.env.LLM_TRACE_ENABLED ??= '1';

  const destinationKey = normalizeDestinationKey(options.destination || 'Lisbon');
  const guide = GUIDE_DATA[destinationKey];
  if (!guide) {
    throw new Error(`Unsupported destination "${String(options.destination)}". Try Lisbon or Kyoto.`);
  }

  const port = getPort(options.port);
  const destination = formatDestination(destinationKey);
  const sessionId = options.sessionId || `fully-featured-demo-${randomUUID().slice(0, 8)}`;
  const keepAlive = options.keepAlive !== false;
  const openBrowserEnabled = options.openBrowser !== false;
  const tracer = getLocalLLMTracer({ port });
  const serverInfo = await tracer.startServer();

  if (!serverInfo?.url) {
    throw new Error('Failed to start the Loupe dashboard.');
  }

  log(`[demo] Loupe dashboard: ${serverInfo.url}`);
  if (openBrowserEnabled) {
    openBrowser(serverInfo.url);
  }

  log(`[demo] Session: ${sessionId}`);
  log(`[demo] Destination: ${destination}`);

  const baseTags = {
    destination,
    example: 'fully-featured',
    workflow: 'weekend-planner',
  };

  const buildContext = (overrides = {}) => {
    const { tags = {}, ...rest } = overrides;
    return {
      sessionId,
      rootSessionId: sessionId,
      rootActorId: 'travel-assistant',
      actorId: 'travel-assistant',
      actorType: 'assistant',
      model: 'trip-planner-v2',
      provider: 'mock-llm',
      tags: {
        ...baseTags,
        ...tags,
      },
      tenantId: 'demo-travel',
      userId: 'traveler-01',
      ...rest,
    };
  };

  const researchModel = wrapChatModel(
    {
      async invoke(input) {
        const requestedDestination = formatDestination(normalizeDestinationKey(input?.destination || destination));
        const selectedGuide = GUIDE_DATA[normalizeDestinationKey(requestedDestination)] || guide;
        return {
          message: {
            role: 'assistant',
            content: [
              `Base the trip around ${selectedGuide.neighborhood}.`,
              `Coffee: ${selectedGuide.coffee.join(' and ')}.`,
              `Walk: ${selectedGuide.walk}.`,
              `Museum: ${selectedGuide.museum}.`,
            ].join(' '),
          },
          tool_calls: [],
          usage: createUsage(18, 27),
        };
      },
      async *stream(input) {
        const requestedDestination = formatDestination(normalizeDestinationKey(input?.destination || destination));
        const selectedGuide = GUIDE_DATA[normalizeDestinationKey(requestedDestination)] || guide;
        const content = `Research highlights for ${requestedDestination}: ${selectedGuide.walk}, ${selectedGuide.museum}.`;
        yield { type: 'begin', role: 'assistant' };
        yield { type: 'chunk', content };
        yield {
          type: 'finish',
          message: { role: 'assistant', content },
          tool_calls: [],
          usage: createUsage(10, 12),
        };
      },
    },
    () =>
      buildContext({
        actorId: 'city-researcher',
        actorType: 'tool',
        model: 'city-researcher-v1',
        tags: {
          surface: 'research',
        },
      }),
    { port },
  );

  const plannerModel = wrapChatModel(
    {
      async invoke(input) {
        const researchStageId = startSpan(
          buildContext({
            stage: 'research',
            tags: {
              surface: 'research-stage',
            },
          }),
          {
            mode: 'invoke',
            name: 'workflow.research',
            request: {
              input: {
                destination: input.destination,
                interests: input.interests,
              },
              options: {
                sources: ['city-guide', 'weather-notes'],
              },
            },
          },
          { port },
        );

        addSpanEvent(
          researchStageId,
          {
            name: 'retrieval.hit',
            attributes: {
              guide: destination,
              sources: 2,
            },
            payload: {
              guide: destination,
              sources: ['city-guide', 'weather-notes'],
            },
          },
          { port },
        );

        endSpan(
          researchStageId,
          {
            summary: `Loaded local guide data for ${destination}.`,
            usage: createUsage(6, 4, 0.0000005, 0.0000008),
          },
          { port },
        );

        const research = await researchModel.invoke(
          {
            destination: input.destination,
            interests: input.interests,
            messages: [
              {
                role: 'user',
                content: `Research a two-day ${destination} itinerary for ${input.interests.join(', ')}.`,
              },
            ],
          },
          {
            channel: 'research',
          },
        );

        const availabilitySpanId = startSpan(
          buildContext({
            actorId: 'availability-service',
            actorType: 'service',
            tags: {
              surface: 'availability',
            },
          }),
          {
            mode: 'invoke',
            name: 'tool.availability-check',
            request: {
              input: {
                destination: input.destination,
                hotel: `${destination} Riverside House`,
              },
              options: {
                timeoutMs: 250,
              },
            },
          },
          { port },
        );

        try {
          throw Object.assign(new Error('Supplier timed out during live availability lookup.'), {
            code: 'SUPPLIER_TIMEOUT',
            status: 504,
          });
        } catch (error) {
          // Keep the demo moving while leaving one child span in the error state.
          recordException(availabilitySpanId, error, { port });
        }

        const outputGuardrailId = startSpan(
          buildContext({
            guardrailType: 'output-policy',
            tags: {
              surface: 'output-guardrail',
            },
          }),
          {
            mode: 'invoke',
            name: 'guardrail.output',
            request: {
              input: {
                draft: research.message.content,
              },
              options: {
                policy: 'travel-safe',
              },
            },
          },
          { port },
        );

        addSpanEvent(
          outputGuardrailId,
          {
            name: 'guardrail.review',
            attributes: {
              outcome: 'pass',
              policy: 'travel-safe',
            },
            payload: {
              removedClaims: 0,
            },
          },
          { port },
        );

        endSpan(
          outputGuardrailId,
          {
            reason: 'Advice stays within local-demo safety rules.',
            result: 'pass',
          },
          { port },
        );

        return {
          message: {
            role: 'assistant',
            content: [
              `Day 1: start in ${guide.neighborhood} with ${guide.coffee[0]}, then walk ${guide.walk}.`,
              `Day 2: visit ${guide.museum}, then use ${guide.coffee[1]} as a reset stop.`,
              research.message.content,
              'One live availability lookup failed, so confirm bookings directly before you go.',
              `Pack ${guide.pack.join(', ')}.`,
            ].join('\n'),
          },
          tool_calls: [],
          usage: createUsage(42, 68),
        };
      },
      async *stream(input) {
        const parts = [
          `Day 1 in ${destination}: ${guide.coffee[0]}, then ${guide.walk}. `,
          `Day 2: ${guide.museum}, followed by time around ${guide.neighborhood}. `,
          `Pack ${guide.pack.join(', ')}.`,
        ];
        const finalContent = parts.join('');

        yield { type: 'begin', role: 'assistant' };
        for (const content of parts) {
          yield { type: 'chunk', content };
        }
        yield {
          type: 'finish',
          message: { role: 'assistant', content: finalContent },
          tool_calls: [],
          usage: createUsage(24, 39),
        };
      },
    },
    () =>
      buildContext({
        tags: {
          surface: 'planner',
        },
      }),
    { port },
  );

  const invokeInput = {
    days: 2,
    destination,
    interests: ['coffee', 'walking', 'museum'],
    messages: [
      {
        role: 'user',
        content: `Plan a safe two-day ${destination} trip with coffee, walking, and one museum stop.`,
      },
    ],
  };

  const inputGuardrailId = startSpan(
    buildContext({
      guardrailType: 'input-policy',
      tags: {
        surface: 'input-guardrail',
      },
    }),
    {
      mode: 'invoke',
      name: 'guardrail.input',
      request: {
        input: invokeInput,
        options: {
          policy: 'travel-safe',
        },
      },
    },
    { port },
  );

  addSpanEvent(
    inputGuardrailId,
    {
      name: 'guardrail.review',
      attributes: {
        outcome: 'pass',
        policy: 'travel-safe',
      },
      payload: {
        matchedRules: ['safe-travel'],
      },
    },
    { port },
  );

  endSpan(
    inputGuardrailId,
    {
      reason: 'The prompt is safe to answer.',
      result: 'pass',
    },
    { port },
  );

  const invokeResponse = await plannerModel.invoke(invokeInput, {
    channel: 'planning',
  });

  log('');
  log('[demo] Invoke answer:');
  log(invokeResponse.message.content);

  const streamInput = {
    ...invokeInput,
    messages: [
      {
        role: 'user',
        content: `Now stream the concise version of the ${destination} plan.`,
      },
    ],
  };

  const streamChunks = [];
  for await (const chunk of plannerModel.stream(streamInput, { channel: 'handoff' })) {
    streamChunks.push(chunk);
  }

  const streamReply = extractStreamText(streamChunks);
  log('');
  log('[demo] Stream answer:');
  log(streamReply);

  const traceCount = tracer.store
    .list()
    .items.filter((item) => item.hierarchy.sessionId === sessionId && item.tags.example === 'fully-featured').length;

  log('');
  log(`[demo] Recorded ${traceCount} traces for one session across guardrails, nested calls, errors, and streaming.`);

  if (keepAlive) {
    log(`[demo] Keep this process alive while you inspect ${serverInfo.url}`);
    await waitForDashboardExit(serverInfo.url);
  }

  return {
    invokeReply: invokeResponse.message.content,
    sessionId,
    streamReply,
    traceCount,
    url: serverInfo.url,
  };
}

function createUsage(promptTokens, completionTokens, promptPrice = 0.000001, completionPrice = 0.000002) {
  return {
    pricing: {
      completion: completionPrice,
      prompt: promptPrice,
    },
    tokens: {
      completion: completionTokens,
      prompt: promptTokens,
    },
  };
}

function extractStreamText(chunks) {
  return chunks
    .filter((chunk) => chunk?.type === 'chunk' && typeof chunk.content === 'string')
    .map((chunk) => chunk.content)
    .join('');
}

function normalizeDestinationKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function formatDestination(value) {
  return String(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function getPort(port) {
  const explicit = Number(port ?? process.env.LLM_TRACE_PORT);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : 4319;
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

module.exports = {
  runFullyFeaturedExample,
};

if (require.main === module) {
  runFullyFeaturedExample().catch((error) => {
    process.stderr.write(`[demo] ${error.message}\n`);
    process.exitCode = 1;
  });
}
