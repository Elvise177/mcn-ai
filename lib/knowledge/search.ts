import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';

import { embedText, toVectorLiteral } from './embeddings';
import type { ChunkSourceType } from './ingest';

export interface KnowledgeMatch {
  id: string;
  content: string;
  source_type: string;
  metadata: Json;
  similarity: number;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  hot_script: '热门脚本',
  viral_breakdown: '爆款拆解',
  transcript: '口播转写',
  editing_template: '剪辑模板',
};

export async function searchKnowledge(
  query: string,
  organizationId: string,
  options?: {
    sourceTypes?: ChunkSourceType[];
    matchCount?: number;
  },
): Promise<KnowledgeMatch[]> {
  const embedding = await embedText(query);
  const admin = createAdminClient();

  const { data, error } = await admin.rpc('match_knowledge_chunks', {
    query_embedding: toVectorLiteral(embedding),
    p_organization_id: organizationId,
    p_source_types: options?.sourceTypes ?? [
      'hot_script',
      'viral_breakdown',
      'transcript',
    ],
    match_count: options?.matchCount ?? 6,
  });

  if (error) {
    console.error('[Knowledge] match_knowledge_chunks failed:', error);
    return [];
  }

  return (data ?? []) as KnowledgeMatch[];
}

/** 拼接为注入 system prompt 的参考资料块 */
export function formatMatchesForPrompt(matches: KnowledgeMatch[]): string {
  if (matches.length === 0) return '';

  const blocks = matches.map((m, i) => {
    const meta = (m.metadata ?? {}) as Record<string, Json | undefined>;
    const label = SOURCE_TYPE_LABELS[m.source_type] ?? m.source_type;
    const stats = [
      meta.author_nickname ? `作者:${meta.author_nickname}` : null,
      meta.like_count ? `点赞:${meta.like_count}` : null,
      meta.collect_rate ? `收藏率:${meta.collect_rate}%` : null,
      meta.product_category_l2 ? `类目:${meta.product_category_l2}` : null,
    ]
      .filter(Boolean)
      .join(' ');

    return `【参考${i + 1} · ${label}${stats ? ' · ' + stats : ''}】\n${m.content}`;
  });

  return [
    '\n\n---\n以下是从知识库中检索到的同类目爆款参考资料（按相关度与互动量排序）。',
    '借鉴其钩子结构、节奏与卖点表达，但不要照抄，输出必须原创：\n',
    blocks.join('\n\n'),
  ].join('\n');
}
