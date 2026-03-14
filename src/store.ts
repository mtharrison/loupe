import { EventEmitter } from 'node:events';
import {
  type HierarchyNode,
  type HierarchyResponse,
  type NormalizedTraceContext,
  type TraceEvent,
  type TraceFilters,
  type TraceListResponse,
  type TraceRecord,
  type TraceRequest,
  type TraceSummary,
} from './types';
import { getTraceInsights, getUsageCostUsd, normalizeTraceContext, safeClone, sanitizeHeaders, toErrorPayload, toSummary } from './utils';

type MutableHierarchyNode = Omit<HierarchyNode, 'children'> & {
  children: Map<string, MutableHierarchyNode>;
};

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

  recordInvokeStart(context: NormalizedTraceContext | undefined, request: TraceRequest): string {
    return this.recordStart('invoke', context, request);
  }

  recordInvokeFinish(traceId: string, response: any) {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return;
    }

    trace.response = safeClone(response);
    trace.usage = safeClone(response?.usage);
    trace.status = 'ok';
    trace.endedAt = new Date().toISOString();
    this.publish('trace:update', traceId, { trace: this.cloneTrace(trace) });
  }

  recordStreamStart(context: NormalizedTraceContext | undefined, request: TraceRequest): string {
    return this.recordStart('stream', context, request);
  }

  recordStreamChunk(traceId: string, chunk: any) {
    const trace = this.traces.get(traceId);
    if (!trace || !trace.stream) {
      return;
    }

    const clone = safeClone(chunk);
    if (clone && typeof clone === 'object') {
      clone.offsetMs = Math.max(0, Date.now() - Date.parse(trace.startedAt));
    }
    trace.stream.events.push(clone);

    if (chunk?.type === 'chunk') {
      trace.stream.chunkCount += 1;
      if (trace.stream.firstChunkMs === null) {
        trace.stream.firstChunkMs = Date.now() - Date.parse(trace.startedAt);
      }

      if (typeof chunk.content === 'string') {
        trace.stream.reconstructed.message.content = `${trace.stream.reconstructed.message.content || ''}${chunk.content}`;
      }
    }

    if (chunk?.type === 'begin') {
      trace.stream.reconstructed.message.role = chunk.role;
    }

    if (chunk?.type === 'finish') {
      trace.response = clone;
      trace.usage = safeClone(chunk.usage);
      trace.stream.reconstructed.message = {
        ...(safeClone(chunk.message) || {}),
        content:
          trace.stream.reconstructed.message.content ||
          (typeof chunk.message?.content === 'string' ? chunk.message.content : chunk.message?.content ?? null),
      };
      trace.stream.reconstructed.tool_calls = safeClone(chunk.tool_calls || []);
      trace.stream.reconstructed.usage = safeClone(chunk.usage || null);
      trace.status = 'ok';
      trace.endedAt = new Date().toISOString();
    }

    this.publish('trace:update', traceId, { trace: this.cloneTrace(trace) });
  }

  recordStreamFinish(traceId: string, chunk: any) {
    this.recordStreamChunk(traceId, chunk);
  }

  recordError(traceId: string, error: unknown) {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return;
    }

    trace.error = toErrorPayload(error);
    trace.status = 'error';
    trace.endedAt = new Date().toISOString();
    this.publish('trace:update', traceId, { trace: this.cloneTrace(trace) });
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
    this.publish('trace:clear', null, {});
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

    for (const trace of traces) {
      const sessionId = trace.hierarchy.sessionId || 'unknown-session';
      const sessionNode = getOrCreateNode(roots, `session:${sessionId}`, 'session', `Session ${sessionId}`, {
        sessionId,
        chatId: trace.hierarchy.chatId,
      });
      const lineage = [sessionNode];

      const rootActorId = trace.hierarchy.rootActorId || 'unknown-actor';
      const actorNode = getOrCreateNode(sessionNode.children, `actor:${sessionId}:${rootActorId}`, 'actor', rootActorId, {
        actorId: rootActorId,
        rootActorId,
        sessionId,
        topLevelAgentId: trace.hierarchy.topLevelAgentId,
      });
      lineage.push(actorNode);

      let currentNode = actorNode;

      if (trace.hierarchy.kind === 'guardrail') {
        const label = `${trace.hierarchy.guardrailPhase || 'guardrail'} guardrail`;
        currentNode = getOrCreateNode(
          currentNode.children,
          `guardrail:${sessionId}:${rootActorId}:${trace.context.guardrailType || label}`,
          'guardrail',
          label,
          {
            guardrailPhase: trace.hierarchy.guardrailPhase || null,
            guardrailType: trace.context.guardrailType || null,
            systemType: trace.context.systemType || null,
            watchdogPhase: trace.hierarchy.watchdogPhase || null,
          },
        );
        lineage.push(currentNode);
      } else if (trace.hierarchy.childActorId) {
        currentNode = getOrCreateNode(
          currentNode.children,
          `child-actor:${sessionId}:${rootActorId}:${trace.hierarchy.childActorId}`,
          'child-actor',
          trace.hierarchy.childActorId,
          {
            actorId: trace.hierarchy.childActorId,
            childActorId: trace.hierarchy.childActorId,
            delegatedAgentId: trace.hierarchy.delegatedAgentId,
          },
        );
        lineage.push(currentNode);
      }

      if (trace.hierarchy.stage) {
        currentNode = getOrCreateNode(
          currentNode.children,
          `stage:${sessionId}:${rootActorId}:${trace.hierarchy.childActorId || 'root'}:${trace.hierarchy.stage}`,
          'stage',
          trace.hierarchy.stage,
          {
            stage: trace.hierarchy.stage,
            workflowState: trace.hierarchy.workflowState,
          },
        );
        lineage.push(currentNode);
      }

      const traceNode = createTraceNode(trace);
      currentNode.children.set(traceNode.id, traceNode);

      for (const node of new Set(lineage)) {
        applyTraceRollup(node, trace);
      }
    }

    return {
      total: this.order.length,
      filtered: traces.length,
      rootNodes: [...roots.values()].map(serialiseNode),
    };
  }

  private recordStart(mode: TraceRecord['mode'], context: NormalizedTraceContext | undefined, request: TraceRequest): string {
    const traceContext = normalizeTraceContext(context as any, mode);
    const traceId = randomId();
    const startedAt = new Date().toISOString();
    const trace: TraceRecord = {
      context: traceContext,
      endedAt: null,
      error: null,
      hierarchy: traceContext.hierarchy,
      id: traceId,
      kind: traceContext.kind,
      mode,
      model: traceContext.model,
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
    this.publish('trace:add', traceId, { trace: this.cloneTrace(trace) });

    return traceId;
  }

  private evictIfNeeded() {
    while (this.order.length > this.maxTraces) {
      const oldest = this.order.shift();
      const removed = oldest ? this.traces.get(oldest) : null;
      if (oldest) {
        this.traces.delete(oldest);
      }
      this.publish('trace:evict', oldest || null, removed ? { trace: this.cloneTrace(removed) } : {});
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
      type,
      traceId,
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

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
