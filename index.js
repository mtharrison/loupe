'use strict';

const { TraceStore } = require('./lib/store');
const { createTraceServer } = require('./lib/server');
const { envFlag, safeClone } = require('./lib/utils');

let singleton = null;

function isTraceEnabled() {
  return envFlag('LLM_TRACE_ENABLED');
}

function getLocalLLMTracer(config = {}) {
  if (!singleton) {
    singleton = new LocalLLMTracer(config);
  } else if (config && Object.keys(config).length > 0) {
    singleton.configure(config);
  }

  return singleton;
}

function __resetLocalLLMTracerForTests() {
  if (singleton?.server) {
    singleton.server.close();
  }

  singleton = null;
}

function wrapChatModel(model, getContext, config) {
  if (!model || typeof model.invoke !== 'function' || typeof model.stream !== 'function') {
    throw new TypeError('wrapChatModel expects a ChatModel-compatible object.');
  }

  return {
    async invoke(input, options = {}) {
      const tracer = getLocalLLMTracer(config);
      if (!tracer.isEnabled()) {
        return model.invoke(input, options);
      }

      const traceId = tracer.recordInvokeStart(getContext ? getContext() : {}, { input, options });
      try {
        const response = await model.invoke(input, options);
        tracer.recordInvokeFinish(traceId, response);
        return response;
      } catch (error) {
        tracer.recordError(traceId, error);
        throw error;
      }
    },

    async *stream(input, options = {}) {
      const tracer = getLocalLLMTracer(config);
      if (!tracer.isEnabled()) {
        yield* model.stream(input, options);
        return;
      }

      const traceId = tracer.recordStreamStart(getContext ? getContext() : {}, { input, options });

      try {
        const stream = model.stream(input, options);
        for await (const chunk of stream) {
          if (chunk?.type === 'finish') {
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
  };
}

class LocalLLMTracer {
  constructor(config = {}) {
    this.config = {};
    this.configure(config);
    this.store = new TraceStore({ maxTraces: this.config.maxTraces });
    this.server = null;
    this.serverInfo = null;
    this.serverStartPromise = null;
    this.serverFailed = false;
    this.loggedUrl = false;
  }

  configure(config = {}) {
    if (this.serverInfo && (config.host || config.port)) {
      return;
    }

    this.config = {
      host: config.host || this.config.host || process.env.LLM_TRACE_HOST || '127.0.0.1',
      port: Number(config.port || this.config.port || process.env.LLM_TRACE_PORT) || 4319,
      maxTraces: Number(config.maxTraces || this.config.maxTraces || process.env.LLM_TRACE_MAX_TRACES) || 1000,
    };

    if (this.store) {
      this.store.maxTraces = this.config.maxTraces;
    }
  }

  isEnabled() {
    return isTraceEnabled();
  }

  startServer() {
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
        if (!this.loggedUrl) {
          this.loggedUrl = true;
          process.stdout.write(`[llm-trace] dashboard: ${this.serverInfo.url}\n`);
        }
        return this.serverInfo;
      } catch (error) {
        this.serverFailed = true;
        process.stderr.write(`[llm-trace] failed to start dashboard: ${error.message}\n`);
        return null;
      } finally {
        this.serverStartPromise = null;
      }
    })();

    return this.serverStartPromise;
  }

  recordInvokeStart(context, request) {
    this.startServer();
    return this.store.recordInvokeStart(context, normaliseRequest(request));
  }

  recordInvokeFinish(traceId, response) {
    this.store.recordInvokeFinish(traceId, safeClone(response));
  }

  recordStreamStart(context, request) {
    this.startServer();
    return this.store.recordStreamStart(context, normaliseRequest(request));
  }

  recordStreamChunk(traceId, chunk) {
    this.store.recordStreamChunk(traceId, safeClone(chunk));
  }

  recordStreamFinish(traceId, chunk) {
    this.store.recordStreamFinish(traceId, safeClone(chunk));
  }

  recordError(traceId, error) {
    this.store.recordError(traceId, error);
  }
}

function normaliseRequest(request) {
  return {
    input: safeClone(request?.input),
    options: safeClone(request?.options),
  };
}

module.exports = {
  __resetLocalLLMTracerForTests,
  getLocalLLMTracer,
  isTraceEnabled,
  wrapChatModel,
};
