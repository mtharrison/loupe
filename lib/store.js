'use strict';

const { EventEmitter } = require('node:events');
const { normalizeTraceContext, safeClone, sanitizeHeaders, toErrorPayload, toSummary } = require('./utils');

class TraceStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxTraces = Math.max(1, Number(options.maxTraces) || 1000);
    this.order = [];
    this.traces = new Map();
  }

  recordInvokeStart(context, request) {
    return this.#recordStart('invoke', context, request);
  }

  recordInvokeFinish(traceId, response) {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return;
    }

    trace.response = safeClone(response);
    trace.usage = safeClone(response?.usage);
    trace.status = 'ok';
    trace.endedAt = new Date().toISOString();
    this.#publish('trace:update', traceId, { trace: this.#cloneTrace(trace) });
  }

  recordStreamStart(context, request) {
    return this.#recordStart('stream', context, request);
  }

  recordStreamChunk(traceId, chunk) {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return;
    }

    const clone = safeClone(chunk);
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

    this.#publish('trace:update', traceId, { trace: this.#cloneTrace(trace) });
  }

  recordStreamFinish(traceId, chunk) {
    this.recordStreamChunk(traceId, chunk);
  }

  recordError(traceId, error) {
    const trace = this.traces.get(traceId);
    if (!trace) {
      return;
    }

    trace.error = toErrorPayload(error);
    trace.status = 'error';
    trace.endedAt = new Date().toISOString();
    this.#publish('trace:update', traceId, { trace: this.#cloneTrace(trace) });
  }

  list(filters = {}) {
    const items = this.#filteredTraces(filters).map(toSummary);
    const response = {
      items,
      total: this.order.length,
      filtered: items.length,
    };

    if (filters.groupBy) {
      response.groups = groupTraceSummaries(items, filters.groupBy);
    }

    return response;
  }

  get(traceId) {
    const trace = this.traces.get(traceId);
    return trace ? this.#cloneTrace(trace) : null;
  }

  clear() {
    this.order = [];
    this.traces.clear();
    this.#publish('trace:clear', null, {});
  }

  hierarchy(filters = {}) {
    const traces = this.#filteredTraces(filters);
    if (filters.groupBy) {
      return {
        total: this.order.length,
        filtered: traces.length,
        rootNodes: buildGroupHierarchy(traces, filters.groupBy),
      };
    }

    const roots = new Map();

    for (const trace of traces) {
      const chatId = trace.hierarchy.chatId || 'unknown-chat';
      const chatNode = getOrCreateNode(roots, `chat:${chatId}`, 'chat', `Chat ${chatId}`, { chatId });

      const topLevelAgentId = trace.hierarchy.topLevelAgentId || 'unknown-agent';
      const agentNode = getOrCreateNode(chatNode.children, `agent:${chatId}:${topLevelAgentId}`, 'agent', topLevelAgentId, {
        chatId,
        agentId: topLevelAgentId,
      });

      let currentNode = agentNode;

      if (trace.hierarchy.kind === 'watchdog') {
        const label = `${trace.hierarchy.watchdogPhase || 'watchdog'} filter`;
        currentNode = getOrCreateNode(
          currentNode.children,
          `watchdog:${chatId}:${topLevelAgentId}:${trace.context.systemType || label}`,
          'watchdog',
          label,
          {
            systemType: trace.context.systemType || null,
            watchdogPhase: trace.hierarchy.watchdogPhase || null,
          },
        );
      } else if (trace.hierarchy.delegatedAgentId) {
        currentNode = getOrCreateNode(
          currentNode.children,
          `delegated:${chatId}:${topLevelAgentId}:${trace.hierarchy.delegatedAgentId}`,
          'delegated-agent',
          trace.hierarchy.delegatedAgentId,
          {
            agentId: trace.hierarchy.delegatedAgentId,
          },
        );
      }

      if (trace.hierarchy.workflowState) {
        currentNode = getOrCreateNode(
          currentNode.children,
          `state:${chatId}:${topLevelAgentId}:${trace.hierarchy.delegatedAgentId || 'root'}:${trace.hierarchy.workflowState}`,
          'workflow-state',
          trace.hierarchy.workflowState,
          {
            workflowState: trace.hierarchy.workflowState,
          },
        );
      }

      const traceNode = createTraceNode(trace);
      currentNode.children.set(traceNode.id, traceNode);

      for (const node of new Set([chatNode, agentNode, currentNode])) {
        node.traceIds.push(trace.id);
        node.count += 1;
      }
    }

    return {
      total: this.order.length,
      filtered: traces.length,
      rootNodes: [...roots.values()].map(serialiseNode),
    };
  }

  #recordStart(mode, context, request) {
    const traceContext = normalizeTraceContext(context, mode);
    const traceId = randomId();
    const startedAt = new Date().toISOString();
    const trace = {
      id: traceId,
      mode,
      status: 'pending',
      startedAt,
      endedAt: null,
      provider: traceContext.provider,
      model: traceContext.model,
      kind: traceContext.kind,
      tags: traceContext.tags,
      hierarchy: traceContext.hierarchy,
      context: traceContext,
      request: {
        input: safeClone(request?.input),
        options: {
          ...(request?.options ? safeClone(request.options) : {}),
          headers: sanitizeHeaders(request?.options?.headers),
        },
      },
      response: null,
      usage: null,
      error: null,
      stream:
        mode === 'stream'
          ? {
              events: [],
              chunkCount: 0,
              firstChunkMs: null,
              reconstructed: {
                message: { role: null, content: null },
                tool_calls: [],
                usage: null,
              },
            }
          : null,
    };

    this.order.push(traceId);
    this.traces.set(traceId, trace);
    this.#evictIfNeeded();
    this.#publish('trace:add', traceId, { trace: this.#cloneTrace(trace) });

    return traceId;
  }

  #evictIfNeeded() {
    while (this.order.length > this.maxTraces) {
      const oldest = this.order.shift();
      const removed = this.traces.get(oldest);
      this.traces.delete(oldest);
      this.#publish('trace:evict', oldest, removed ? { trace: this.#cloneTrace(removed) } : {});
    }
  }

  #cloneTrace(trace) {
    return safeClone(trace);
  }

  #filteredTraces(filters = {}) {
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
            request: trace.request,
            response: trace.response,
            stream: trace.stream,
            error: trace.error,
            context: trace.context,
            tags: trace.tags,
          }).toLowerCase();

          if (!haystack.includes(needle)) {
            return false;
          }
        }

        return true;
      })
      .reverse();
  }

  #publish(type, traceId, payload) {
    this.emit('event', {
      type,
      traceId,
      timestamp: new Date().toISOString(),
      ...payload,
    });
  }
}

function groupTraceSummaries(items, groupBy) {
  const groups = new Map();
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

function normalizeTagFilters(value) {
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

function getOrCreateNode(collection, id, type, label, meta = {}) {
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

  return collection.get(id);
}

function createTraceNode(trace) {
  return {
    id: `trace:${trace.id}`,
    type: 'trace',
    label: trace.model ? `${trace.model} ${trace.mode}` : trace.id,
    count: 1,
    meta: {
      traceId: trace.id,
      status: trace.status,
      provider: trace.provider,
      model: trace.model,
    },
    traceIds: [trace.id],
    children: new Map(),
  };
}

function serialiseNode(node) {
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

function buildGroupHierarchy(traces, groupBy) {
  const groups = new Map();

  for (const trace of traces) {
    const value = trace.tags[groupBy] || 'ungrouped';
    const node = getOrCreateNode(groups, `group:${groupBy}:${value}`, 'group', `${groupBy}: ${value}`, {
      groupBy,
      value,
    });
    node.traceIds.push(trace.id);
    node.count += 1;
    node.children.set(`trace:${trace.id}`, createTraceNode(trace));
  }

  return [...groups.values()].map(serialiseNode);
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  TraceStore,
};
