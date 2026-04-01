export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMRequest {
  model: string;
  systemPrompt: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_use' | 'stop' | 'error';
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  error?: string;
  stopReason?: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;
  listModels(): Promise<ModelInfo[]>;
  complete(request: LLMRequest): Promise<LLMResponse>;
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
}
