'use strict';

function safeClone(value) {
  if (value === undefined) {
    return undefined;
  }

  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
  } catch (_err) {
    // fall through to JSON clone
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return value;
  }
}

function toErrorPayload(error) {
  if (!error) {
    return null;
  }

  const payload = {
    name: error.name,
    message: error.message,
  };

  for (const key of ['code', 'status', 'statusCode', 'type', 'param']) {
    if (error[key] !== undefined) {
      payload[key] = error[key];
    }
  }

  if (error.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(headers)) {
    sanitized[key] = isSensitiveHeader(key) ? '[REDACTED]' : value;
  }

  return sanitized;
}

function isSensitiveHeader(key) {
  return ['authorization', 'api-key', 'x-api-key', 'openai-api-key'].includes(String(key).toLowerCase());
}

function envFlag(name) {
  const value = process.env[name];
  if (!value) {
    return false;
  }

  return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase());
}

function normalizeTraceContext(context, mode) {
  const raw = context || {};
  const chatId = raw.chatId || null;
  const rootChatId = raw.rootChatId || raw.chatId || null;
  const topLevelAgentId = raw.topLevelAgentId || raw.agentId || null;
  const agentId = raw.agentId || topLevelAgentId || null;
  const systemType = raw.systemType || null;
  const workflowState = raw.workflowState || null;
  const isWatchdog = typeof systemType === 'string' && /^(input|output)/.test(systemType);
  const watchdogPhase = isWatchdog ? (systemType.startsWith('input') ? 'input' : 'output') : null;
  const isDelegated = !!(agentId && topLevelAgentId && agentId !== topLevelAgentId);

  let kind = 'agent';
  if (isWatchdog) {
    kind = 'watchdog';
  } else if (workflowState) {
    kind = 'workflow-state';
  } else if (isDelegated) {
    kind = 'delegated-agent';
  }

  const provider = raw.provider || null;
  const model = raw.model || null;
  const tags = stringifyRecord({
    ...(raw.tags || {}),
    mode,
    kind,
    chatId,
    rootChatId,
    parentChatId: raw.parentChatId || null,
    topLevelAgentId,
    agentId,
    userId: raw.userId || null,
    tenantId: raw.tenantId || null,
    contextType: raw.contextType || null,
    workflowState,
    systemType,
    watchdogPhase,
    provider,
    model,
  });

  return {
    chatId,
    rootChatId,
    parentChatId: raw.parentChatId || null,
    topLevelAgentId,
    agentId,
    userId: raw.userId || null,
    tenantId: raw.tenantId || null,
    contextType: raw.contextType || null,
    workflowState,
    systemType,
    watchdogPhase,
    kind,
    provider,
    model,
    tags,
    hierarchy: {
      chatId: rootChatId || chatId || 'unknown-chat',
      topLevelAgentId: topLevelAgentId || 'unknown-agent',
      delegatedAgentId: isDelegated ? agentId : null,
      workflowState,
      systemType,
      watchdogPhase,
      kind,
    },
  };
}

function stringifyRecord(record) {
  return Object.entries(record).reduce((acc, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      acc[key] = String(value);
    }

    return acc;
  }, {});
}

function summariseValue(value, maxLength = 160) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}...`;
}

function extractRequestPreview(request) {
  const messages = request?.input?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  const lastUserMessage = [...messages].reverse().find((message) => message?.role === 'user');
  if (!lastUserMessage) {
    return summariseValue(messages[messages.length - 1]?.content);
  }

  return summariseValue(lastUserMessage.content);
}

function extractResponsePreview(trace) {
  if (trace.mode === 'stream') {
    const content = trace.stream?.reconstructed?.message?.content;
    if (content) {
      return summariseValue(content);
    }
  }

  const content = trace.response?.message?.content;
  if (content) {
    return summariseValue(content);
  }

  if (trace.error?.message) {
    return trace.error.message;
  }

  return '';
}

function toSummary(trace) {
  const durationMs = trace.endedAt ? Math.max(0, Date.parse(trace.endedAt) - Date.parse(trace.startedAt)) : null;

  return {
    id: trace.id,
    mode: trace.mode,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs,
    provider: trace.provider,
    model: trace.model,
    kind: trace.kind,
    tags: safeClone(trace.tags),
    hierarchy: safeClone(trace.hierarchy),
    requestPreview: extractRequestPreview(trace.request),
    responsePreview: extractResponsePreview(trace),
    stream: trace.stream
      ? {
          chunkCount: trace.stream.chunkCount,
          firstChunkMs: trace.stream.firstChunkMs,
        }
      : null,
  };
}

module.exports = {
  envFlag,
  normalizeTraceContext,
  safeClone,
  sanitizeHeaders,
  stringifyRecord,
  summariseValue,
  toErrorPayload,
  toSummary,
};
