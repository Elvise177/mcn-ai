import { createBrowserClient } from '@supabase/ssr';

import { config } from '@/config/public';
import type { Database } from '@/types/database';

export function createClient() {
  return createBrowserClient<Database>(
    config.supabase.url,
    config.supabase.anonKey,
  );
}
