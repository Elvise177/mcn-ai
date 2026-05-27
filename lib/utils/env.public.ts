import { z } from 'zod';

const trim = (value: unknown) =>
  typeof value === 'string' ? value.trim() : value;

/** Edge / 浏览器可用的公开环境变量（勿含 service role 等密钥） */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.preprocess(trim, z.string().url()),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.preprocess(trim, z.string().min(1)),
});

export const publicEnv = publicEnvSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});
