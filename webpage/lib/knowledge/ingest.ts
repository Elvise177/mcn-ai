import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';

import { embedTexts, toVectorLiteral } from './embeddings';

export type ChunkSourceType =
  | 'hot_script'
  | 'viral_breakdown'
  | 'transcript'
  | 'editing_template'
  | 'my_script'
  | 'my_review'
  | 'style_profile';

export interface IngestParams {
  organizationId: string;
  sourceType: ChunkSourceType;
  content: string;
  metadata?: Record<string, Json | undefined>;
  knowledgeItemId?: string;
  /** 私人层归属（需先执行迁移 010）；传入时 visibility 默认 'private' */
  ownerUserId?: string;
  /** 桌面端本地文件同步：库内相对路径（同 owner+filePath 先删后插） */
  filePath?: string;
  contentHash?: string;
  /** 三层可见性；不传时：有 ownerUserId 为 'private'，否则 'org'（与 010 默认一致） */
  visibility?: 'platform' | 'org' | 'private';
}

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 80;

/** 按段落优先、长度兜底切片（中文口播文案 600 字 ≈ 一个完整卖点段落） */
export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= CHUNK_SIZE) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 1 <= CHUNK_SIZE) {
      current = current ? `${current}\n${para}` : para;
      continue;
    }
    if (current) chunks.push(current);

    if (para.length <= CHUNK_SIZE) {
      current = para;
    } else {
      // 超长段落按固定窗口滑动切
      let start = 0;
      while (start < para.length) {
        chunks.push(para.slice(start, start + CHUNK_SIZE));
        start += CHUNK_SIZE - CHUNK_OVERLAP;
      }
      current = '';
    }
  }
  if (current) chunks.push(current);

  return chunks.filter((c) => c.trim().length >= 20);
}

/**
 * 切片 + embedding + 写入 knowledge_chunks。
 * dedupeKey（如 aweme_id）相同的旧切片会先删除，避免重复入库。
 */
export async function ingestKnowledge(params: IngestParams): Promise<number> {
  const chunks = chunkText(params.content);
  if (chunks.length === 0) return 0;

  const admin = createAdminClient();

  if (params.filePath && params.ownerUserId) {
    await admin
      .from('knowledge_chunks')
      .delete()
      .eq('owner_user_id', params.ownerUserId)
      .eq('file_path', params.filePath);
  }

  const dedupeKey = params.metadata?.aweme_id;
  if (dedupeKey) {
    await admin
      .from('knowledge_chunks')
      .delete()
      .eq('organization_id', params.organizationId)
      .eq('source_type', params.sourceType)
      .eq('metadata->>aweme_id', String(dedupeKey));
  }

  const embeddings = await embedTexts(chunks);

  const visibility =
    params.visibility ?? (params.ownerUserId ? 'private' : 'org');

  const rows = chunks.map((content, i) => ({
    organization_id: params.organizationId,
    knowledge_item_id: params.knowledgeItemId ?? null,
    source_type: params.sourceType,
    content,
    embedding: toVectorLiteral(embeddings[i]),
    metadata: (params.metadata ?? {}) as Json,
    ...(params.ownerUserId || params.visibility
      ? { owner_user_id: params.ownerUserId ?? null, visibility }
      : {}),
    ...(params.filePath ? { file_path: params.filePath, content_hash: params.contentHash ?? null } : {}),
  }));

  const { error } = await admin.from('knowledge_chunks').insert(rows);
  if (error) throw error;

  return rows.length;
}
