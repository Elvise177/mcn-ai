import { NextResponse } from 'next/server';
import { authBearerUser } from '@/lib/auth/bearer';
import { searchKnowledge, type ChunkSourceType } from '@/lib/knowledge';

export const maxDuration = 30;

const ALL_TYPES: ChunkSourceType[] = [
  'hot_script',
  'viral_breakdown',
  'transcript',
  'editing_template',
  'my_script',
  'my_review',
  'style_profile',
];

/** 桌面端三层检索：platform + org + private（private 命中 1.2× 加权，见迁移 010） */
export async function POST(req: Request) {
  const user = await authBearerUser(req);
  if (!user) return NextResponse.json({ error: '未授权' }, { status: 401 });
  if (!user.organizationId) return NextResponse.json({ error: '账号未分配组织' }, { status: 403 });

  const body = await req.json().catch(() => null);
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query) return NextResponse.json({ error: 'query 必填' }, { status: 400 });
  const matchCount = Math.min(Number(body?.matchCount) || 6, 20);

  try {
    const matches = await searchKnowledge(query, user.organizationId, {
      matchCount,
      sourceTypes: ALL_TYPES,
      layers: ['platform', 'org', 'private'],
      ownerUserId: user.userId,
    });
    return NextResponse.json({ matches });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
