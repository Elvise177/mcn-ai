import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import type { TablesUpdate } from '@/types/database';

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const body = (await req.json()) as {
    role?: string;
    isActive?: boolean;
    name?: string;
  };

  const admin = createAdminClient();
  const orgId = scopeOrgId(ctx);

  let verifyQuery = admin
    .from('user_profiles')
    .select('id')
    .eq('id', params.id);
  if (orgId) verifyQuery = verifyQuery.eq('organization_id', orgId);

  const { data: existing } = await verifyQuery.maybeSingle();
  if (!existing) {
    return Response.json({ error: '用户不存在' }, { status: 404 });
  }

  const patch: TablesUpdate<'user_profiles'> = {
    updated_at: new Date().toISOString(),
  };
  if (body.role !== undefined) patch.role = body.role;
  if (body.isActive !== undefined) patch.is_active = body.isActive;
  if (body.name !== undefined) patch.name = body.name;

  const { data, error } = await admin
    .from('user_profiles')
    .update(patch)
    .eq('id', params.id)
    .select()
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}
