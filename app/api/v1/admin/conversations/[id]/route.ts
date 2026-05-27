import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { buildEmailMap } from '@/lib/admin/emails';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const admin = createAdminClient();
  const orgId = scopeOrgId(ctx);

  let convQuery = admin
    .from('conversations')
    .select('*')
    .eq('id', params.id);
  if (orgId) convQuery = convQuery.eq('organization_id', orgId);

  const { data: conversation } = await convQuery.maybeSingle();
  if (!conversation) {
    return Response.json({ error: '会话不存在' }, { status: 404 });
  }

  const { data: messages } = await admin
    .from('messages')
    .select('id, role, content, created_at, model_used, total_tokens')
    .eq('conversation_id', params.id)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true });

  const emailMap = conversation.user_id
    ? await buildEmailMap([conversation.user_id])
    : new Map<string, string>();

  let roleName = '';
  if (conversation.role_id) {
    const { data: role } = await admin
      .from('ai_roles')
      .select('name, icon')
      .eq('id', conversation.role_id)
      .maybeSingle();
    roleName = role?.name ?? '';
  }

  return Response.json({
    conversation: {
      ...conversation,
      userEmail: conversation.user_id
        ? emailMap.get(conversation.user_id) ?? ''
        : '',
      roleName,
    },
    messages: messages ?? [],
  });
}
