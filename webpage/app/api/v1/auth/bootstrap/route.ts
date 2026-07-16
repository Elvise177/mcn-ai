import { NextResponse } from 'next/server';

import { bootstrapUserProfile } from '@/lib/auth/bootstrap-profile';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }

  const { error, role } = await bootstrapUserProfile(
    user.id,
    user.email ?? '',
    typeof user.user_metadata?.name === 'string'
      ? user.user_metadata.name
      : null,
  );

  if (error) {
    console.error('[bootstrap-profile]', error.message);
    return NextResponse.json(
      { error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, role });
}
