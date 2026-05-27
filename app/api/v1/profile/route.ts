import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { Tables } from '@/types';

type ProfileRow = Pick<Tables<'user_profiles'>, 'name' | 'role' | 'created_at'>;

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile, error } = await admin
    .from('user_profiles')
    .select('name, role, created_at')
    .eq('id', user.id)
    .single<ProfileRow>();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({
    id: user.id,
    email: user.email ?? '',
    name: profile.name,
    role: profile.role,
    createdAt: profile.created_at,
  });
}

export async function PATCH(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

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
    .eq('id', user.id)
    .select('name, role')
    .single<Pick<ProfileRow, 'name' | 'role'>>();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json()) as { newPassword?: string };
  if (!body.newPassword || body.newPassword.length < 6) {
    return Response.json({ error: '新密码至少 6 位' }, { status: 400 });
  }

  const { error } = await supabase.auth.updateUser({
    password: body.newPassword,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ success: true });
}
