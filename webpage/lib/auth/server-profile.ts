import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export type AuthProfile = {
  organization_id: string | null;
  role: string;
  is_active: boolean;
};

export async function requireUserProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      error: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const admin = createAdminClient();
  const { data: profile, error } = await admin
    .from('user_profiles')
    .select('organization_id, role, is_active')
    .eq('id', user.id)
    .maybeSingle<AuthProfile>();

  if (error || !profile) {
    return {
      error: Response.json({ error: 'Profile not found' }, { status: 404 }),
    };
  }

  if (!profile.is_active) {
    return {
      error: Response.json({ error: 'Account disabled' }, { status: 403 }),
    };
  }

  return { user, profile };
}
