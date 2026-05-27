import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import type { Json, Tables } from '@/types/database';

export interface UsagePayload {
  userId: string;
  organizationId: string;
  modelUsed: string;
  totalTokens: number;
  costUsd: number;
  roleId?: string;
}

export class UsageTracker {
  static async recordMessage(payload: UsagePayload) {
    const supabase = createAdminClient();
    const today = new Date().toISOString().split('T')[0];

    // 先查今天是否有记录
    const { data: existing } = await supabase
      .from('usage_stats_daily')
      .select('*')
      .eq('user_id', payload.userId)
      .eq('date', today)
      .maybeSingle<Tables<'usage_stats_daily'>>();

    if (existing) {
      const modelsUsed = {
        ...(existing.models_used as Record<string, number>),
      };
      modelsUsed[payload.modelUsed] = (modelsUsed[payload.modelUsed] || 0) + 1;

      const rolesUsed = {
        ...(existing.roles_used as Record<string, number>),
      };
      if (payload.roleId) {
        rolesUsed[payload.roleId] = (rolesUsed[payload.roleId] || 0) + 1;
      }

      await supabase
        .from('usage_stats_daily')
        .update({
          message_count: existing.message_count + 1,
          total_tokens: existing.total_tokens + payload.totalTokens,
          total_cost_usd: Number(existing.total_cost_usd) + payload.costUsd,
          models_used: modelsUsed as Json,
          roles_used: rolesUsed as Json,
        })
        .eq('id', existing.id);
    } else {
      await supabase.from('usage_stats_daily').insert({
        user_id: payload.userId,
        organization_id: payload.organizationId,
        date: today,
        message_count: 1,
        total_tokens: payload.totalTokens,
        total_cost_usd: payload.costUsd,
        models_used: { [payload.modelUsed]: 1 } as Json,
        roles_used: (payload.roleId ? { [payload.roleId]: 1 } : {}) as Json,
      });
    }
  }
}
