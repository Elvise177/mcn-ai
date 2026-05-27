import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { buildEmailMap } from '@/lib/admin/emails';
import { createAdminClient } from '@/lib/supabase/admin';

function rangeStart(range: string) {
  const d = new Date();
  if (range === '7d') d.setDate(d.getDate() - 6);
  else if (range === '30d') d.setDate(d.getDate() - 29);
  else return null;
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const { searchParams } = new URL(req.url);
  const range = searchParams.get('range') ?? '7d';
  const startDate = rangeStart(range);

  const admin = createAdminClient();
  const orgId = scopeOrgId(ctx);

  let usageQuery = admin.from('usage_stats_daily').select('*');
  if (orgId) usageQuery = usageQuery.eq('organization_id', orgId);
  if (startDate) usageQuery = usageQuery.gte('date', startDate);

  const { data: usageRows, error } = await usageQuery;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const userRanking: Record<string, { messages: number; tokens: number; cost: number }> =
    {};
  const roleRanking: Record<string, number> = {};
  const tokenTrend: Record<string, number> = {};
  let totalTokens = 0;
  let totalCost = 0;

  for (const row of usageRows ?? []) {
    totalTokens += row.total_tokens ?? 0;
    totalCost += Number(row.total_cost_usd ?? 0);
    tokenTrend[row.date] = (tokenTrend[row.date] ?? 0) + (row.total_tokens ?? 0);

    if (row.user_id) {
      if (!userRanking[row.user_id]) {
        userRanking[row.user_id] = { messages: 0, tokens: 0, cost: 0 };
      }
      userRanking[row.user_id].messages += row.message_count ?? 0;
      userRanking[row.user_id].tokens += row.total_tokens ?? 0;
      userRanking[row.user_id].cost += Number(row.total_cost_usd ?? 0);
    }

    const rolesUsed = row.roles_used as Record<string, number> | null;
    if (rolesUsed) {
      for (const [roleId, count] of Object.entries(rolesUsed)) {
        roleRanking[roleId] = (roleRanking[roleId] ?? 0) + count;
      }
    }
  }

  const userIds = Object.keys(userRanking);
  const emailMap = await buildEmailMap(userIds);

  const { data: roles } = await admin.from('ai_roles').select('id, name, icon');
  const roleMap = new Map((roles ?? []).map((r) => [r.id, r]));

  return Response.json({
    summary: { totalTokens, totalCost },
    userRanking: userIds
      .map((id) => ({
        userId: id,
        email: emailMap.get(id) ?? id,
        ...userRanking[id],
      }))
      .sort((a, b) => b.messages - a.messages),
    roleRanking: Object.entries(roleRanking)
      .map(([roleId, count]) => ({
        roleId,
        name: roleMap.get(roleId)?.name ?? roleId,
        icon: roleMap.get(roleId)?.icon ?? '🤖',
        count,
      }))
      .sort((a, b) => b.count - a.count),
    tokenTrend: Object.entries(tokenTrend)
      .map(([date, tokens]) => ({ date, tokens }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  });
}
