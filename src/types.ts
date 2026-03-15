export type TraceMode = 'invoke' | 'stream';
export type TraceStatus = 'pending' | 'ok' | 'error';
export type SpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
export type SpanStatusCode = 'UNSET' | 'OK' | 'ERROR';

export type TraceConfig = {
  host?: string;
  maxTraces?: number;
  otel?: false | OpenTelemetryBridgeConfig;
  port?: number;
  serverEnabled?: boolean;
  uiHotReload?: boolean;
};

export type TraceTags = Record<string, string>;

export type SpanAttributes = Record<string, any>;

export type SpanContext = {
  spanId: string;
  traceId: string;
};

export type SpanEvent = {
  attributes: SpanAttributes;
  name: string;
  timestamp: string;
};

export type SpanStatus = {
  code: SpanStatusCode;
  message?: string;
};

export type TraceContext = {
  actorId?: string | null;
  actorType?: string | null;
  guardrailPhase?: string | null;
  guardrailType?: string | null;
  kind?: string | null;
  model?: string | null;
  parentSessionId?: string | null;
  provider?: string | null;
  rootActorId?: string | null;
  rootSessionId?: string | null;
  sessionId?: string | null;
  stage?: string | null;
  tags?: Record<string, string | null | undefined>;
  tenantId?: string | null;
  userId?: string | null;
  agentId?: string | null;
  chatId?: string | null;
  contextType?: string | null;
  parentChatId?: string | null;
  rootChatId?: string | null;
  systemType?: string | null;
  topLevelAgentId?: string | null;
  watchdogPhase?: string | null;
  workflowState?: string | null;
};

export type TraceHierarchy = {
  childActorId: string | null;
  guardrailPhase: string | null;
  guardrailType: string | null;
  kind: string;
  rootActorId: string;
  sessionId: string;
  stage: string | null;
  chatId: string;
  delegatedAgentId: string | null;
  systemType: string | null;
  topLevelAgentId: string;
  watchdogPhase: string | null;
  workflowState: string | null;
};

export type NormalizedTraceContext = {
  actorId: string | null;
  actorType: string | null;
  guardrailPhase: string | null;
  guardrailType: string | null;
  hierarchy: TraceHierarchy;
  kind: string;
  model: string | null;
  parentSessionId: string | null;
  provider: string | null;
  rootActorId: string | null;
  rootSessionId: string | null;
  sessionId: string | null;
  stage: string | null;
  tags: TraceTags;
  tenantId: string | null;
  userId: string | null;
  agentId: string | null;
  chatId: string | null;
  contextType: string | null;
  parentChatId: string | null;
  rootChatId: string | null;
  systemType: string | null;
  topLevelAgentId: string | null;
  watchdogPhase: string | null;
  workflowState: string | null;
};

export type TraceRequest = {
  input?: Record<string, any>;
  options?: Record<string, any>;
};

export type SpanStartOptions = {
  attributes?: SpanAttributes;
  kind?: SpanKind;
  mode?: TraceMode;
  name?: string;
  parentSpanId?: string | null;
  request?: TraceRequest;
};

export type SpanEventInput = {
  attributes?: SpanAttributes;
  name: string;
  payload?: unknown;
};

export type TraceStructuredInputInsight = {
  format: 'xml';
  role: string;
  snippet: string;
  tags: string[];
};

export type TraceHighlightInsight = {
  description: string;
  kind: string;
  snippet: string;
  source: string;
  title: string;
};

export type TraceInsights = {
  highlights: TraceHighlightInsight[];
  structuredInputs: TraceStructuredInputInsight[];
};

export type TraceSummaryFlags = {
  hasHighlights: boolean;
  hasStructuredInput: boolean;
};

export type TraceRecord = {
  attributes: SpanAttributes;
  context: NormalizedTraceContext;
  endedAt: string | null;
  error: Record<string, any> | null;
  events: SpanEvent[];
  hierarchy: TraceHierarchy;
  id: string;
  kind: string;
  mode: TraceMode;
  model: string | null;
  name: string;
  parentSpanId: string | null;
  provider: string | null;
  request: {
    input?: Record<string, any>;
    options: Record<string, any>;
  };
  response: Record<string, any> | null;
  startedAt: string;
  spanContext: SpanContext;
  spanKind: SpanKind;
  spanStatus: SpanStatus;
  status: TraceStatus;
  stream: null | {
    chunkCount: number;
    events: Record<string, any>[];
    firstChunkMs: number | null;
    reconstructed: {
      message: Record<string, any>;
      tool_calls: Record<string, any>[];
      usage: Record<string, any> | null;
    };
  };
  insights?: TraceInsights;
  tags: TraceTags;
  usage: Record<string, any> | null;
};

