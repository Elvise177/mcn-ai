import 'server-only';

import { config } from '@/config';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SystemSettingsValue } from '@/types/admin';
import type { Json } from '@/types/database';

export type { SystemSettingsValue };

const SETTINGS_KEY = 'global';

export function getDefaultSystemSettings(): SystemSettingsValue {
  return {
    ai: {
      defaultProvider: config.ai.defaultProvider,
      defaultModel: config.ai.providers.aihubmix.defaultModel,
      temperature: 0.7,
      maxTokens: 4000,
    },
    limits: {
      maxMessagesPerConversation: config.limits.maxMessagesPerConversation,
      maxDailyMessagesPerUser: config.limits.maxDailyMessagesPerUser,
      maxTokensPerMessage: config.limits.maxTokensPerMessage,
      maxHistoryMessages: config.limits.maxHistoryMessages,
    },
    features: { ...config.features } as Record<string, boolean>,
  };
}

export async function getSystemSettings(): Promise<SystemSettingsValue> {
  const defaults = getDefaultSystemSettings();
  const admin = createAdminClient();

  const { data } = await admin
    .from('system_settings')
    .select('value')
    .eq('key', SETTINGS_KEY)
    .maybeSingle<{ value: Json }>();

  if (!data?.value || typeof data.value !== 'object' || data.value === null) {
    return defaults;
  }

  const stored = data.value as Partial<SystemSettingsValue>;
  return {
    ai: { ...defaults.ai, ...stored.ai },
    limits: { ...defaults.limits, ...stored.limits },
    features: { ...defaults.features, ...stored.features },
  };
}

export async function saveSystemSettings(
  value: SystemSettingsValue,
  updatedBy: string,
) {
  const admin = createAdminClient();
  const { error } = await admin.from('system_settings').upsert({
    key: SETTINGS_KEY,
    value: value as unknown as Json,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  });

  if (error) throw error;
}
