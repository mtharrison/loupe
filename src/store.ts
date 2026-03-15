import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  type HierarchyNode,
  type HierarchyResponse,
  type NormalizedTraceContext,
  type SpanAttributes,
  type SpanEvent,
  type SpanEventInput,
  type SpanStartOptions,
  type TraceEvent,
  type TraceFilters,
  type TraceListResponse,
  type TraceRecord,
  type TraceRequest,
  type TraceSummary,
} from './types';
import { getTraceInsights, getUsageCostUsd, normalizeTraceContext, safeClone, sanitizeHeaders, toErrorPayload, toSpanEventInputFromChunk, toSummary } from './utils';

type MutableHierarchyNode = Omit<HierarchyNode, 'children'> & {
  children: Map<string, MutableHierarchyNode>;
};

const STREAM_EVENT_NAME_PREFIX = 'stream.';

export class TraceStore extends EventEmitter {
  maxTraces: number;
  order: string[];
  traces: Map<string, TraceRecord>;

  constructor(options: { maxTraces?: number } = {}) {
    super();
    this.maxTraces = Math.max(1, Number(options.maxTraces) || 1000);
    this.order = [];
    this.traces = new Map();
  }

  startSpan(context: NormalizedTraceContext | undefined, options: SpanStartOptions = {}): string {
    return this.recordStart(options.mode || 'invoke', context, options.request || {}, options);
  }

  addSpanEvent(spanId: string, event: SpanEventInput) {
    // Loupe returns its own stable span handle from startSpan(). That handle is used to
    // look up mutable in-memory records here, while trace.spanContext.spanId stores the
    // OpenTelemetry span ID exposed on the resulting span data.
    const trace = this.traces.get(spanId);
    if (!trace) {
      return;
    }

    const spanEvent = normalizeSpanEvent(event);
    trace.events.push(spanEvent);
    this.applyStreamPayload(trace, event.payload, spanEvent);
    this.publish('span:update', spanId, { trace: this.cloneTrace(trace) });
  }

  endSpan(spanId: string, response: any) {
    const trace = this.traces.get(spanId);
    if (!trace) {
      return;
    }

    const clone = safeClone(response);
    if (trace.mode === 'stream') {
      const finishEvent = normalizeSpanEvent(toSpanEventInputFromChunk(clone));
      trace.events.push(finishEvent);
      this.applyStreamPayload(trace, clone, finishEvent);
      trace.response = clone;
      trace.usage = safeClone(clone?.usage);
    } else {
      trace.response = clone;
      trace.usage = safeClone(clone?.usage);
    }

    applyResponseAttributes(trace, clone);
    trace.status = 'ok';
    trace.spanStatus = { code: 'OK' };
    trace.endedAt = new Date().toISOString();
    this.publish('span:end', spanId, { trace: this.cloneTrace(trace) });
  }

  recordException(spanId: string, error: unknown) {
    const trace = this.traces.get(spanId);
    if (!trace) {
      return;
    }

    const payload = toErrorPayload(error);
    trace.error = payload;
    trace.events.push({
      attributes: payload || {},
      name: 'exception',
      timestamp: new Date().toISOString(),
    });
    trace.status = 'error';
    trace.spanStatus = {
      code: 'ERROR',
      message: payload?.message,
    };
    if (payload?.name || payload?.type || payload?.code || payload?.status) {
      trace.attributes['error.type'] = String(payload.name || payload.type || payload.code || payload.status);
    }
    trace.endedAt = new Date().toISOString();
    this.publish('span:end', spanId, { trace: this.cloneTrace(trace) });
  }

  private applyStreamPayload(trace: TraceRecord, payload: unknown, spanEvent: SpanEvent) {
    if (!trace.stream) {
      return;
    }

    const clone = toStreamPayload(payload, spanEvent);
    if (clone && typeof clone === 'object') {
      clone.offsetMs = Math.max(0, Date.now() - Date.parse(trace.startedAt));
    }
    trace.stream.events.push(clone);

    if (clone?.type === 'chunk') {
      trace.stream.chunkCount += 1;
      if (trace.stream.firstChunkMs === null) {
        trace.stream.firstChunkMs = Date.now() - Date.parse(trace.startedAt);
      }

      if (typeof clone.content === 'string') {
        trace.stream.reconstructed.message.content = `${trace.stream.reconstructed.message.content || ''}${clone.content}`;
      }
    }

    if (clone?.type === 'begin') {
      trace.stream.reconstructed.message.role = clone.role;
    }

    if (clone?.type === 'finish') {
      trace.response = clone;
      trace.usage = safeClone(clone.usage);
      trace.stream.reconstructed.message = {
        ...(safeClone(clone.message) || {}),
        content:
          trace.stream.reconstructed.message.content ||
          (typeof clone.message?.content === 'string' ? clone.message.content : clone.message?.content ?? null),
      };
      trace.stream.reconstructed.tool_calls = safeClone(clone.tool_calls || []);
      trace.stream.reconstructed.usage = safeClone(clone.usage || null);
    }
  }

