import '@/lib/events/init';

import { eventBus, Events } from '@/lib/events/bus';
import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { buildEmailMap } from '@/lib/admin/emails';
import { createAdminClient } from '@/lib/supabase/admin';

function monthStartDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export async function GET(req: Request) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const { searchParams } = new URL(req.url);
  const search = searchParams.get('search')?.trim().toLowerCase() ?? '';

  const admin = createAdminClient();
  let query = admin
    .from('user_profiles')
    .select('*')
    .order('created_at', { ascending: false });

  const orgId = scopeOrgId(ctx);
  if (orgId) query = query.eq('organization_id', orgId);

  const { data: profiles, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const userIds = (profiles ?? []).map((p) => p.id);
  const emailMap = await buildEmailMap(userIds);

  const monthStart = monthStartDate();
  let usageQuery = admin
    .from('usage_stats_daily')
    .select('user_id, message_count')
    .gte('date', monthStart);
  if (orgId) usageQuery = usageQuery.eq('organization_id', orgId);
  const { data: usageRows } = await usageQuery;

  const monthlyMessages: Record<string, number> = {};
  for (const row of usageRows ?? []) {
    if (!row.user_id) continue;
    monthlyMessages[row.user_id] =
      (monthlyMessages[row.user_id] ?? 0) + (row.message_count ?? 0);
  }

  let users = (profiles ?? []).map((p) => ({
    id: p.id,
    email: emailMap.get(p.id) ?? '',
    name: p.name,
    role: p.role,
    isActive: p.is_active,
    createdAt: p.created_at,
    monthlyMessages: monthlyMessages[p.id] ?? 0,
    organizationId: p.organization_id,
  }));

  if (search) {
    users = users.filter(
      (u) =>
        u.email.toLowerCase().includes(search) ||
        (u.name ?? '').toLowerCase().includes(search),
    );
  }

  return Response.json(users);
}

export async function POST(req: Request) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const body = (await req.json()) as {
    email?: string;
    password?: string;
    name?: string;
    role?: string;
  };

  if (!body.email || !body.password) {
    return Response.json({ error: '邮箱和密码必填' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: body.name ? { name: body.name } : undefined,
    });

  if (authError || !authData.user) {
    return Response.json(
      { error: authError?.message ?? '创建用户失败' },
      { status: 500 },
    );
  }

  let organizationId = ctx.organizationId;
  if (!organizationId) {
    const { data: mainOrg } = await admin
      .from('organizations')
      .select('id')
      .eq('slug', 'main')
      .single();
    organizationId = mainOrg?.id ?? null;
  }

  if (!organizationId) {
    return Response.json({ error: '未找到主组织' }, { status: 500 });
  }

  const { error: profileError } = await admin.from('user_profiles').upsert({
    id: authData.user.id,
    name: body.name ?? null,
    organization_id: organizationId,
    role: body.role ?? 'member',
    is_active: true,
  });

  if (profileError) {
    await admin.auth.admin.deleteUser(authData.user.id);
    return Response.json({ error: profileError.message }, { status: 500 });
  }

  eventBus.emit(Events.ADMIN_USER_CREATED, {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    resourceType: 'user',
    resourceId: authData.user.id,
    details: { email: body.email, role: body.role ?? 'member' },
  });

  return Response.json({
    id: authData.user.id,
    email: body.email,
    name: body.name ?? null,
    role: body.role ?? 'member',
    isActive: true,
  });
}
