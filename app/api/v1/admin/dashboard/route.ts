import { requireAdmin } from '@/lib/admin/auth';
import { buildEmailMap } from '@/lib/admin/emails';
import { createAdminClient } from '@/lib/supabase/admin';

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfMonthDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function daysAgoIso(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function GET() {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const admin = createAdminClient();
  const orgId = ctx.isSuperAdmin ? null : ctx.organizationId;
  const todayIso = startOfTodayIso();
  const monthStart = startOfMonthDate();
  const weekIso = daysAgoIso(6);

  const scope = <T extends { eq: (col: string, val: string) => T }>(
    query: T,
  ) => (orgId ? query.eq('organization_id', orgId) : query);

  let todayCountQuery = admin
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .gte('updated_at', todayIso);
  todayCountQuery = scope(todayCountQuery);

  let recentQuery = admin
    .from('conversations')
    .select('id, user_id, role_id, title, updated_at')
    .order('updated_at', { ascending: false })
    .limit(10);
  recentQuery = scope(recentQuery);

  let weekQuery = admin
    .from('conversations')
    .select('updated_at')
    .gte('updated_at', weekIso);
  weekQuery = scope(weekQuery);

  let usageQuery = admin.from('usage_stats_daily').select('*');
  if (orgId) usageQuery = usageQuery.eq('organization_id', orgId);

  let rolesQuery = admin
    .from('ai_roles')
    .select('id, name, icon')
    .order('sort_order', { ascending: true });
  if (orgId) rolesQuery = rolesQuery.eq('organization_id', orgId);

  const [
    { count: todayConversations },
    { data: recent },
    { data: weekConversations },
    { data: usageRows },
    { data: roles },
  ] = await Promise.all([
    todayCountQuery,
    recentQuery,
    weekQuery,
    usageQuery,
    rolesQuery,
  ]);

  const recentList = recent ?? [];
  const recentIds = recentList.map((c) => c.id);

  let activeUsers = 0;
  let messageCounts: Record<string, number> = {};

  if (recentIds.length > 0) {
    const { data: recentMessages } = await admin
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', recentIds);

    for (const m of recentMessages ?? []) {
      if (!m.conversation_id) continue;
      messageCounts[m.conversation_id] =
        (messageCounts[m.conversation_id] ?? 0) + 1;
    }
  }

  const { data: todayUserMessages } = await admin
    .from('messages')
    .select('conversation_id')
    .eq('role', 'user')
    .gte('created_at', todayIso);

  if ((todayUserMessages ?? []).length > 0) {
    const convIds = Array.from(
      new Set(
        (todayUserMessages ?? [])
          .map((m) => m.conversation_id)
          .filter(Boolean) as string[],
      ),
    );
    if (convIds.length > 0) {
      let activeQuery = admin
        .from('conversations')
        .select('user_id')
        .in('id', convIds);
      activeQuery = scope(activeQuery);
      const { data: activeConvs } = await activeQuery;
      activeUsers = new Set(
        (activeConvs ?? []).map((c) => c.user_id).filter(Boolean),
      ).size;
    }
  }

  const monthUsage = (usageRows ?? []).filter((r) => r.date >= monthStart);
  const monthlyTokens = monthUsage.reduce(
    (s, r) => s + (r.total_tokens ?? 0),
    0,
  );
  const monthlyCost = monthUsage.reduce(
    (s, r) => s + Number(r.total_cost_usd ?? 0),
    0,
  );

  const roleUsageMap: Record<string, number> = {};
  for (const row of usageRows ?? []) {
    const rolesUsed = row.roles_used as Record<string, number> | null;
    if (!rolesUsed) continue;
    for (const [roleId, count] of Object.entries(rolesUsed)) {
      roleUsageMap[roleId] = (roleUsageMap[roleId] ?? 0) + count;
    }
  }

  const roleUsage = (roles ?? []).map((role) => ({
    id: role.id,
    name: role.name,
    icon: role.icon,
    count: roleUsageMap[role.id] ?? 0,
  }));

  const trendMap: Record<string, number> = {};
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    trendMap[d.toISOString().slice(0, 10)] = 0;
  }
  for (const conv of weekConversations ?? []) {
    const day = conv.updated_at.slice(0, 10);
    if (day in trendMap) trendMap[day] += 1;
  }
  const conversationTrend = Object.entries(trendMap).map(([date, count]) => ({
    date,
    count,
  }));

  const userIds = Array.from(
    new Set(recentList.map((c) => c.user_id).filter(Boolean)),
  ) as string[];
  const emailMap = await buildEmailMap(userIds);
  const roleMap = new Map((roles ?? []).map((r) => [r.id, r.name]));

  const recentConversations = recentList.map((c) => ({
    id: c.id,
    title: c.title,
    userEmail: c.user_id ? emailMap.get(c.user_id) ?? c.user_id : '',
    roleName: c.role_id ? roleMap.get(c.role_id) ?? '' : '',
    messageCount: messageCounts[c.id] ?? 0,
    updatedAt: c.updated_at,
  }));

  return Response.json({
    kpis: {
      todayConversations: todayConversations ?? 0,
      activeUsers,
      monthlyTokens,
      monthlyCost,
    },
    roleUsage,
    conversationTrend,
    recentConversations,
  });
}
