/**
 * 供 scripts/*.ts 使用（tsx 直接跑 Node，不能 import server-only）
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请先配置 .env.local`);
  }
  return value;
}

export function createScriptAdminClient() {
  return createSupabaseClient<Database>(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
