import 'server-only';

import OpenAI from 'openai';

import { config } from '@/config';

/**
 * Embedding 走 AIHubMix（OpenAI 兼容）。
 * 测试期用 text-embedding-3-small（1536 维，¥0.0001/1K tokens 量级）；
 * 后续切换 bge-m3 等中文模型时需同步改 008 迁移中的向量维度并重刷数据。
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: config.ai.providers.aihubmix.apiKey,
      baseURL: config.ai.providers.aihubmix.baseURL,
    });
  }
  return client;
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map((t) => t.slice(0, 8000)),
  });

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/** pgvector 列接受 '[0.1,0.2,...]' 字符串格式 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
