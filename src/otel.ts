import {
  type OpenTelemetryApiLike,
  type OpenTelemetryBridgeConfig,
  type OpenTelemetrySpanLike,
  type SpanContext,
  type SpanEventInput,
  type SpanKind,
  type SpanStatusCode,
  type TraceRecord,
} from './types';

type OpenTelemetrySpanHandle = {
  span: OpenTelemetrySpanLike;
  spanContext: SpanContext | null;
};

export class OpenTelemetryBridge {
  private api: OpenTelemetryApiLike | null | undefined;
  private config: Required<Pick<OpenTelemetryBridgeConfig, 'enabled' | 'tracerName'>> & Pick<OpenTelemetryBridgeConfig, 'api' | 'tracerVersion'>;
  private spans: Map<string, OpenTelemetrySpanLike>;
  private warnedUnavailable: boolean;

  constructor(config: OpenTelemetryBridgeConfig = {}) {
    this.spans = new Map();
    this.warnedUnavailable = false;
    this.api = undefined;
    this.config = {
      api: config.api,
      enabled: Boolean(config.enabled),
      tracerName: config.tracerName || '@mtharrison/loupe',
      tracerVersion: config.tracerVersion,
    };
  }

  configure(config: OpenTelemetryBridgeConfig = {}) {
    this.api = config.api || undefined;
    this.config = {
      api: config.api,
      enabled: Boolean(config.enabled),
      tracerName: config.tracerName || '@mtharrison/loupe',
      tracerVersion: config.tracerVersion,
    };
  }

  startSpan(options: { kind?: SpanKind; name: string; parentLocalSpanId: string | null }): OpenTelemetrySpanHandle | null {
    const api = this.getApi();
    const tracer = api?.trace?.getTracer?.(this.config.tracerName, this.config.tracerVersion);
    if (!tracer?.startSpan) {
      return null;
    }

    const parentSpan = options.parentLocalSpanId ? this.spans.get(options.parentLocalSpanId) : null;
    const activeContext = api?.context?.active?.();
    const parentContext = parentSpan && api?.trace?.setSpan ? api.trace.setSpan(activeContext, parentSpan) : activeContext;
    const otelKind = api?.SpanKind && options.kind ? api.SpanKind[options.kind] : undefined;
    const spanOptions = otelKind === undefined ? undefined : { kind: otelKind };
    const span = tracer.startSpan(options.name, spanOptions, parentContext);
    const rawContext = span?.spanContext?.();

    return {
      span,
      spanContext:
        rawContext?.traceId && rawContext?.spanId
          ? {
              spanId: String(rawContext.spanId),
              traceId: String(rawContext.traceId),
            }
          : null,
    };
  }

  attach(localSpanId: string, handle: OpenTelemetrySpanHandle | null, trace: TraceRecord | null) {
    if (!handle?.span) {
      return;
    }

    this.spans.set(localSpanId, handle.span);

    if (trace) {
      handle.span.setAttributes?.(toOpenTelemetryAttributes(trace.attributes));
    }
  }

  addEvent(localSpanId: string, event: SpanEventInput) {
    const span = this.spans.get(localSpanId);
    if (!span) {
      return;
    }

    span.addEvent?.(event.name, toOpenTelemetryAttributes(event.attributes || {}));
  }

  finishSpan(localSpanId: string, trace: TraceRecord | null, exception?: unknown) {
    const span = this.spans.get(localSpanId);
    if (!span) {
      return;
    }

    if (trace) {
      span.setAttributes?.(toOpenTelemetryAttributes(trace.attributes));
      span.setStatus?.({
        code: resolveStatusCode(this.getApi(), trace.spanStatus.code),
        message: trace.spanStatus.message,
      });
    }

    if (exception !== undefined) {
      span.recordException?.(exception);
    } else if (trace?.error) {
      span.recordException?.(trace.error);
    }

    const endedAtMs = trace?.endedAt ? Date.parse(trace.endedAt) : NaN;
    span.end?.(Number.isFinite(endedAtMs) ? endedAtMs : undefined);
    this.spans.delete(localSpanId);
  }

  private getApi(): OpenTelemetryApiLike | null {
    if (!this.config.enabled) {
      return null;
    }

    if (this.config.api) {
      this.api = this.config.api;
      return this.api;
    }

    if (this.api !== undefined) {
      return this.api;
    }

    try {
      this.api = require('@opentelemetry/api') as OpenTelemetryApiLike;
      return this.api;
    } catch (_error) {
      this.api = null;
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        process.stderr.write('[llm-trace] OpenTelemetry bridge enabled but @opentelemetry/api is not available.\n');
      }
      return null;
    }
  }
}

function resolveStatusCode(api: OpenTelemetryApiLike | null, code: SpanStatusCode) {
  return api?.SpanStatusCode?.[code] ?? code;
}

function toOpenTelemetryAttributes(attributes: Record<string, any>): Record<string, string | number | boolean | string[] | number[] | boolean[]> {
  const next: Record<string, string | number | boolean | string[] | number[] | boolean[]> = {};

  for (const [key, value] of Object.entries(attributes || {})) {
    const normalized = normalizeAttributeValue(value);
    if (normalized !== undefined) {
      next[key] = normalized;
    }
  }

  return next;
}

function normalizeAttributeValue(value: unknown): string | number | boolean | string[] | number[] | boolean[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [];
    }

    if (value.every((item) => typeof item === 'string')) {
      return value as string[];
    }

    if (value.every((item) => typeof item === 'number')) {
      return value as number[];
    }

    if (value.every((item) => typeof item === 'boolean')) {
      return value as boolean[];
    }
  }

  return safeStringify(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}
