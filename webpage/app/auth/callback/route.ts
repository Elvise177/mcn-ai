import { NextResponse } from 'next/server';

import { bootstrapUserProfile } from '@/lib/auth/bootstrap-profile';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/chat';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const result = await bootstrapUserProfile(
          user.id,
          user.email ?? '',
          typeof user.user_metadata?.name === 'string'
            ? user.user_metadata.name
            : null,
        );

        if (result.error) {
          return NextResponse.redirect(
            `${origin}/login?error=profile_setup_failed`,
          );
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
