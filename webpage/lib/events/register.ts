import 'server-only';

import { AuditLogger } from '@/lib/audit/logger';
import { UsageTracker, type UsagePayload } from '@/lib/usage/tracker';

import { eventBus, Events } from './bus';

let registered = false;

export function registerEventHandlers() {
  if (registered) return;
  registered = true;

  // 所有事件记审计日志
  Object.entries(Events).forEach(([, eventName]) => {
    eventBus.on(eventName, async (payload: unknown) => {
      const p = payload as Record<string, unknown> | undefined;
      await AuditLogger.log({
        userId: p?.userId as string | undefined,
        organizationId: p?.organizationId as string | undefined,
        action: eventName,
        resourceType: p?.resourceType as string | undefined,
        resourceId: p?.resourceId as string | undefined,
        details: (p?.details as Record<string, unknown>) || p,
        ipAddress: p?.ipAddress as string | undefined,
        userAgent: p?.userAgent as string | undefined,
      });
    });
  });

  // AI 响应生成后，更新使用统计
  eventBus.on(Events.AI_RESPONSE_GENERATED, async (payload: unknown) => {
    const p = payload as Partial<UsagePayload> | undefined;
    if (p?.userId && p?.organizationId) {
      await UsageTracker.recordMessage(payload as UsagePayload);
    }
  });
}
