import { createTraceServer } from './server';
import { TraceStore } from './store';
import { maybeStartUIWatcher } from './ui-build';
import { envFlag, safeClone } from './utils';
import {
  type ChatModelLike,
  type LocalLLMTracer,
  type OpenAIChatCompletionCreateParamsLike,
  type OpenAIChatCompletionStreamLike,
  type OpenAIClientLike,
  type TraceConfig,
  type TraceContext,
  type TraceRequest,
  type TraceServer,
  type UIWatchController,
} from './types';

export type {
  ChatModelLike,
  HierarchyNode,
  HierarchyResponse,
  LocalLLMTracer,
  NormalizedTraceContext,
  OpenAIChatCompletionCreateParamsLike,
  OpenAIChatCompletionStreamLike,
  OpenAIClientLike,
  TraceConfig,
  TraceContext,
  TraceEvent,
  TraceFilters,
  TraceHierarchy,
  TraceListResponse,
  TraceMode,
  TraceRecord,
  TraceRequest,
  TraceServer,
  TraceStatus,
  TraceSummary,
  TraceTags,
  UIReloadEvent,
} from './types';

let singleton: LocalLLMTracerImpl | null = null;
const DEFAULT_TRACE_PORT = 4319;

export function isTraceEnabled(): boolean {
  return envFlag('LLM_TRACE_ENABLED');
}

export function getLocalLLMTracer(config: TraceConfig = {}): LocalLLMTracer {
  if (!singleton) {
    singleton = new LocalLLMTracerImpl(config);
  } else if (config && Object.keys(config).length > 0) {
    singleton.configure(config);
  }

  return singleton;
}

export function startTraceServer(config: TraceConfig = {}) {
  return getLocalLLMTracer(config).startServer();
}

export function recordInvokeStart(context: TraceContext, request: TraceRequest, config: TraceConfig = {}): string {
  return getLocalLLMTracer(config).recordInvokeStart(context, request);
}

export function recordInvokeFinish(traceId: string, response: unknown, config: TraceConfig = {}) {
  getLocalLLMTracer(config).recordInvokeFinish(traceId, response);
}

export function recordStreamStart(context: TraceContext, request: TraceRequest, config: TraceConfig = {}): string {
  return getLocalLLMTracer(config).recordStreamStart(context, request);
}

export function recordStreamChunk(traceId: string, chunk: unknown, config: TraceConfig = {}) {
  getLocalLLMTracer(config).recordStreamChunk(traceId, chunk);
}

export function recordStreamFinish(traceId: string, chunk: unknown, config: TraceConfig = {}) {
  getLocalLLMTracer(config).recordStreamFinish(traceId, chunk);
}

export function recordError(traceId: string, error: unknown, config: TraceConfig = {}) {
  getLocalLLMTracer(config).recordError(traceId, error);
}

export function __resetLocalLLMTracerForTests() {
  if (singleton?.uiWatcher) {
    void singleton.uiWatcher.stop();
  }

  if (singleton?.server) {
    singleton.server.close();
  }

  singleton = null;
}

export function wrapChatModel<
  TModel extends ChatModelLike<TInput, TOptions, TValue, TChunk>,
  TInput = any,
  TOptions = any,
  TValue = any,
  TChunk = any,
>(model: TModel, getContext: () => TraceContext, config?: TraceConfig): TModel {
  if (!model || typeof model.invoke !== 'function' || typeof model.stream !== 'function') {
    throw new TypeError('wrapChatModel expects a ChatModel-compatible object.');
  }

  return {
    async invoke(input: TInput, options?: TOptions) {
      const tracer = getLocalLLMTracer(config);
      if (!tracer.isEnabled()) {
        return model.invoke(input, options);
      }

      const traceId = tracer.recordInvokeStart(getContext ? getContext() : {}, { input: input as any, options: options as any });
      try {
        const response = await model.invoke(input, options);
        tracer.recordInvokeFinish(traceId, response);
        return response;
      } catch (error) {
        tracer.recordError(traceId, error);
        throw error;
      }
    },

    async *stream(input: TInput, options?: TOptions) {
      const tracer = getLocalLLMTracer(config);
      if (!tracer.isEnabled()) {
        yield* model.stream(input, options);
        return;
      }

      const traceId = tracer.recordStreamStart(getContext ? getContext() : {}, { input: input as any, options: options as any });

      try {
        const stream = model.stream(input, options);
        for await (const chunk of stream) {
          if ((chunk as any)?.type === 'finish') {
            tracer.recordStreamFinish(traceId, chunk);
          } else {
            tracer.recordStreamChunk(traceId, chunk);
          }
          yield chunk;
        }
      } catch (error) {
        tracer.recordError(traceId, error);
        throw error;
      }
    },
  } as TModel;
}

