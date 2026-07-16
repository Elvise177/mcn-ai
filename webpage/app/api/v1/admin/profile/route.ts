import { requireAdmin } from '@/lib/admin/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from('user_profiles')
    .select('*')
    .eq('id', ctx.userId)
    .single();

  return Response.json({
    id: ctx.userId,
    email: ctx.email,
    name: profile?.name ?? ctx.name,
    role: ctx.role,
    organizationId: ctx.organizationId,
    createdAt: profile?.created_at,
  });
}

export async function PATCH(req: Request) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const body = (await req.json()) as { name?: string };
  if (!body.name?.trim()) {
    return Response.json({ error: '姓名不能为空' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('user_profiles')
    .update({
      name: body.name.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', ctx.userId)
    .select()
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

export async function POST(req: Request) {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const body = (await req.json()) as {
    password?: string;
    newPassword?: string;
  };

  if (!body.newPassword || body.newPassword.length < 6) {
    return Response.json({ error: '新密码至少 6 位' }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    password: body.newPassword,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ success: true });
}