export type TraceSummary = {
  costUsd: number | null;
  durationMs: number | null;
  endedAt: string | null;
  flags?: TraceSummaryFlags;
  hierarchy: TraceHierarchy;
  id: string;
  kind: string;
  mode: TraceMode;
  model: string | null;
  provider: string | null;
  requestPreview: string;
  responsePreview: string;
  startedAt: string;
  status: TraceStatus;
  stream: null | {
    chunkCount: number;
    firstChunkMs: number | null;
  };
  tags: TraceTags;
};

export type TraceEvent = {
  span?: TraceRecord;
  spanId: string | null;
  timestamp: string;
  type: string;
};

export type UIReloadEvent = {
  timestamp: string;
  spanId: null;
  type: 'ui:reload';
};

export type TraceListResponse = {
  filtered: number;
  groups?: Array<{ count: number; items: TraceSummary[]; value: string }>;
  items: TraceSummary[];
  total: number;
};

export type HierarchyNode = {
  children: HierarchyNode[];
  count: number;
  id: string;
  label: string;
  meta: Record<string, any>;
  traceIds: string[];
  type: string;
};

export type HierarchyResponse = {
  filtered: number;
  rootNodes: HierarchyNode[];
  total: number;
};

export type TraceFilters = {
  groupBy?: string;
  kind?: string;
  model?: string;
  provider?: string;
  search?: string;
  status?: string;
  tagFilters?: string[];
  tags?: string[];
  traceIds?: string[];
};

export interface OpenTelemetrySpanLike {
  addEvent?(name: string, attributes?: Record<string, any>): void;
  end?(endTime?: number): void;
  recordException?(exception: unknown): void;
  setAttributes?(attributes: Record<string, any>): void;
  setStatus?(status: { code: any; message?: string }): void;
  spanContext?(): { spanId?: string; traceId?: string };
}

export interface OpenTelemetryTracerLike {
  startSpan(name: string, options?: Record<string, any>, context?: unknown): OpenTelemetrySpanLike;
}

export interface OpenTelemetryApiLike {
  SpanKind?: Record<string, any>;
  SpanStatusCode?: Record<string, any>;
  context?: {
    active(): unknown;
  };
  trace?: {
    getTracer(name: string, version?: string): OpenTelemetryTracerLike;
    setSpan(context: unknown, span: OpenTelemetrySpanLike): unknown;
  };
}

export type OpenTelemetryBridgeConfig = {
  api?: OpenTelemetryApiLike;
  enabled?: boolean;
  tracerName?: string;
  tracerVersion?: string;
};

export interface ChatModelLike<TInput = any, TOptions = any, TValue = any, TChunk = any> {
  invoke(input: TInput, options?: TOptions): Promise<TValue>;
  stream(input: TInput, options?: TOptions): AsyncGenerator<TChunk>;
}

export type OpenAIChatCompletionCreateParamsLike = Record<string, any> & {
  messages?: Record<string, any>[];
  model?: string | null;
  stream?: boolean | null;
};

export interface OpenAIChatCompletionStreamLike<TChunk = any> extends AsyncIterable<TChunk> {
  [Symbol.asyncIterator](): AsyncIterator<TChunk>;
}

export interface OpenAIChatCompletionsLike<
  TParams = OpenAIChatCompletionCreateParamsLike,
  TOptions = Record<string, any>,
  TResponse = any,
  TChunk = any,
> {
  create(
    params: TParams,
    options?: TOptions,
  ): Promise<TResponse> | Promise<OpenAIChatCompletionStreamLike<TChunk>> | OpenAIChatCompletionStreamLike<TChunk>;
}

export interface OpenAIClientLike<
  TParams = OpenAIChatCompletionCreateParamsLike,
  TOptions = Record<string, any>,
  TResponse = any,
  TChunk = any,
> {
  chat: {
    completions: OpenAIChatCompletionsLike<TParams, TOptions, TResponse, TChunk>;
    [key: string]: any;
  };
  [key: string]: any;
}

export type TraceServer = {
  broadcast(event: TraceEvent | UIReloadEvent): void;
  close(): void;
  start(): Promise<{ host: string; port: number; url: string } | null>;
};

export type UIWatchController = {
  stop(): Promise<void>;
};

export type LocalLLMTracer = {
  addSpanEvent(spanId: string, event: SpanEventInput): void;
  configure(config?: TraceConfig): void;
  endSpan(spanId: string, response?: unknown): void;
  isEnabled(): boolean;
  recordException(spanId: string, error: unknown): void;
  runWithActiveSpan<T>(spanId: string, callback: () => T): T;
  startSpan(context: TraceContext, options?: SpanStartOptions): string;
  startServer(): Promise<{ host: string; port: number; url: string } | null>;
  store: any;
}
