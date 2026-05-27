export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AIMessage {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatParams {
  messages: AIMessage[];
  model: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: Tool[];
  tool_choice?: 'auto' | 'none' | 'required';
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  content: string;
  finish_reason: string;
  usage: TokenUsage;
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type StreamChunk = {
  type: 'content' | 'done';
  content?: string;
  usage?: TokenUsage;
};
