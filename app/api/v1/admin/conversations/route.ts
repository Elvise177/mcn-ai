import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { buildEmailMap } from '@/lib/admin/emails';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: Request) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  const roleId = searchParams.get('roleId');
  const dateFrom = searchParams.get('dateFrom');
  const dateTo = searchParams.get('dateTo');
  const search = searchParams.get('search')?.trim() ?? '';

  const admin = createAdminClient();
  const orgId = scopeOrgId(ctx);

  let query = admin
    .from('conversations')
    .select('id, user_id, role_id, title, updated_at, created_at, organization_id')
    .order('updated_at', { ascending: false });

  if (orgId) query = query.eq('organization_id', orgId);
  if (userId) query = query.eq('user_id', userId);
  if (roleId) query = query.eq('role_id', roleId);
  if (dateFrom) query = query.gte('updated_at', dateFrom);
  if (dateTo) query = query.lte('updated_at', `${dateTo}T23:59:59.999Z`);

  const { data: conversations, error } = await query.limit(200);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let list = conversations ?? [];

  if (search) {
    const { data: matchedMessages } = await admin
      .from('messages')
      .select('conversation_id')
      .ilike('content', `%${search}%`)
      .limit(500);

    const matchedIds = new Set(
      (matchedMessages ?? []).map((m) => m.conversation_id),
    );
    list = list.filter((c) => matchedIds.has(c.id));
  }

  const userIds = Array.from(
    new Set(list.map((c) => c.user_id).filter(Boolean)),
  ) as string[];
  const emailMap = await buildEmailMap(userIds);

  const { data: roles } = await admin.from('ai_roles').select('id, name, icon');
  const roleMap = new Map((roles ?? []).map((r) => [r.id, r]));

  const convIds = list.map((c) => c.id);
  const messageCounts: Record<string, number> = {};
  if (convIds.length > 0) {
    const { data: messages } = await admin
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', convIds);
    for (const m of messages ?? []) {
      messageCounts[m.conversation_id] =
        (messageCounts[m.conversation_id] ?? 0) + 1;
    }
  }

  return Response.json(
    list.map((c) => ({
      id: c.id,
      userId: c.user_id,
      userEmail: c.user_id ? emailMap.get(c.user_id) ?? '' : '',
      roleId: c.role_id,
      roleName: c.role_id ? roleMap.get(c.role_id)?.name ?? '' : '',
      roleIcon: c.role_id ? roleMap.get(c.role_id)?.icon ?? '' : '',
      title: c.title,
      messageCount: messageCounts[c.id] ?? 0,
      updatedAt: c.updated_at,
      createdAt: c.created_at,
    })),
  );
}
