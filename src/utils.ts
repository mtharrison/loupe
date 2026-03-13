import { type NormalizedTraceContext, type TraceContext, type TraceMode, type TraceRecord, type TraceSummary } from './types';

export function safeClone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  try {
    const clone = (globalThis as any).structuredClone;
    if (typeof clone === 'function') {
      return clone(value);
    }
  } catch (_err) {
    // fall through
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return value;
  }
}

export function toErrorPayload(error: any): Record<string, any> | null {
  if (!error) {
    return null;
  }

  const payload: Record<string, any> = {
    message: error.message,
    name: error.name,
  };

  for (const key of ['code', 'param', 'status', 'statusCode', 'type']) {
    if (error[key] !== undefined) {
      payload[key] = error[key];
    }
  }

  if (error.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

export function sanitizeHeaders(headers: Record<string, any> | undefined): Record<string, any> {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(headers)) {
    sanitized[key] = isSensitiveHeader(key) ? '[REDACTED]' : value;
  }

  return sanitized;
}

function isSensitiveHeader(key: string): boolean {
  return ['authorization', 'api-key', 'x-api-key', 'openai-api-key'].includes(String(key).toLowerCase());
}

export function envFlag(name: string): boolean {
  const value = process.env[name];
  if (!value) {
    return false;
  }

  return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase());
}

export function stringifyRecord(record: Record<string, any>): Record<string, string> {
  return Object.entries(record).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      acc[key] = String(value);
    }

    return acc;
  }, {});
}

function normalizeKind(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  switch (value) {
    case 'agent':
      return 'actor';
    case 'delegated-agent':
      return 'child-actor';
    case 'workflow-state':
      return 'stage';
    case 'watchdog':
      return 'guardrail';
    default:
      return value;
  }
}

function deriveGuardrailPhase(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = String(value).toLowerCase();
  if (normalized.startsWith('input')) {
    return 'input';
  }

  if (normalized.startsWith('output')) {
    return 'output';
  }

  return null;
}

export function normalizeTraceContext(context: TraceContext | undefined, mode: TraceMode): NormalizedTraceContext {
  const raw = context || {};
  const sessionId = raw.sessionId || raw.chatId || raw.rootSessionId || raw.rootChatId || null;
  const rootSessionId = raw.rootSessionId || raw.rootChatId || sessionId || null;
  const rootActorId = raw.rootActorId || raw.topLevelAgentId || raw.actorId || raw.agentId || null;
  const actorId = raw.actorId || raw.agentId || rootActorId || null;
  const actorType = raw.actorType || raw.contextType || null;
  const stage = raw.stage || raw.workflowState || null;
  const guardrailType = raw.guardrailType || raw.systemType || null;
  const guardrailPhase = raw.guardrailPhase || raw.watchdogPhase || deriveGuardrailPhase(guardrailType);
  const isChildActor = !!(actorId && rootActorId && actorId !== rootActorId);
  const explicitKind = normalizeKind(raw.kind);

  let kind = explicitKind || 'actor';
  if (!explicitKind) {
    if (guardrailType || guardrailPhase) {
      kind = 'guardrail';
    } else if (stage) {
      kind = 'stage';
    } else if (isChildActor) {
      kind = 'child-actor';
    }
  }

  const provider = raw.provider || null;
  const model = raw.model || null;
  const tags = stringifyRecord({
    ...(raw.tags || {}),
    actorId,
    actorType,
    guardrailPhase,
    guardrailType,
    kind,
    mode,
    model,
    parentSessionId: raw.parentSessionId || raw.parentChatId || null,
    provider,
    rootActorId,
    rootSessionId,
    sessionId,
    stage,
    tenantId: raw.tenantId || null,
    userId: raw.userId || null,
    agentId: actorId,
    chatId: sessionId,
    contextType: actorType,
    parentChatId: raw.parentSessionId || raw.parentChatId || null,
    rootChatId: rootSessionId,
    systemType: guardrailType,
    topLevelAgentId: rootActorId,
    watchdogPhase: guardrailPhase,
    workflowState: stage,
  });

  return {
    actorId,
    actorType,
    guardrailPhase,
    guardrailType,
    kind,
    model,
    parentSessionId: raw.parentSessionId || raw.parentChatId || null,
    provider,
    rootActorId,
    rootSessionId,
    sessionId,
    stage,
    tags,
    tenantId: raw.tenantId || null,
    userId: raw.userId || null,
    agentId: actorId,
    chatId: sessionId,
    contextType: actorType,
    parentChatId: raw.parentSessionId || raw.parentChatId || null,
    rootChatId: rootSessionId,
    systemType: guardrailType,
    topLevelAgentId: rootActorId,
    watchdogPhase: guardrailPhase,
    workflowState: stage,
    hierarchy: {
      childActorId: isChildActor ? actorId : null,
      guardrailPhase,
      guardrailType,
      kind,
      rootActorId: rootActorId || 'unknown-actor',
      sessionId: rootSessionId || sessionId || 'unknown-session',
      stage,
      chatId: rootSessionId || sessionId || 'unknown-session',
      delegatedAgentId: isChildActor ? actorId : null,
      systemType: guardrailType,
      topLevelAgentId: rootActorId || 'unknown-actor',
      watchdogPhase: guardrailPhase,
      workflowState: stage,
    },
  };
}

export function summariseValue(value: unknown, maxLength = 160): string {
  if (value === null || value === undefined) {
    return '';
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}...`;
}

export function getUsageCostUsd(usage: Record<string, any> | null | undefined): number | null {
  const promptTokens = toFiniteNumber(usage?.tokens?.prompt);
  const completionTokens = toFiniteNumber(usage?.tokens?.completion);
  const promptPricing = toFiniteNumber(usage?.pricing?.prompt);
  const completionPricing = toFiniteNumber(usage?.pricing?.completion);

  if (promptTokens === null || completionTokens === null || promptPricing === null || completionPricing === null) {
    return null;
  }

  return roundCostUsd(promptTokens * promptPricing + completionTokens * completionPricing);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundCostUsd(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function extractRequestPreview(request: TraceRecord['request']): string {
  const messages = request?.input?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  const lastUserMessage = [...messages].reverse().find((message: any) => message?.role === 'user');
  if (!lastUserMessage) {
    return summariseValue(messages[messages.length - 1]?.content);
  }

  return summariseValue(lastUserMessage.content);
}

function extractResponsePreview(trace: TraceRecord): string {
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

export function toSummary(trace: TraceRecord): TraceSummary {
  const durationMs = trace.endedAt ? Math.max(0, Date.parse(trace.endedAt) - Date.parse(trace.startedAt)) : null;

  return {
    costUsd: getUsageCostUsd(trace.usage),
    durationMs,
    endedAt: trace.endedAt,
    hierarchy: safeClone(trace.hierarchy),
    id: trace.id,
    kind: trace.kind,
    mode: trace.mode,
    model: trace.model,
    provider: trace.provider,
    requestPreview: extractRequestPreview(trace.request),
    responsePreview: extractResponsePreview(trace),
    startedAt: trace.startedAt,
    status: trace.status,
    stream: trace.stream
      ? {
          chunkCount: trace.stream.chunkCount,
          firstChunkMs: trace.stream.firstChunkMs,
        }
      : null,
    tags: safeClone(trace.tags),
  };
}