  list(filters: TraceFilters = {}): TraceListResponse {
    const items = this.filteredTraces(filters).map(toSummary);
    const response: TraceListResponse = {
      items,
      total: this.order.length,
      filtered: items.length,
    };

    if (filters.groupBy) {
      response.groups = groupTraceSummaries(items, filters.groupBy);
    }

    return response;
  }

  get(traceId: string): TraceRecord | null {
    const trace = this.traces.get(traceId);
    return trace ? this.cloneTrace(trace) : null;
  }

  clear() {
    this.order = [];
    this.traces.clear();
    this.publish('span:clear', null, {});
  }

  hierarchy(filters: TraceFilters = {}): HierarchyResponse {
    const traces = this.filteredTraces(filters);
    if (filters.groupBy) {
      return {
        total: this.order.length,
        filtered: traces.length,
        rootNodes: buildGroupHierarchy(traces, filters.groupBy),
      };
    }

    const roots = new Map<string, MutableHierarchyNode>();
    const traceBySpanId = new Map<string, TraceRecord>();
    const traceNodeByTraceId = new Map<string, MutableHierarchyNode>();
    const traceSessionByTraceId = new Map<string, string>();
    const parentNodeById = new Map<string, MutableHierarchyNode>();

    for (const trace of traces) {
      const sessionId = getTraceSessionId(trace);
      const sessionNode = getOrCreateNode(roots, `session:${sessionId}`, 'session', `Session ${sessionId}`, {
        sessionId,
        chatId: trace.hierarchy.chatId,
        rootActorId: trace.hierarchy.rootActorId,
        topLevelAgentId: trace.hierarchy.topLevelAgentId,
      });
      const traceNode = createTraceNode(trace);
      traceBySpanId.set(trace.spanContext.spanId, trace);
      traceNodeByTraceId.set(trace.id, traceNode);
      traceSessionByTraceId.set(trace.id, sessionId);
    }

    for (const trace of traces) {
      const sessionId = traceSessionByTraceId.get(trace.id) || 'unknown-session';
      const sessionNode = roots.get(`session:${sessionId}`);
      const traceNode = traceNodeByTraceId.get(trace.id);
      if (!sessionNode || !traceNode) {
        continue;
      }

      const parentTrace = trace.parentSpanId ? traceBySpanId.get(trace.parentSpanId) : null;
      const parentTraceNode =
        parentTrace &&
        traceSessionByTraceId.get(parentTrace.id) === sessionId &&
        parentTrace.id !== trace.id
          ? traceNodeByTraceId.get(parentTrace.id) || null
          : null;
      parentNodeById.set(traceNode.id, parentTraceNode || sessionNode);
    }

    for (const trace of traces) {
      const traceNode = traceNodeByTraceId.get(trace.id);
      const parentNode = traceNode ? parentNodeById.get(traceNode.id) || null : null;
      if (!traceNode || !parentNode) {
        continue;
      }

      parentNode.children.set(traceNode.id, traceNode);

      let currentNode = parentNode;
      while (currentNode) {
        applyTraceRollup(currentNode, trace);
        currentNode = parentNodeById.get(currentNode.id) || null;
      }
    }

    return {
      total: this.order.length,
      filtered: traces.length,
      rootNodes: [...roots.values()].map(serialiseNode),
    };
  }

