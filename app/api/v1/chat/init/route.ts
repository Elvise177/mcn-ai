import { requireUserProfile } from '@/lib/auth/server-profile';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const ADMIN_ROLES = ['super_admin', 'org_admin', 'org_editor'];

export async function GET() {
  const auth = await requireUserProfile();
  if ('error' in auth) return auth.error;
  const { user, profile } = auth;

  const admin = createAdminClient();
  const supabase = await createClient();

  let rolesQuery = admin
    .from('ai_roles')
    .select('id, name, description, icon, category, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (profile.organization_id) {
    rolesQuery = rolesQuery.eq('organization_id', profile.organization_id);
  }

  const [rolesRes, convRes] = await Promise.all([
    rolesQuery,
    supabase
      .from('conversations')
      .select('id, title, role_id, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false }),
  ]);

  if (rolesRes.error) {
    return Response.json({ error: rolesRes.error.message }, { status: 500 });
  }
  if (convRes.error) {
    return Response.json({ error: convRes.error.message }, { status: 500 });
  }

  return Response.json({
    email: user.email ?? '',
    role: profile.role,
    isAdmin: ADMIN_ROLES.includes(profile.role),
    roles: rolesRes.data ?? [],
    conversations: convRes.data ?? [],
  });
}
