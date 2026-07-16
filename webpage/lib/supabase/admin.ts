import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { config } from '@/config';
import type { Database } from '@/types/database';

export function createAdminClient() {
  return createSupabaseClient<Database>(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