  private recordStart(
    mode: TraceRecord['mode'],
    context: NormalizedTraceContext | undefined,
    request: TraceRequest,
    options: Pick<SpanStartOptions, 'attributes' | 'kind' | 'name' | 'parentSpanId'> = {},
  ): string {
    const traceContext = applyConversationIdToContext(normalizeTraceContext(context as any, mode), options.attributes);
    const traceId = randomId();
    const parentSpan = this.findTraceBySpanReference(options.parentSpanId);
    const startedAt = new Date().toISOString();
    const trace: TraceRecord = {
      attributes: buildSpanAttributes(traceContext, mode, request, options.attributes),
      context: traceContext,
      endedAt: null,
      error: null,
      events: [],
      hierarchy: traceContext.hierarchy,
      id: traceId,
      kind: traceContext.kind,
      mode,
      model: traceContext.model,
      name: options.name || getDefaultSpanName(traceContext, mode),
      parentSpanId: parentSpan?.spanContext.spanId || options.parentSpanId || null,
      provider: traceContext.provider,
      request: {
        input: safeClone(request?.input),
        options: {
          ...(request?.options ? safeClone(request.options) : {}),
          headers: sanitizeHeaders(request?.options?.headers),
        },
      },
      response: null,
      startedAt,
      spanContext: {
        // The returned Loupe span handle (trace.id) is used for local mutation and SSE updates.
        // spanContext contains the OpenTelemetry trace/span identifiers that are attached to
        // the exported span payload and inherited by child spans.
        spanId: randomHexId(16),
        traceId: parentSpan?.spanContext.traceId || randomHexId(32),
      },
      spanKind: options.kind || 'CLIENT',
      spanStatus: { code: 'UNSET' },
      status: 'pending',
      stream:
        mode === 'stream'
          ? {
              chunkCount: 0,
              events: [],
              firstChunkMs: null,
              reconstructed: {
                message: { role: null, content: null },
                tool_calls: [],
                usage: null,
              },
            }
          : null,
      tags: traceContext.tags,
      usage: null,
    };

    this.order.push(traceId);
    this.traces.set(traceId, trace);
    this.evictIfNeeded();
    this.publish('span:start', traceId, { trace: this.cloneTrace(trace) });

    return traceId;
  }

  private findTraceBySpanReference(spanReference: string | null | undefined): TraceRecord | null {
    if (!spanReference) {
      return null;
    }

    const byTraceId = this.traces.get(spanReference);
    if (byTraceId) {
      return byTraceId;
    }

    for (const trace of this.traces.values()) {
      if (trace.spanContext.spanId === spanReference) {
        return trace;
      }
    }

    return null;
  }

  private evictIfNeeded() {
    while (this.order.length > this.maxTraces) {
      const oldest = this.order.shift();
      const removed = oldest ? this.traces.get(oldest) : null;
      if (oldest) {
        this.traces.delete(oldest);
      }
      this.publish('span:evict', oldest || null, removed ? { trace: this.cloneTrace(removed) } : {});
    }
  }

  private cloneTrace(trace: TraceRecord): TraceRecord {
    return {
      ...safeClone(trace),
      insights: getTraceInsights(trace),
    };
  }

  private filteredTraces(filters: TraceFilters = {}): TraceRecord[] {
    const tagFilters = normalizeTagFilters(filters.tags || filters.tagFilters);

    return this.order
      .map((id) => this.traces.get(id))
      .filter(Boolean)
      .filter((trace) => {
        if (filters.status && trace.status !== filters.status) {
          return false;
        }

        if (filters.kind && trace.kind !== filters.kind) {
          return false;
        }

        if (filters.model && trace.model !== filters.model) {
          return false;
        }

        if (filters.provider && trace.provider !== filters.provider) {
          return false;
        }

        if (filters.traceIds && !filters.traceIds.includes(trace.id)) {
          return false;
        }

        if (tagFilters.length > 0) {
          for (const [key, value] of tagFilters) {
            if (trace.tags[key] !== value) {
              return false;
            }
          }
        }

        if (filters.search) {
          const needle = String(filters.search).toLowerCase();
          const haystack = JSON.stringify({
            context: trace.context,
            error: trace.error,
            request: trace.request,
            response: trace.response,
            stream: trace.stream,
            tags: trace.tags,
          }).toLowerCase();

          if (!haystack.includes(needle)) {
            return false;
          }
        }

        return true;
      })
      .reverse() as TraceRecord[];
  }

  private publish(type: string, traceId: string | null, payload: { trace?: TraceRecord }) {
    const event: TraceEvent = {
      span: payload.trace,
      spanId: traceId,
      type,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    this.emit('event', event);
  }
}

function groupTraceSummaries(items: TraceSummary[], groupBy: string): Array<{ count: number; items: TraceSummary[]; value: string }> {
  const groups = new Map<string, { count: number; items: TraceSummary[]; value: string }>();

  for (const item of items) {
    const groupValue = item.tags[groupBy] || 'ungrouped';
    const group = groups.get(groupValue) || {
      value: groupValue,
      count: 0,
      items: [],
    };
    group.count += 1;
    group.items.push(item);
    groups.set(groupValue, group);
  }

  return [...groups.values()];
}

function normalizeTagFilters(value?: string[]): string[][] {
  if (!value) {
    return [];
  }

  const entries = Array.isArray(value) ? value : [value];

  return entries
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, ...rest] = entry.split(':');
      return [key, rest.join(':')];
    })
    .filter(([key, filterValue]) => key && filterValue);
}

