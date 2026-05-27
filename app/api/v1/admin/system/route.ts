import '@/lib/events/init';

import {
  getDefaultSystemSettings,
  getSystemSettings,
  saveSystemSettings,
} from '@/lib/admin/system-settings';
import { requireSuperAdmin } from '@/lib/admin/auth';
import { eventBus, Events } from '@/lib/events/bus';
import type { SystemSettingsValue } from '@/types/admin';

export async function GET() {
  const ctx = await requireSuperAdmin();
  if (ctx instanceof Response) return ctx;

  const settings = await getSystemSettings();
  return Response.json({
    settings,
    defaults: getDefaultSystemSettings(),
  });
}

export async function PATCH(req: Request) {
  const ctx = await requireSuperAdmin();
  if (ctx instanceof Response) return ctx;

  const body = (await req.json()) as Partial<SystemSettingsValue>;
  const current = await getSystemSettings();

  const next: SystemSettingsValue = {
    ai: { ...current.ai, ...body.ai },
    limits: { ...current.limits, ...body.limits },
    features: { ...current.features, ...body.features },
  };

  await saveSystemSettings(next, ctx.userId);

  eventBus.emit(Events.ADMIN_PROMPT_UPDATED, {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    resourceType: 'system_settings',
    resourceId: 'global',
    details: next,
  });

  return Response.json({ settings: next });
}
