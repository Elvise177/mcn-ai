import { NextResponse } from 'next/server';
import { authBearerUser } from '@/lib/auth/bearer';
import { ingestKnowledge, type ChunkSourceType } from '@/lib/knowledge';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 60;

const PERSONAL_TYPES: ChunkSourceType[] = ['my_script', 'my_review', 'style_profile'];

/** 桌面端私人层入库：本地 markdown → 切片/embedding/写入（visibility=private，owner=token 用户） */
export async function POST(req: Request) {
  const user = await authBearerUser(req);
  if (!user) return NextResponse.json({ error: '未授权' }, { status: 401 });
  if (!user.organizationId) return NextResponse.json({ error: '账号未分配组织' }, { status: 403 });

  const body = await req.json().catch(() => null);
  const content = typeof body?.content === 'string' ? body.content : '';
  const filePath = typeof body?.filePath === 'string' ? body.filePath : '';
  const contentHash = typeof body?.contentHash === 'string' ? body.contentHash : undefined;
  const sourceType: ChunkSourceType = PERSONAL_TYPES.includes(body?.sourceType) ? body.sourceType : 'my_script';

  if (content.trim().length < 20 || !filePath) {
    return NextResponse.json({ error: 'content（≥20字）与 filePath 必填' }, { status: 400 });
  }

  // 内容未变则跳过（省 embedding 费用）
  if (contentHash) {
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from('knowledge_chunks')
      .select('id')
      .eq('owner_user_id', user.userId)
      .eq('file_path', filePath)
      .eq('content_hash', contentHash)
      .limit(1);
    if (existing && existing.length > 0) {
      return NextResponse.json({ ok: true, skipped: true });
    }
  }

  try {
    const chunks = await ingestKnowledge({
      organizationId: user.organizationId,
      sourceType,
      content,
      metadata: (body?.metadata ?? {}) as Record<string, never>,
      ownerUserId: user.userId,
      visibility: 'private',
      filePath,
      contentHash,
    });
    return NextResponse.json({ ok: true, chunks });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
