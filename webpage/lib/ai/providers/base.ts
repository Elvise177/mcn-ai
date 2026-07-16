import type { ChatParams, ChatResponse, StreamChunk, TokenUsage } from '../types';

export abstract class AIProvider {
  abstract name: string;
  abstract chatStream(params: ChatParams): Promise<ReadableStream<StreamChunk>>;
  abstract chat(params: ChatParams): Promise<ChatResponse>;
  abstract calculateCost(model: string, usage: TokenUsage): number;
  abstract getMaxContextTokens(model: string): number;
}