export function wrapOpenAIClient<
  TClient extends OpenAIClientLike<TParams, TOptions, TResponse, TChunk>,
  TParams extends OpenAIChatCompletionCreateParamsLike = OpenAIChatCompletionCreateParamsLike,
  TOptions = Record<string, any>,
  TResponse = any,
  TChunk = any,
>(client: TClient, getContext: () => TraceContext, config?: TraceConfig): TClient {
  if (!client || typeof client.chat?.completions?.create !== 'function') {
    throw new TypeError('wrapOpenAIClient expects an OpenAI client with chat.completions.create().');
  }

  const wrappedCompletions = new Proxy(client.chat.completions as any, {
    get(target, prop, receiver) {
      if (prop === 'create') {
        return async (params: TParams, options?: TOptions) => {
          const tracer = getLocalLLMTracer(config);
          if (!tracer.isEnabled()) {
            return target.create.call(target, params, options);
          }

          const context = withOpenAITraceContext(getContext ? getContext() : {}, params);

          if (params?.stream) {
            const traceId = tracer.recordStreamStart(context, { input: params as any, options: options as any });

            try {
              const stream = await target.create.call(target, params, options);
              return wrapOpenAIChatCompletionsStream(stream, tracer, traceId);
            } catch (error) {
              tracer.recordError(traceId, error);
              throw error;
            }
          }

          const traceId = tracer.recordInvokeStart(context, { input: params as any, options: options as any });

          try {
            const response = await target.create.call(target, params, options);
            tracer.recordInvokeFinish(traceId, normalizeOpenAIChatCompletionResponse(response));
            return response;
          } catch (error) {
            tracer.recordError(traceId, error);
            throw error;
          }
        };
      }

      return bindMethod(target, Reflect.get(target, prop, receiver));
    },
  });

  const wrappedChat = new Proxy(client.chat as any, {
    get(target, prop, receiver) {
      if (prop === 'completions') {
        return wrappedCompletions;
      }

      return bindMethod(target, Reflect.get(target, prop, receiver));
    },
  });

  return new Proxy(client as any, {
    get(target, prop, receiver) {
      if (prop === 'chat') {
        return wrappedChat;
      }

      return bindMethod(target, Reflect.get(target, prop, receiver));
    },
  }) as TClient;
}

class LocalLLMTracerImpl implements LocalLLMTracer {
  config: Required<TraceConfig>;
  loggedUrl: boolean;
  portWasExplicit: boolean;
  server: TraceServer | null;
  serverFailed: boolean;
  serverInfo: { host: string; port: number; url: string } | null;
  serverStartPromise: Promise<{ host: string; port: number; url: string } | null> | null;
  store: TraceStore;
  uiWatcher: UIWatchController | null;

  constructor(config: TraceConfig = {}) {
    this.config = {
      host: '127.0.0.1',
      maxTraces: 1000,
      port: 4319,
      uiHotReload: false,
    };
    this.portWasExplicit = false;
    this.configure(config);
    this.store = new TraceStore({ maxTraces: this.config.maxTraces });
    this.server = null;
    this.serverInfo = null;
    this.serverStartPromise = null;
    this.serverFailed = false;
    this.loggedUrl = false;
    this.uiWatcher = null;
  }

  configure(config: TraceConfig = {}) {
    if (this.serverInfo && (config.host || config.port)) {
      return;
    }

    const explicitPort = getConfiguredPort(config.port, process.env.LLM_TRACE_PORT, this.portWasExplicit ? this.config.port : undefined);
    this.portWasExplicit = explicitPort !== undefined;

    this.config = {
      host: config.host || this.config.host || process.env.LLM_TRACE_HOST || '127.0.0.1',
      port: explicitPort ?? DEFAULT_TRACE_PORT,
      maxTraces: Number(config.maxTraces || this.config.maxTraces || process.env.LLM_TRACE_MAX_TRACES) || 1000,
      uiHotReload:
        typeof config.uiHotReload === 'boolean'
          ? config.uiHotReload
          : process.env.LLM_TRACE_UI_HOT_RELOAD
            ? envFlag('LLM_TRACE_UI_HOT_RELOAD')
            : !process.env.CI && !!process.stdout.isTTY && process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test',
    };

    if (this.store) {
      this.store.maxTraces = this.config.maxTraces;
    }
  }

  isEnabled(): boolean {
    return isTraceEnabled();
  }

