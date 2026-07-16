import { createAdminClient } from '@/lib/supabase/admin';

export interface BearerUser {
  userId: string;
  organizationId: string | null;
}

/**
 * 桌面客户端鉴权：Authorization: Bearer <supabase access_token>。
 * 服务端验 token 取可信 user_id——私人层 RPC 是 security definer，
 * p_user_id 绝不能信客户端自报，必须从这里来。
 */
export async function authBearerUser(req: Request): Promise<BearerUser | null> {
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7);

  const admin = createAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;

  const { data: profile } = await admin
    .from('user_profiles')
    .select('organization_id, is_active')
    .eq('id', data.user.id)
    .single();
  if (!profile || profile.is_active === false) return null;

  return { userId: data.user.id, organizationId: profile.organization_id };
}
