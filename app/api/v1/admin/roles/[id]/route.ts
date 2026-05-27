import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import type { TablesUpdate } from '@/types/database';

async function getRoleInScope(roleId: string, orgId: string | null) {
  const admin = createAdminClient();
  let query = admin.from('ai_roles').select('*').eq('id', roleId);
  if (orgId) query = query.eq('organization_id', orgId);
  const { data } = await query.maybeSingle();
  return data;
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const body = (await req.json()) as {
    name?: string;
    description?: string;
    icon?: string;
    model?: string;
    modelProvider?: string;
    temperature?: number;
    isActive?: boolean;
    sortOrder?: number;
  };

  const role = await getRoleInScope(params.id, scopeOrgId(ctx));
  if (!role) return Response.json({ error: '角色不存在' }, { status: 404 });

  const patch: TablesUpdate<'ai_roles'> = {
    updated_at: new Date().toISOString(),
  };
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      return Response.json({ error: '角色名称不能为空' }, { status: 400 });
    }
    patch.name = name;
  }
  if (body.description !== undefined) {
    patch.description = body.description.trim() || null;
  }
  if (body.icon !== undefined) patch.icon = body.icon.trim() || '🤖';
  if (body.model !== undefined) {
    const model = body.model.trim();
    if (!model) {
      return Response.json({ error: '模型不能为空' }, { status: 400 });
    }
    patch.model = model;
  }
  if (body.modelProvider !== undefined) {
    patch.model_provider = body.modelProvider.trim() || 'aihubmix';
  }
  if (body.temperature !== undefined) patch.temperature = body.temperature;
  if (body.isActive !== undefined) patch.is_active = body.isActive;
  if (body.sortOrder !== undefined) patch.sort_order = body.sortOrder;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ai_roles')
    .update(patch)
    .eq('id', params.id)
    .select()
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const role = await getRoleInScope(params.id, scopeOrgId(ctx));
  if (!role) return Response.json({ error: '角色不存在' }, { status: 404 });

  const admin = createAdminClient();
  const { count } = await admin
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('role_id', params.id);

  if (count && count > 0) {
    return Response.json(
      {
        error: `该角色已有 ${count} 个对话，无法删除。可先禁用角色，或清理相关对话后再试。`,
      },
      { status: 409 },
    );
  }

  const { error } = await admin.from('ai_roles').delete().eq('id', params.id);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ ok: true });
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const admin = createAdminClient();
  const orgId = scopeOrgId(ctx);

  let query = admin.from('ai_roles').select('*').eq('id', params.id);
  if (orgId) query = query.eq('organization_id', orgId);
  const { data: role } = await query.maybeSingle();
  if (!role) return Response.json({ error: '角色不存在' }, { status: 404 });

  let currentPrompt = null;
  if (role.current_prompt_version_id) {
    const { data } = await admin
      .from('prompt_versions')
      .select('*')
      .eq('id', role.current_prompt_version_id)
      .maybeSingle();
    currentPrompt = data;
  }

  const { data: versions } = await admin
    .from('prompt_versions')
    .select('*')
    .eq('role_id', params.id)
    .order('version_number', { ascending: false });

  return Response.json({ role, currentPrompt, versions: versions ?? [] });
}
