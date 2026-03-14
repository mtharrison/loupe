'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline/promises');
const process = require('node:process');

const { getLocalLLMTracer, wrapOpenAIClient } = require('../dist/index.js');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const PORT = Number(process.env.LLM_TRACE_PORT) || 4319;
const SESSION_ID = `openai-tools-demo-${randomUUID().slice(0, 8)}`;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_city_weather',
      description: 'Returns a short local forecast and packing hints for a supported city.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          city: {
            type: 'string',
            description: 'City name. Supported examples: London, San Francisco.',
          },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_city_guide',
      description: 'Returns coffee, walking, and neighborhood suggestions for a supported city.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          city: {
            type: 'string',
            description: 'City name. Supported examples: London, San Francisco.',
          },
          interests: {
            type: 'array',
            items: {
              type: 'string',
            },
            description: 'Optional list of interests like coffee, walking, museums, or food.',
          },
        },
        required: ['city'],
      },
    },
  },
];

const WEATHER_DATA = {
  london: {
    conditions: 'cool with light rain bands and gusty wind',
    highC: 13,
    lowC: 8,
    notes: ['pack a waterproof shell', 'bring shoes that can handle wet pavement'],
  },
  'san francisco': {
    conditions: 'mild mornings, sunny midday, windy evening',
    highC: 18,
    lowC: 11,
    notes: ['dress in layers', 'carry a light sweater for the evening'],
  },
};

const GUIDE_DATA = {
  london: {
    neighborhoods: ['South Bank', 'Covent Garden', 'Shoreditch'],
    coffee: ['Monmouth Coffee', 'Nagare Coffee', 'Prufrock Coffee'],
    walking: ['Thames Path from Westminster to Tower Bridge', 'Regent Canal walk to Broadway Market'],
  },
  'san francisco': {
    neighborhoods: ['North Beach', 'Mission District', 'Hayes Valley'],
    coffee: ['Sightglass Coffee', 'Saint Frank Coffee', 'Andytown Coffee Roasters'],
    walking: ['Ferry Building to North Beach waterfront loop', 'Mission murals and Dolores Park loop'],
  },
};

async function main() {
  process.env.LLM_TRACE_ENABLED ??= '1';

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY before running this example.');
  }

  const OpenAI = await loadOpenAI();

  const tracer = getLocalLLMTracer({ port: PORT });
  const serverInfo = await tracer.startServer();
  if (!serverInfo?.url) {
    throw new Error('Failed to start the Loupe dashboard.');
  }

  log(`[demo] Loupe dashboard: ${serverInfo.url}`);
  openBrowser(serverInfo.url);

  const traceState = {
    phase: 'boot',
    turn: 0,
  };

  // getContext runs for every traced create() call, so these mutable fields let
  // the example tag each turn without changing the wrapped client.
  const client = wrapOpenAIClient(
    new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    () => ({
      sessionId: SESSION_ID,
      rootSessionId: SESSION_ID,
      rootActorId: 'openai-tools-demo',
      actorId: 'openai-tools-demo',
      model: MODEL,
      provider: 'openai',
      stage: `turn-${traceState.turn}:${traceState.phase}`,
      tags: {
        example: 'wrapOpenAIClient',
        phase: traceState.phase,
        sessionId: SESSION_ID,
        turn: String(traceState.turn),
      },
    }),
    { port: PORT },
  );

  const messages = [
    {
      role: 'system',
      content: [
        'You are a concise travel assistant.',
        'Use the provided tools for weather or city-guide questions instead of answering from memory.',
        'Keep each final answer short and directly useful.',
      ].join(' '),
    },
  ];

  const userTurns = [
    'I am flying from London to San Francisco for three days. Check the forecast for both cities and tell me what to pack.',
    'Now suggest a two-day walking and coffee itinerary in San Francisco. Use the city guide tool and keep it under eight bullets.',
  ];

  log(`[demo] Session: ${SESSION_ID}`);
  log(`[demo] Model: ${MODEL}`);

  for (const prompt of userTurns) {
    traceState.turn += 1;
    traceState.phase = 'user';

    messages.push({
      role: 'user',
      content: prompt,
    });

    log('');
    log(`User ${traceState.turn}: ${prompt}`);

    const reply = await runConversationTurn(client, messages, traceState);
    log(`Assistant ${traceState.turn}: ${reply}`);
  }

  log('');
  log(`[demo] Conversation complete. Keep this process alive while you inspect ${serverInfo.url}`);
  await waitForDashboardExit(serverInfo.url);
}

async function runConversationTurn(client, messages, traceState) {
  for (let modelCall = 1; modelCall <= 6; modelCall += 1) {
    traceState.phase = modelCall === 1 ? 'assistant' : 'tool-followup';

    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      temperature: 0.2,
    });

    const assistantMessage = response?.choices?.[0]?.message;
    if (!assistantMessage) {
      throw new Error('OpenAI returned no assistant message.');
    }

    messages.push(assistantMessage);

    const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    if (toolCalls.length === 0) {
      return extractAssistantText(assistantMessage);
    }

    for (const toolCall of toolCalls) {
      const result = await executeToolCall(toolCall);
      log(`[tool:${toolCall.function.name}] ${JSON.stringify(result)}`);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error('Exceeded the maximum number of tool/model round trips for one turn.');
}

async function executeToolCall(toolCall) {
  const toolName = toolCall?.function?.name;
  const args = parseJson(toolCall?.function?.arguments);

  switch (toolName) {
    case 'get_city_weather':
      return getCityWeather(args);
    case 'search_city_guide':
      return searchCityGuide(args);
    default:
      return {
        error: `Unknown tool: ${String(toolName)}`,
      };
  }
}

function getCityWeather(args) {
  const cityKey = normalizeCityKey(args?.city);
  const weather = WEATHER_DATA[cityKey];

  if (!weather) {
    return {
      city: args?.city || null,
      error: 'No weather data available for that city in this demo.',
      supportedCities: Object.keys(WEATHER_DATA),
    };
  }

  return {
    city: titleCaseCity(cityKey),
    conditions: weather.conditions,
    temperatureC: {
      high: weather.highC,
      low: weather.lowC,
    },
    packingNotes: weather.notes,
  };
}

function searchCityGuide(args) {
  const cityKey = normalizeCityKey(args?.city);
  const guide = GUIDE_DATA[cityKey];

  if (!guide) {
    return {
      city: args?.city || null,
      error: 'No guide data available for that city in this demo.',
      supportedCities: Object.keys(GUIDE_DATA),
    };
  }

  return {
    city: titleCaseCity(cityKey),
    interests: Array.isArray(args?.interests) ? args.interests : [],
    neighborhoods: guide.neighborhoods,
    coffee: guide.coffee,
    walking: guide.walking,
  };
}

function normalizeCityKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function titleCaseCity(value) {
  return String(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function parseJson(value) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return {
      raw: value,
    };
  }
}

function extractAssistantText(message) {
  const content = message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (typeof part?.text === 'string') {
        return part.text;
      }

      if (typeof part?.content === 'string') {
        return part.content;
      }

      return '';
    })
    .join('');
}

async function loadOpenAI() {
  try {
    const module = await import('openai');
    return module.default || module;
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('This example requires the "openai" package. Install it in the project where you run the demo.');
    }

    throw error;
  }
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
    log(`[demo] Non-interactive terminal detected. Leaving the dashboard up for 60 seconds: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 60000));
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
