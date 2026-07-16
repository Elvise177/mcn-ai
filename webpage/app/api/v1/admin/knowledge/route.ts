import { requireAdmin } from '@/lib/admin/auth';
import { ingestKnowledge, type ChunkSourceType } from '@/lib/knowledge';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';

export const maxDuration = 60;
export const runtime = 'nodejs';

const VALID_SOURCE_TYPES: ChunkSourceType[] = [
  'hot_script',
  'viral_breakdown',
  'transcript',
  'editing_template',
];

type IngestBody = {
  content?: string;
  sourceType?: string;
  metadata?: Record<string, Json>;
};

/** 手动上传知识（爆款拆解、热门脚本等），切片 + embedding 入库 */
export async function POST(req: Request) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;
  if (!ctx.organizationId) {
    return Response.json({ error: '缺少组织信息' }, { status: 400 });
  }

  let body: IngestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const content = body.content?.trim();
  const sourceType = body.sourceType as ChunkSourceType;

  if (!content || content.length < 20) {
    return Response.json({ error: '内容过短（至少 20 字）' }, { status: 400 });
  }
  if (!VALID_SOURCE_TYPES.includes(sourceType)) {
    return Response.json(
      { error: `sourceType 须为 ${VALID_SOURCE_TYPES.join(' / ')}` },
      { status: 400 },
    );
  }

  try {
    const chunkCount = await ingestKnowledge({
      organizationId: ctx.organizationId,
      sourceType,
      content,
      metadata: { ...body.metadata, uploaded_by: ctx.userId },
    });
    return Response.json({ success: true, chunks: chunkCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : '入库失败';
    console.error('[Knowledge] 手动入库失败:', error);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** 知识库概览：各类型切片数量 */
export async function GET() {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;
  if (!ctx.organizationId) {
    return Response.json({ error: '缺少组织信息' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('knowledge_chunks')
    .select('source_type')
    .eq('organization_id', ctx.organizationId);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    counts[row.source_type] = (counts[row.source_type] ?? 0) + 1;
  }

  return Response.json({ counts, total: data?.length ?? 0 });
}
