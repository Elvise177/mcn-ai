import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const ADMIN_ROLES = ['super_admin', 'org_admin', 'org_editor'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export type AdminContext = {
  userId: string;
  email: string;
  name: string | null;
  role: AdminRole;
  organizationId: string | null;
  isSuperAdmin: boolean;
};

export function jsonUnauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

export function jsonForbidden() {
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}

export async function getAdminContext(): Promise<AdminContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from('user_profiles')
    .select('id, name, role, organization_id, is_active')
    .eq('id', user.id)
    .maybeSingle<{
      id: string;
      name: string | null;
      role: string;
      organization_id: string | null;
      is_active: boolean;
    }>();

  if (!profile || !profile.is_active) {
    return null;
  }

  if (!ADMIN_ROLES.includes(profile.role as AdminRole)) {
    return null;
  }

  if (profile.role !== 'super_admin' && !profile.organization_id) {
    return null;
  }

  return {
    userId: user.id,
    email: user.email ?? '',
    name: profile.name,
    role: profile.role as AdminRole,
    organizationId: profile.organization_id,
    isSuperAdmin: profile.role === 'super_admin',
  };
}

export async function requireAdmin(): Promise<AdminContext | Response> {
  const ctx = await getAdminContext();
  if (!ctx) return jsonUnauthorized();
  return ctx;
}

export async function requireSuperAdmin(): Promise<AdminContext | Response> {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;
  if (!ctx.isSuperAdmin) return jsonForbidden();
  return ctx;
}

export function scopeOrgId(ctx: AdminContext): string | null {
  return ctx.isSuperAdmin ? null : ctx.organizationId;
}
