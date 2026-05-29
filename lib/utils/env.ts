import { z } from 'zod';

const trim = (value: unknown) =>
  typeof value === 'string' ? value.trim() : value;

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.preprocess(trim, z.string().url()),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.preprocess(trim, z.string().min(1)),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(trim, z.string().min(1)),
  AIHUBMIX_API_KEY: z.preprocess(trim, z.string().min(1)),
  TIKHUB_API_KEY: z.preprocess(trim, z.string().min(1)),
  // V2+ 预留
  ANTHROPIC_API_KEY: z.preprocess(trim, z.string().min(1).optional()),
  OPENAI_API_KEY: z.preprocess(trim, z.string().min(1).optional()),
});

export const env = envSchema.parse(process.env);

export type Env = z.infer<typeof envSchema>;
