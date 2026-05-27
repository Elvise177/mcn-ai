import { publicEnv } from '@/lib/utils/env.public';

/** 浏览器与 Edge Middleware 使用（仅公开 Supabase 配置） */
export const config = {
  supabase: {
    url: publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
} as const;
