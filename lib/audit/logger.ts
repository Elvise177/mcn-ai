import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';

export interface AuditLogEntry {
  userId?: string;
  organizationId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export class AuditLogger {
  static async log(entry: AuditLogEntry) {
    try {
      const supabase = createAdminClient();
      await supabase.from('audit_logs').insert({
        user_id: entry.userId,
        organization_id: entry.organizationId,
        action: entry.action,
        resource_type: entry.resourceType,
        resource_id: entry.resourceId,
        details: (entry.details || {}) as Json,
        ip_address: entry.ipAddress,
        user_agent: entry.userAgent,
      });
    } catch (e) {
      console.error('[AuditLogger] Failed to log:', e);
      // 审计日志失败不应该影响主流程
    }
  }
}
