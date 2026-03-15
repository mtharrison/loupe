import {
  type NormalizedTraceContext,
  type SpanEventInput,
  type TraceContext,
  type TraceHighlightInsight,
  type TraceInsights,
  type TraceMode,
  type TraceRecord,
  type TraceStructuredInputInsight,
  type TraceSummary,
} from './types';

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

export function toSpanEventInputFromChunk(chunk: unknown): SpanEventInput {
  const payload = safeClone(chunk) as Record<string, any> | null;
  const chunkType = typeof payload?.type === 'string' && payload.type ? payload.type : 'event';
  const attributes = payload !== null && typeof payload === 'object' ? { ...payload } : {};

  if ('type' in attributes) {
    delete attributes.type;
  }

  return {
    attributes,
    name: `stream.${chunkType}`,
    payload: payload ?? undefined,
  };
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

export function getTraceInsights(trace: TraceRecord): TraceInsights {
  const structuredInputs: TraceStructuredInputInsight[] = [];
  const highlights: TraceHighlightInsight[] = [];
  const seenStructured = new Set<string>();
  const seenHighlights = new Set<string>();

  for (const message of collectTraceMessages(trace)) {
    const text = toInsightText(message.content);
    if (!text) {
      continue;
    }

    const structuredMarkup = detectStructuredMarkup(text);
    if (structuredMarkup) {
      const structuredKey = `${message.source}:${structuredMarkup.tags.join('|')}:${structuredMarkup.snippet}`;
      if (!seenStructured.has(structuredKey)) {
        structuredInputs.push({
          format: 'xml',
          role: message.role,
          snippet: structuredMarkup.snippet,
          tags: structuredMarkup.tags,
        });
        seenStructured.add(structuredKey);
      }

      const highlightKey = `structured:${message.source}:${structuredMarkup.tags.join('|')}`;
      if (!seenHighlights.has(highlightKey)) {
        highlights.push({
          kind: 'structured-input',
          title: `Structured ${message.role} input`,
          description: `Contains XML-like markup (${structuredMarkup.tags.slice(0, 3).join(', ')}) that may influence guardrail behavior.`,
          source: message.source,
          snippet: structuredMarkup.snippet,
        });
        seenHighlights.add(highlightKey);
      }
    }

    if ((message.role === 'user' || message.role === 'system') && looksLikeLongPrompt(text)) {
      const longKey = `long:${message.source}`;
      if (!seenHighlights.has(longKey)) {
        highlights.push({
          kind: 'long-message',
          title: `Long ${message.role} message`,
          description: 'Large prompt payloads often hide embedded instructions, policies, or contextual data worth inspecting.',
          source: message.source,
          snippet: createSnippet(text, 240),
        });
        seenHighlights.add(longKey);
      }
    }
  }

  if (trace.kind === 'guardrail') {
    const contextSummary = [trace.context.guardrailPhase, trace.context.guardrailType, trace.context.systemType]
      .filter(Boolean)
      .join(' / ');
    if (contextSummary) {
      highlights.push({
        kind: 'guardrail-context',
        title: `${capitalize(trace.context.guardrailPhase || 'guardrail')} guardrail context`,
        description: `This trace ran inside ${contextSummary}.`,
        source: 'trace:guardrail',
        snippet: createSnippet(contextSummary, 180),
      });
    }
  }

  return {
    structuredInputs,
    highlights,
  };
}

export function toSummary(trace: TraceRecord): TraceSummary {
  const durationMs = trace.endedAt ? Math.max(0, Date.parse(trace.endedAt) - Date.parse(trace.startedAt)) : null;
  const insights = trace.insights || getTraceInsights(trace);

  return {
    costUsd: getUsageCostUsd(trace.usage),
    durationMs,
    endedAt: trace.endedAt,
    flags: {
      hasHighlights: insights.highlights.length > 0,
      hasStructuredInput: insights.structuredInputs.length > 0,
    },
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

function collectTraceMessages(trace: TraceRecord): Array<{
  content: unknown;
  role: string;
  source: string;
}> {
  const entries: Array<{ content: unknown; role: string; source: string }> = [];
  const requestMessages = trace.request?.input?.messages;

  if (Array.isArray(requestMessages)) {
    for (const [index, message] of requestMessages.entries()) {
      entries.push({
        content: message?.content,
        role: typeof message?.role === 'string' ? message.role : 'unknown',
        source: `request:${index}`,
      });
    }
  }

  const responseMessage = trace.response?.message || trace.stream?.reconstructed?.message;
  if (responseMessage?.content !== undefined) {
    entries.push({
      content: responseMessage.content,
      role: typeof responseMessage.role === 'string' ? responseMessage.role : 'assistant',
      source: 'response:0',
    });
  }

  return entries;
}

function toInsightText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (typeof item?.text === 'string') {
          return item.text;
        }

        if (typeof item?.text?.value === 'string') {
          return item.text.value;
        }

        if (typeof item?.content === 'string') {
          return item.content;
        }

        return '';
      })
      .filter(Boolean);

    return parts.length ? parts.join('\n\n').trim() : null;
  }

  if (typeof (content as any)?.text === 'string') {
    return (content as any).text.trim() || null;
  }

  if (typeof (content as any)?.text?.value === 'string') {
    return (content as any).text.value.trim() || null;
  }

  if (typeof (content as any)?.content === 'string') {
    return (content as any).content.trim() || null;
  }

  return null;
}

function detectStructuredMarkup(text: string): { snippet: string; tags: string[] } | null {
  const tagRegex = /<\/?([A-Za-z][\w:-]*)\b[^>]*>/g;
  const tagNames: string[] = [];
  let match = tagRegex.exec(text);

  while (match) {
    tagNames.push(match[1].toLowerCase());
    match = tagRegex.exec(text);
  }

  const uniqueTags = [...new Set(tagNames)];
  if (!uniqueTags.length) {
    return null;
  }

  const hasInstructionalTag = uniqueTags.some((tag) =>
    ['assistant', 'instruction', 'option', 'policy', 'system', 'user'].includes(tag),
  );
  const hasMultipleTags = uniqueTags.length >= 2;
  const hasClosingTag = /<\/[A-Za-z][\w:-]*>/.test(text);

  if (!hasClosingTag && !hasInstructionalTag && !hasMultipleTags) {
    return null;
  }

  return {
    snippet: createSnippet(text, 220),
    tags: uniqueTags.slice(0, 6),
  };
}

function looksLikeLongPrompt(text: string): boolean {
  return text.length >= 1200 || countLines(text) >= 20;
}

function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}

function createSnippet(text: string, maxLength: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}...`;
}

function capitalize(value: string): string {
  if (!value) {
    return '';
  }

  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
