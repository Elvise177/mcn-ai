import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

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

    // 原子 upsert（见 007_phase0_fixes.sql），并发安全
    const { error } = await supabase.rpc('increment_usage_stats', {
      p_user_id: payload.userId,
      p_organization_id: payload.organizationId,
      p_date: today,
      p_tokens: payload.totalTokens,
      p_cost: payload.costUsd,
      p_model: payload.modelUsed,
      p_role_id: payload.roleId ?? '',
    });

    if (error) {
      console.error('[UsageTracker] increment_usage_stats failed:', error);
    }
  }

  /** 今日已发送消息数（用于每日限额检查） */
  static async getTodayMessageCount(userId: string): Promise<number> {
    const supabase = createAdminClient();
    const today = new Date().toISOString().split('T')[0];

    const { data } = await supabase
      .from('usage_stats_daily')
      .select('message_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle<{ message_count: number }>();

    return data?.message_count ?? 0;
  }
}
