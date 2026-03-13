import { createTraceServer } from './server';
import { TraceStore } from './store';
import { maybeStartUIWatcher } from './ui-build';
import { envFlag, safeClone } from './utils';
import { type ChatModelLike, type LocalLLMTracer, type TraceConfig, type TraceContext, type TraceRequest, type TraceServer, type UIWatchController } from './types';

export type {
  ChatModelLike,
  HierarchyNode,
  HierarchyResponse,
  LocalLLMTracer,
  NormalizedTraceContext,
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

class LocalLLMTracerImpl implements LocalLLMTracer {
  config: Required<TraceConfig>;
  loggedUrl: boolean;
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

    this.config = {
      host: config.host || this.config.host || process.env.LLM_TRACE_HOST || '127.0.0.1',
      port: Number(config.port || this.config.port || process.env.LLM_TRACE_PORT) || 4319,
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
        this.server = createTraceServer(this.store, this.config);
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