function getOrCreateNode(
  collection: Map<string, MutableHierarchyNode>,
  id: string,
  type: string,
  label: string,
  meta: Record<string, any> = {},
): MutableHierarchyNode {
  if (!collection.has(id)) {
    collection.set(id, {
      id,
      type,
      label,
      count: 0,
      meta,
      traceIds: [],
      children: new Map(),
    });
  }

  return collection.get(id) as MutableHierarchyNode;
}

function createTraceNode(trace: TraceRecord): MutableHierarchyNode {
  return {
    id: `trace:${trace.id}`,
    type: 'trace',
    label: trace.model ? `${trace.model} ${trace.mode}` : trace.id,
    count: 1,
    meta: {
      costUsd: getUsageCostUsd(trace.usage),
      traceId: trace.id,
      status: trace.status,
      provider: trace.provider,
      model: trace.model,
    },
    traceIds: [trace.id],
    children: new Map(),
  };
}

function applyTraceRollup(node: MutableHierarchyNode, trace: TraceRecord) {
  node.traceIds.push(trace.id);
  node.count += 1;

  const traceCost = getUsageCostUsd(trace.usage);
  if (traceCost !== null) {
    node.meta.costUsd = (typeof node.meta.costUsd === 'number' ? node.meta.costUsd : 0) + traceCost;
  }
}

function serialiseNode(node: MutableHierarchyNode): HierarchyNode {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    count: node.count,
    traceIds: [...node.traceIds],
    meta: safeClone(node.meta),
    children: [...node.children.values()].map(serialiseNode),
  };
}

function buildGroupHierarchy(traces: TraceRecord[], groupBy: string): HierarchyNode[] {
  const groups = new Map<string, MutableHierarchyNode>();

  for (const trace of traces) {
    const value = trace.tags[groupBy] || 'ungrouped';
    const node = getOrCreateNode(groups, `group:${groupBy}:${value}`, 'group', `${groupBy}: ${value}`, {
      groupBy,
      value,
    });
    applyTraceRollup(node, trace);
    node.children.set(`trace:${trace.id}`, createTraceNode(trace));
  }

  return [...groups.values()].map(serialiseNode);
}

function getTraceSessionId(trace: TraceRecord): string {
  const conversationId = toNonEmptyString(trace.attributes?.['gen_ai.conversation.id']);
  return conversationId || trace.hierarchy.sessionId || 'unknown-session';
}