  startServer(): Promise<{ host: string; port: number; url: string } | null> {
    if (!this.isEnabled() || this.serverFailed) {
      return Promise.resolve(this.serverInfo);
    }

    if (this.serverInfo) {
      return Promise.resolve(this.serverInfo);
    }

    if (this.serverStartPromise) {
      return this.serverStartPromise;
    }

    this.serverStartPromise = (async () => {
      try {
        this.server = createTraceServer(this.store, {
          ...this.config,
          allowPortFallback: !this.portWasExplicit,
        });
        this.serverInfo = await this.server.start();
        if (this.serverInfo && !this.uiWatcher) {
          this.uiWatcher = await maybeStartUIWatcher(() => {
            this.server?.broadcast({
              timestamp: new Date().toISOString(),
              traceId: null,
              type: 'ui:reload',
            });
          }, this.config.uiHotReload);
        }
        if (!this.loggedUrl && this.serverInfo) {
          this.loggedUrl = true;
          process.stdout.write(`[llm-trace] dashboard: ${this.serverInfo.url}\n`);
        }
        return this.serverInfo;
      } catch (error: any) {
        this.serverFailed = true;
        process.stderr.write(`[llm-trace] failed to start dashboard: ${error.message}\n`);
        return null;
      } finally {
        this.serverStartPromise = null;
      }
    })();

    return this.serverStartPromise;
  }

  recordInvokeStart(context: TraceContext, request: { input?: Record<string, any>; options?: Record<string, any> }): string {
    void this.startServer();
    return this.store.recordInvokeStart(context as any, normaliseRequest(request));
  }

  recordInvokeFinish(traceId: string, response: unknown) {
    this.store.recordInvokeFinish(traceId, safeClone(response));
  }

  recordStreamStart(context: TraceContext, request: { input?: Record<string, any>; options?: Record<string, any> }): string {
    void this.startServer();
    return this.store.recordStreamStart(context as any, normaliseRequest(request));
  }

  recordStreamChunk(traceId: string, chunk: unknown) {
    this.store.recordStreamChunk(traceId, safeClone(chunk));
  }

  recordStreamFinish(traceId: string, chunk: unknown) {
    this.store.recordStreamFinish(traceId, safeClone(chunk));
  }

  recordError(traceId: string, error: unknown) {
    this.store.recordError(traceId, error);
  }
}

function normaliseRequest(request: { input?: Record<string, any>; options?: Record<string, any> }) {
  return {
    input: safeClone(request?.input),
    options: safeClone(request?.options),
  };
}

function bindMethod<TTarget extends object>(target: TTarget, value: unknown) {
  return typeof value === 'function' ? value.bind(target) : value;
}

function getConfiguredPort(
  configPort: number | undefined,
  envPort: string | undefined,
  currentExplicitPort?: number,
): number | undefined {
  if (typeof configPort === 'number' && Number.isFinite(configPort)) {
    return configPort;
  }

  if (envPort !== undefined) {
    const parsed = Number(envPort);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return typeof currentExplicitPort === 'number' && Number.isFinite(currentExplicitPort) ? currentExplicitPort : undefined;
}

function withOpenAITraceContext(context: TraceContext | undefined, params: OpenAIChatCompletionCreateParamsLike | undefined): TraceContext {
  return {
    ...(context || {}),
    model: context?.model || (typeof params?.model === 'string' ? params.model : null),
    provider: context?.provider || 'openai',
  };
}

function wrapOpenAIChatCompletionsStream<TStream extends OpenAIChatCompletionStreamLike<TChunk>, TChunk = any>(
  stream: TStream,
  tracer: LocalLLMTracer,
  traceId: string,
): TStream {
  const state = {
    content: '',
    finished: false,
    finishReasons: [] as string[],
    began: false,
    role: null as string | null,
    toolCalls: new Map<number, Record<string, any>>(),
    usage: null as Record<string, any> | null,
  };

  const emitBegin = (role?: string | null) => {
    if (state.began) {
      return;
    }

    state.began = true;
    const nextRole = role || state.role || 'assistant';
    state.role = nextRole;
    tracer.recordStreamChunk(traceId, { type: 'begin', role: nextRole });
  };

  const emitFinish = () => {
    if (state.finished) {
      return;
    }

    emitBegin(state.role);
    state.finished = true;
    tracer.recordStreamFinish(traceId, {
      type: 'finish',
      finish_reasons: state.finishReasons,
      message: {
        role: state.role || 'assistant',
        content: state.content || null,
      },
      tool_calls: serializeOpenAIToolCalls(state.toolCalls),
      usage: safeClone(state.usage),
    });
  };

  const processChunk = (chunk: any) => {
    const raw = safeClone(chunk);
    const chunkToolCalls: Record<string, any>[] = [];
    const finishReasons = new Set<string>();
    const contentParts: string[] = [];
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
    let sawEvent = false;

    for (const choice of choices) {
      const delta = choice?.delta || {};

      if (typeof delta?.role === 'string' && delta.role) {
        state.role = delta.role;
        sawEvent = true;
      }

      for (const part of extractOpenAITextParts(delta?.content)) {
        state.content = `${state.content}${part}`;
        contentParts.push(part);
        sawEvent = true;
      }

      if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
        sawEvent = true;

        for (const toolCall of delta.tool_calls) {
          mergeOpenAIToolCallDelta(state.toolCalls, toolCall);
          chunkToolCalls.push(safeClone(toolCall));
        }
      }

      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        finishReasons.add(choice.finish_reason);
      }
    }

    const usage = normalizeOpenAIUsage(chunk?.usage);
    if (usage) {
      state.usage = usage;
      sawEvent = true;
    }

    for (const finishReason of finishReasons) {
      state.finishReasons.push(finishReason);
    }

    if (sawEvent) {
      emitBegin(state.role);
    }

    if (contentParts.length > 0) {
      tracer.recordStreamChunk(traceId, {
        type: 'chunk',
        content: contentParts.join(''),
        finish_reasons: [...finishReasons],
        raw,
        tool_calls: chunkToolCalls,
        usage,
      });
      return;
    }

    tracer.recordStreamChunk(traceId, {
      type: 'event',
      finish_reasons: [...finishReasons],
      raw,
      tool_calls: chunkToolCalls,
      usage,
    });
  };

  const createWrappedIterator = (iterator: AsyncIterator<TChunk>) => ({
    async next(...args: [] | [undefined]) {
      try {
        const result = await iterator.next(...(args as []));
        if (result.done) {
          emitFinish();
          return result;
        }

        processChunk(result.value);
        return result;
      } catch (error) {
        tracer.recordError(traceId, error);
        throw error;
      }
    },

    async return(value?: unknown) {
      try {
        const result =
          typeof iterator.return === 'function'
            ? await iterator.return(value as any)
            : ({
                done: true,
                value,
              } as IteratorResult<TChunk>);
        emitFinish();
        return result;
      } catch (error) {
        tracer.recordError(traceId, error);
        throw error;
      }
    },

    async throw(error?: unknown) {
      tracer.recordError(traceId, error);

      if (typeof iterator.throw === 'function') {
        return iterator.throw(error as any);
      }

      throw error;
    },

    [Symbol.asyncIterator]() {
      return this;
    },
  });

  return new Proxy(stream as any, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return () => createWrappedIterator(target[Symbol.asyncIterator]());
      }

      return bindMethod(target, Reflect.get(target, prop, receiver));
    },
  }) as TStream;
}

