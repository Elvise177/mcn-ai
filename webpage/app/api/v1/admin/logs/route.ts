import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { buildEmailMap } from '@/lib/admin/emails';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: Request) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const dateFrom = searchParams.get('dateFrom');
  const dateTo = searchParams.get('dateTo');
  const limit = Math.min(Number(searchParams.get('limit') ?? 100), 500);

  const admin = createAdminClient();
  const orgId = scopeOrgId(ctx);

  let query = admin
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (orgId) query = query.eq('organization_id', orgId);
  if (action) query = query.eq('action', action);
  if (dateFrom) query = query.gte('created_at', dateFrom);
  if (dateTo) query = query.lte('created_at', `${dateTo}T23:59:59.999Z`);

  const { data: logs, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const userIds = Array.from(
    new Set((logs ?? []).map((l) => l.user_id).filter(Boolean)),
  ) as string[];
  const emailMap = await buildEmailMap(userIds);

  return Response.json(
    (logs ?? []).map((log) => ({
      id: log.id,
      createdAt: log.created_at,
      userId: log.user_id,
      userEmail: log.user_id ? emailMap.get(log.user_id) ?? '' : '',
      action: log.action,
      resourceType: log.resource_type,
      resourceId: log.resource_id,
      details: log.details,
      ipAddress: log.ip_address,
      userAgent: log.user_agent,
    })),
  );
}
