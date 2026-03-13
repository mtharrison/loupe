export type TraceMode = 'invoke' | 'stream';
export type TraceStatus = 'pending' | 'ok' | 'error';

export type TraceConfig = {
  host?: string;
  maxTraces?: number;
  port?: number;
  uiHotReload?: boolean;
};

export type TraceTags = Record<string, string>;

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

export type TraceRecord = {
  context: NormalizedTraceContext;
  endedAt: string | null;
  error: Record<string, any> | null;
  hierarchy: TraceHierarchy;
  id: string;
  kind: string;
  mode: TraceMode;
  model: string | null;
  provider: string | null;
  request: {
    input?: Record<string, any>;
    options: Record<string, any>;
  };
  response: Record<string, any> | null;
  startedAt: string;
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
  tags: TraceTags;
  usage: Record<string, any> | null;
};

export type TraceSummary = {
  costUsd: number | null;
  durationMs: number | null;
  endedAt: string | null;
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
  timestamp: string;
  trace?: TraceRecord;
  traceId: string | null;
  type: string;
};

export type UIReloadEvent = {
  timestamp: string;
  traceId: null;
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

export interface ChatModelLike<TInput = any, TOptions = any, TValue = any, TChunk = any> {
  invoke(input: TInput, options?: TOptions): Promise<TValue>;
  stream(input: TInput, options?: TOptions): AsyncGenerator<TChunk>;
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
  configure(config?: TraceConfig): void;
  isEnabled(): boolean;
  recordError(traceId: string, error: unknown): void;
  recordInvokeFinish(traceId: string, response: unknown): void;
  recordInvokeStart(context: TraceContext, request: TraceRequest): string;
  recordStreamChunk(traceId: string, chunk: unknown): void;
  recordStreamFinish(traceId: string, chunk: unknown): void;
  recordStreamStart(context: TraceContext, request: TraceRequest): string;
  startServer(): Promise<{ host: string; port: number; url: string } | null>;
  store: any;
}
