/**
 * 把已完成的口播转写回填进向量知识库。
 * 用法：npm run backfill-knowledge
 * 依赖 .env.local 中的 SUPABASE_SERVICE_ROLE_KEY 与 AIHUBMIX_API_KEY。
 *
 * 注意：切片/embedding 逻辑与 lib/knowledge 保持一致
 * （scripts 经 tsx 直接跑 Node，不能 import server-only 模块）。
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env.local' });

import OpenAI from 'openai';

import { createScriptAdminClient } from './lib/supabase-admin';
import type { Json } from '@/types/database';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 80;

function chunkText(text: string): string[] {
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

async function main() {
  const apiKey = process.env.AIHUBMIX_API_KEY?.trim();
  if (!apiKey) throw new Error('缺少 AIHUBMIX_API_KEY');

  const openai = new OpenAI({
    apiKey,
    baseURL: 'https://aihubmix.com/v1',
  });
  const admin = createScriptAdminClient();

  const { data: transcripts, error } = await admin
    .from('video_transcripts')
    .select('id, aweme_id, transcript, imported_video_id')
    .eq('status', 'done')
    .not('transcript', 'is', null);

  if (error) throw error;
  if (!transcripts?.length) {
    console.log('没有可回填的转写记录');
    return;
  }

  console.log(`共 ${transcripts.length} 条转写待回填`);
  let ok = 0;
  let skipped = 0;

  for (const t of transcripts) {
    const { data: video } = await admin
      .from('imported_videos')
      .select(
        'organization_id, video_desc, product_title, author_nickname, like_count, collect_rate, product_category_l2',
      )
      .eq('id', t.imported_video_id ?? '')
      .maybeSingle();

    if (!video?.organization_id || !t.transcript) {
      skipped += 1;
      continue;
    }

    try {
      const chunks = chunkText(t.transcript);
      if (chunks.length === 0) {
        skipped += 1;
        continue;
      }

      // 同 aweme_id 旧切片先删，避免重复
      await admin
        .from('knowledge_chunks')
        .delete()
        .eq('organization_id', video.organization_id)
        .eq('source_type', 'transcript')
        .eq('metadata->>aweme_id', t.aweme_id);

      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: chunks.map((c) => c.slice(0, 8000)),
      });
      const embeddings = response.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);

      const metadata = {
        aweme_id: t.aweme_id,
        video_desc: video.video_desc,
        product_title: video.product_title,
        author_nickname: video.author_nickname,
        like_count: video.like_count,
        collect_rate: video.collect_rate,
        product_category_l2: video.product_category_l2,
      } as Json;

      const { error: insertError } = await admin.from('knowledge_chunks').insert(
        chunks.map((content, i) => ({
          organization_id: video.organization_id!,
          source_type: 'transcript',
          content,
          embedding: `[${embeddings[i].join(',')}]`,
          metadata,
        })),
      );
      if (insertError) throw insertError;

      ok += 1;
      console.log(`✓ ${t.aweme_id}（${chunks.length} 个切片）`);
    } catch (e) {
      console.error(`✗ ${t.aweme_id}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`完成：成功 ${ok}，跳过 ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
