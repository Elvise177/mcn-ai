import '@/lib/events/init';

import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { eventBus, Events } from '@/lib/events/bus';
import { createAdminClient } from '@/lib/supabase/admin';
import type { TablesInsert } from '@/types/database';

async function resolveOrganizationId(
  ctx: Awaited<ReturnType<typeof requireAdmin>>,
) {
  if (ctx instanceof Response) return null;
  if (ctx.organizationId) return ctx.organizationId;

  const admin = createAdminClient();
  const { data: mainOrg } = await admin
    .from('organizations')
    .select('id')
    .eq('slug', 'main')
    .single();
  return mainOrg?.id ?? null;
}

export async function GET() {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const admin = createAdminClient();
  let query = admin.from('ai_roles').select('*').order('sort_order', {
    ascending: true,
  });

  const orgId = scopeOrgId(ctx);
  if (orgId) query = query.eq('organization_id', orgId);

  const { data: roles, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const enriched = await Promise.all(
    (roles ?? []).map(async (role) => {
      let versionNumber: number | null = null;
      if (role.current_prompt_version_id) {
        const { data: version } = await admin
          .from('prompt_versions')
          .select('version_number, system_prompt')
          .eq('id', role.current_prompt_version_id)
          .maybeSingle();
        versionNumber = version?.version_number ?? null;
      }
      return {
        ...role,
        currentPromptVersion: versionNumber,
      };
    }),
  );

  return Response.json(enriched);
}

export async function POST(req: Request) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const body = (await req.json()) as {
    name?: string;
    description?: string;
    icon?: string;
    category?: string;
    model?: string;
    modelProvider?: string;
    temperature?: number;
    prompt?: string;
    sortOrder?: number;
    isActive?: boolean;
  };

  if (!body.name?.trim()) {
    return Response.json({ error: '角色名称必填' }, { status: 400 });
  }

  const organizationId = await resolveOrganizationId(ctx);
  if (!organizationId) {
    return Response.json({ error: '未找到主组织' }, { status: 500 });
  }

  const admin = createAdminClient();
  const orgId = scopeOrgId(ctx);
  if (orgId && orgId !== organizationId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data: maxSort } = await admin
    .from('ai_roles')
    .select('sort_order')
    .eq('organization_id', organizationId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const insert: TablesInsert<'ai_roles'> = {
    organization_id: organizationId,
    name: body.name.trim(),
    description: body.description?.trim() || null,
    icon: body.icon?.trim() || '🤖',
    category: body.category?.trim() || 'general',
    model: body.model?.trim() || 'claude-sonnet-4-6',
    model_provider: body.modelProvider?.trim() || 'aihubmix',
    temperature: body.temperature ?? 0.7,
    sort_order: body.sortOrder ?? (maxSort?.sort_order ?? 0) + 1,
    is_active: body.isActive ?? true,
  };

  const { data: role, error: roleError } = await admin
    .from('ai_roles')
    .insert(insert)
    .select()
    .single();

  if (roleError || !role) {
    return Response.json(
      { error: roleError?.message ?? '创建角色失败' },
      { status: 500 },
    );
  }

  const initialPrompt =
    body.prompt?.trim() ||
    `你是「${role.name}」助手。请根据用户问题提供专业、简洁的回答。`;

  const { data: version, error: versionError } = await admin
    .from('prompt_versions')
    .insert({
      role_id: role.id,
      version_number: 1,
      system_prompt: initialPrompt,
      change_note: '初始版本',
      created_by: ctx.userId,
    })
    .select()
    .single();

  if (versionError || !version) {
    await admin.from('ai_roles').delete().eq('id', role.id);
    return Response.json(
      { error: versionError?.message ?? '创建 Prompt 失败' },
      { status: 500 },
    );
  }

  await admin
    .from('ai_roles')
    .update({
      current_prompt_version_id: version.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', role.id);

  await eventBus.emitAsync(Events.ADMIN_ROLE_CREATED, {
    userId: ctx.userId,
    organizationId,
    resourceType: 'ai_role',
    resourceId: role.id,
    details: { name: role.name },
  });

  return Response.json({ ...role, current_prompt_version_id: version.id }, {
    status: 201,
  });
}
