export type TraceMode = 'invoke' | 'stream';

export type TraceContext = {
  chatId?: string | null;
  rootChatId?: string | null;
  parentChatId?: string | null;
  topLevelAgentId?: string | null;
  agentId?: string | null;
  userId?: string | null;
  tenantId?: string | null;
  contextType?: string | null;
  workflowState?: string | null;
  systemType?: string | null;
  provider?: string | null;
  model?: string | null;
  tags?: Record<string, string | null | undefined>;
};

export type TraceConfig = {
  host?: string;
  port?: number;
  maxTraces?: number;
};

export interface ChatModelLike<TInput = any, TOptions = any, TValue = any, TChunk = any> {
  invoke(input: TInput, options?: TOptions): Promise<TValue>;
  stream(input: TInput, options?: TOptions): AsyncGenerator<TChunk>;
}

export declare function isTraceEnabled(): boolean;
export declare function getLocalLLMTracer(config?: TraceConfig): unknown;
export declare function __resetLocalLLMTracerForTests(): void;
export declare function wrapChatModel<
  TModel extends ChatModelLike<TInput, TOptions, TValue, TChunk>,
  TInput = any,
  TOptions = any,
  TValue = any,
  TChunk = any,
>(model: TModel, getContext: () => TraceContext, config?: TraceConfig): TModel;