function applyConversationIdToContext(
  context: NormalizedTraceContext,
  extraAttributes: SpanAttributes | undefined,
): NormalizedTraceContext {
  const conversationId = toNonEmptyString(extraAttributes?.['gen_ai.conversation.id']);
  if (!conversationId || conversationId === context.sessionId) {
    return context;
  }

  return {
    ...context,
    sessionId: conversationId,
    chatId: conversationId,
    rootSessionId: context.rootSessionId || conversationId,
    rootChatId: context.rootChatId || conversationId,
    tags: {
      ...context.tags,
      sessionId: conversationId,
      chatId: conversationId,
      rootSessionId: context.rootSessionId || conversationId,
      rootChatId: context.rootChatId || conversationId,
    },
    hierarchy: {
      ...context.hierarchy,
      sessionId: conversationId,
      chatId: conversationId,
    },
  };
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomHexId(length: number): string {
  if (length % 2 !== 0) {
    throw new RangeError(`OpenTelemetry hex IDs must have an even length. Received: ${length}`);
  }

  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function normalizeSpanEvent(event: SpanEventInput): SpanEvent {
  const attributes = safeClone(event.attributes || {});
  if (event.name === 'stream.finish') {
    attributes['gen_ai.message.status'] = attributes['gen_ai.message.status'] || 'completed';
  } else if (event.name.startsWith(STREAM_EVENT_NAME_PREFIX)) {
    attributes['gen_ai.message.status'] = attributes['gen_ai.message.status'] || 'in_progress';
  }
  if (attributes.finish_reasons && attributes['gen_ai.response.finish_reasons'] === undefined) {
    attributes['gen_ai.response.finish_reasons'] = safeClone(attributes.finish_reasons);
  }
  if (attributes.message && attributes['gen_ai.output.messages'] === undefined) {
    attributes['gen_ai.output.messages'] = [safeClone(attributes.message)];
  }
  return {
    attributes,
    name: event.name,
    timestamp: new Date().toISOString(),
  };
}

function toStreamPayload(payload: unknown, spanEvent: SpanEvent): Record<string, any> {
  if (payload && typeof payload === 'object') {
    return safeClone(payload as Record<string, any>);
  }

  // Generic addSpanEvent() callers may only provide an OpenTelemetry-style event name
  // plus attributes. Reconstruct the minimal legacy stream payload shape from that data
  // so the existing dashboard stream timeline can continue to render incrementally.
  const suffix = spanEvent.name.startsWith(STREAM_EVENT_NAME_PREFIX)
    ? spanEvent.name.slice(STREAM_EVENT_NAME_PREFIX.length)
    : spanEvent.name;
  const eventType = suffix || 'event';
  return {
    ...safeClone(spanEvent.attributes || {}),
    type: eventType,
  };
}

function getDefaultSpanName(context: NormalizedTraceContext, mode: TraceRecord['mode']): string {
  const prefix = context.provider || 'llm';
  return `${prefix}.${mode}`;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function buildSpanAttributes(
  context: NormalizedTraceContext,
  mode: TraceRecord['mode'],
  request: TraceRequest,
  extraAttributes: SpanAttributes | undefined,
): SpanAttributes {
  const base: SpanAttributes = {
    'gen_ai.conversation.id': context.sessionId || undefined,
    'gen_ai.input.messages': Array.isArray(request?.input?.messages) ? safeClone(request.input.messages) : undefined,
    'gen_ai.operation.name': inferGenAIOperationName(request, mode),
    'gen_ai.provider.name': context.provider || undefined,
    'gen_ai.request.choice.count': typeof request?.input?.n === 'number' ? request.input.n : undefined,
    'gen_ai.request.model': (typeof request?.input?.model === 'string' && request.input.model) || context.model || undefined,
    'gen_ai.system': context.provider || undefined,
    'loupe.actor.id': context.actorId || undefined,
    'loupe.actor.type': context.actorType || undefined,
    'loupe.guardrail.phase': context.guardrailPhase || undefined,
    'loupe.guardrail.type': context.guardrailType || undefined,
    'loupe.root_actor.id': context.rootActorId || undefined,
    'loupe.root_session.id': context.rootSessionId || undefined,
    'loupe.session.id': context.sessionId || undefined,
    'loupe.stage': context.stage || undefined,
    'loupe.tenant.id': context.tenantId || undefined,
    'loupe.user.id': context.userId || undefined,
  };

  for (const [key, value] of Object.entries(context.tags || {})) {
    base[`loupe.tag.${key}`] = value;
  }

  return Object.fromEntries(
    Object.entries({
      ...base,
      ...(extraAttributes || {}),
    }).filter(([, value]) => value !== undefined && value !== null),
  );
}

function applyResponseAttributes(trace: TraceRecord, response: any) {
  const finishReasons = Array.isArray(response?.finish_reasons)
    ? response.finish_reasons
    : response?.finish_reason
      ? [response.finish_reason]
      : [];
  const usage = response?.usage;

  if (typeof response?.model === 'string' && response.model) {
    trace.attributes['gen_ai.response.model'] = response.model;
  }
  if (usage?.tokens?.prompt !== undefined) {
    trace.attributes['gen_ai.usage.input_tokens'] = usage.tokens.prompt;
  }
  if (usage?.tokens?.completion !== undefined) {
    trace.attributes['gen_ai.usage.output_tokens'] = usage.tokens.completion;
  }
  if (finishReasons.length > 0) {
    trace.attributes['gen_ai.response.finish_reasons'] = safeClone(finishReasons);
  }
  if (response?.message) {
    trace.attributes['gen_ai.output.messages'] = [safeClone(response.message)];
    trace.attributes['gen_ai.output.type'] = inferGenAIOutputType(response.message.content);
  }
}

function inferGenAIOperationName(request: TraceRequest, mode: TraceRecord['mode']): string {
  if (Array.isArray(request?.input?.messages) && request.input.messages.length > 0) {
    return 'chat';
  }

  return mode;
}

function inferGenAIOutputType(content: unknown): string {
  if (typeof content === 'string' || Array.isArray(content)) {
    return 'text';
  }

  if (content && typeof content === 'object') {
    return 'json';
  }

  return 'unknown';
}
