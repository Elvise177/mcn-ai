import OpenAI from 'openai';

import { config } from '@/config';

import { AIProvider } from './base';
import type { ChatParams, ChatResponse, TokenUsage } from '../types';

export class AIHubMixProvider extends AIProvider {
  name = 'aihubmix';

  private client: OpenAI;

  // AIHubMix 价格表（截至 2026.05，每 1K tokens 的人民币价格，按 ¥7.2/$ 换算）
  private static PRICING: Record<string, { input: number; output: number }> = {
    // Claude 4.6/4.5 系列
    'claude-opus-4-6': { input: 0.108, output: 0.54 },
    'claude-sonnet-4-6': { input: 0.0216, output: 0.108 },
    'claude-haiku-4-5': { input: 0.0072, output: 0.036 },
    // GPT 系列
    'gpt-4o': { input: 0.018, output: 0.072 },
    'gpt-4o-mini': { input: 0.00108, output: 0.00432 },
    'gpt-5.2': { input: 0.072, output: 0.288 },
    // Gemini
    'gemini-2.5-pro': { input: 0.009, output: 0.036 },
    // 国产
    'deepseek-v3': { input: 0.00216, output: 0.00864 },
    'kimi-k2': { input: 0.0036, output: 0.0144 },
  };

  constructor() {
    super();
    this.client = new OpenAI({
      apiKey: config.ai.providers.aihubmix.apiKey,
      baseURL: config.ai.providers.aihubmix.baseURL,
    });
  }

  async chatStream(params: ChatParams) {
    const stream = await this.client.chat.completions.create(
      {
        model: params.model,
        messages: params.messages as OpenAI.ChatCompletionMessageParam[],
        temperature: params.temperature ?? 0.7,
        max_tokens: params.max_tokens ?? 4000,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: params.signal },
    );

    return new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
              controller.enqueue({ type: 'content' as const, content });
            }
            if (chunk.usage) {
              controller.enqueue({
                type: 'done' as const,
                usage: {
                  prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                  completion_tokens: chunk.usage.completion_tokens ?? 0,
                  total_tokens: chunk.usage.total_tokens ?? 0,
                },
              });
            }
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: params.model,
      messages: params.messages as OpenAI.ChatCompletionMessageParam[],
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 4000,
      stream: false,
    });

    return {
      content: response.choices[0]?.message?.content || '',
      finish_reason: response.choices[0]?.finish_reason || 'stop',
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
    };
  }

  /** 返回人民币成本（不是美元） */
  calculateCost(model: string, usage: TokenUsage): number {
    const pricing = AIHubMixProvider.PRICING[model];
    if (!pricing) {
      console.warn('Unknown model pricing:', model);
      return 0;
    }
    return (
      (usage.prompt_tokens * pricing.input +
        usage.completion_tokens * pricing.output) /
      1000
    );
  }

  getMaxContextTokens(model: string): number {
    if (model.startsWith('claude')) return 200_000;
    if (model.startsWith('gpt-4o')) return 128_000;
    if (model.startsWith('gpt-5')) return 128_000;
    if (model.startsWith('gemini')) return 1_000_000;
    return 32_000;
  }
}