function normalizeOpenAIChatCompletionResponse(response: any) {
  const message = response?.choices?.[0]?.message;

  return {
    finish_reason: response?.choices?.[0]?.finish_reason || null,
    id: response?.id || null,
    message: normalizeOpenAIMessage(message),
    model: response?.model || null,
    object: response?.object || null,
    raw: safeClone(response),
    tool_calls: Array.isArray(message?.tool_calls) ? safeClone(message.tool_calls) : [],
    usage: normalizeOpenAIUsage(response?.usage),
  };
}

function normalizeOpenAIMessage(message: any) {
  return {
    ...safeClone(message),
    content: normalizeOpenAIMessageContent(message),
    role: typeof message?.role === 'string' ? message.role : 'assistant',
  };
}

function normalizeOpenAIMessageContent(message: any) {
  const content = extractOpenAITextParts(message?.content);
  if (content.length > 0) {
    return content.join('');
  }

  if (typeof message?.refusal === 'string' && message.refusal) {
    return message.refusal;
  }

  return message?.content ?? null;
}

function extractOpenAITextParts(content: unknown): string[] {
  if (typeof content === 'string' && content) {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string' && item) {
      parts.push(item);
      continue;
    }

    if (typeof item?.text === 'string' && item.text) {
      parts.push(item.text);
      continue;
    }

    if (typeof item?.content === 'string' && item.content) {
      parts.push(item.content);
    }
  }

  return parts;
}

function normalizeOpenAIUsage(usage: any): Record<string, any> | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  return {
    raw: safeClone(usage),
    tokens: {
      completion: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null,
      prompt: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null,
      total: typeof usage?.total_tokens === 'number' ? usage.total_tokens : null,
    },
  };
}

function mergeOpenAIToolCallDelta(target: Map<number, Record<string, any>>, delta: any) {
  const index = Number.isInteger(delta?.index) ? delta.index : target.size;
  const current = safeClone(target.get(index) || { function: { arguments: '' } });

  if (delta?.id) {
    current.id = delta.id;
  }

  if (delta?.type) {
    current.type = delta.type;
  }

  if (delta?.function?.name) {
    current.function = {
      ...(current.function || {}),
      name: delta.function.name,
    };
  }

  if (delta?.function?.arguments) {
    current.function = {
      ...(current.function || {}),
      arguments: `${current.function?.arguments || ''}${delta.function.arguments}`,
    };
  }

  target.set(index, current);
}

function serializeOpenAIToolCalls(toolCalls: Map<number, Record<string, any>>) {
  return [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => safeClone(value));
}
