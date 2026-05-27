import '@/lib/events/init';

import { PromptManager } from '@/lib/ai/prompts/manager';
import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { eventBus, Events } from '@/lib/events/bus';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const body = (await req.json()) as {
    prompt?: string;
    changeNote?: string;
  };

  if (!body.prompt?.trim()) {
    return Response.json({ error: 'Prompt 不能为空' }, { status: 400 });
  }

  const admin = createAdminClient();
  const orgId = scopeOrgId(ctx);
  let query = admin.from('ai_roles').select('id').eq('id', params.id);
  if (orgId) query = query.eq('organization_id', orgId);
  const { data: role } = await query.maybeSingle();
  if (!role) return Response.json({ error: '角色不存在' }, { status: 404 });

  const version = await PromptManager.createNewVersion(
    params.id,
    body.prompt.trim(),
    body.changeNote?.trim() || '管理员更新',
    ctx.userId,
  );

  eventBus.emit(Events.ADMIN_PROMPT_UPDATED, {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    resourceType: 'ai_role',
    resourceId: params.id,
    details: { versionNumber: version.version_number },
  });

  return Response.json(version);
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string } },
) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const body = (await req.json()) as { versionNumber?: number };
  if (!body.versionNumber) {
    return Response.json({ error: '缺少 versionNumber' }, { status: 400 });
  }

  const admin = createAdminClient();
  const orgId = scopeOrgId(ctx);
  let query = admin.from('ai_roles').select('id').eq('id', params.id);
  if (orgId) query = query.eq('organization_id', orgId);
  const { data: role } = await query.maybeSingle();
  if (!role) return Response.json({ error: '角色不存在' }, { status: 404 });

  await PromptManager.rollbackToVersion(params.id, body.versionNumber);
  return Response.json({ success: true });
}
