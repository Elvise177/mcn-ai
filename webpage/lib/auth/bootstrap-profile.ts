import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

async function getMainOrganizationId(admin: ReturnType<typeof createAdminClient>) {
  const { data: mainOrg, error: orgError } = await admin
    .from('organizations')
    .select('id')
    .eq('slug', 'main')
    .single();

  if (orgError || !mainOrg) {
    return {
      error: new Error(
        '未找到主组织 (organizations.slug=main)，请先在 Supabase 执行迁移 SQL。',
      ),
      organizationId: null as string | null,
    };
  }

  return { error: null, organizationId: mainOrg.id };
}

export async function bootstrapUserProfile(
  userId: string,
  email: string,
  displayName?: string | null,
) {
  const admin = createAdminClient();
  const { error: orgError, organizationId } = await getMainOrganizationId(admin);

  if (orgError || !organizationId) {
    return { error: orgError ?? new Error('组织配置错误') };
  }

  const name =
    displayName?.trim() ||
    email.split('@')[0] ||
    '用户';

  const { data: existing } = await admin
    .from('user_profiles')
    .select('id, organization_id, name, role, is_active')
    .eq('id', userId)
    .maybeSingle<{
      id: string;
      organization_id: string | null;
      name: string | null;
      role: string;
      is_active: boolean;
    }>();

  if (existing) {
    if (!existing.is_active) {
      return { error: new Error('账号已被禁用，请联系管理员。') };
    }

    const patch: {
      organization_id?: string;
      name?: string;
      updated_at?: string;
    } = {};

    if (!existing.organization_id) patch.organization_id = organizationId;
    if (!existing.name?.trim()) patch.name = name;

    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      const { error: updateError } = await admin
        .from('user_profiles')
        .update(patch)
        .eq('id', userId);

      if (updateError) {
        return { error: new Error(updateError.message) };
      }
    }

    return { error: null, role: existing.role };
  }

  const { count } = await admin
    .from('user_profiles')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'super_admin');

  const role = (count ?? 0) === 0 ? 'super_admin' : 'member';

  const { error } = await admin.from('user_profiles').insert({
    id: userId,
    organization_id: organizationId,
    name,
    role,
    is_active: true,
  });

  if (error) {
    return { error: new Error(error.message) };
  }

  return { error: null, role };
}
