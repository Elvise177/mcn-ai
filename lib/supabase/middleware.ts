import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

import { config } from '@/config/public';
import type { Database } from '@/types/database';

const ADMIN_ROLES = ['super_admin', 'org_admin', 'org_editor'] as const;

function createMiddlewareAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function getUserProfile(userId: string): Promise<{
  role: string;
  is_active: boolean;
} | null> {
  try {
    const admin = createMiddlewareAdminClient();
    if (!admin) return null;

    const { data: profile } = await admin
      .from('user_profiles')
      .select('role, is_active')
      .eq('id', userId)
      .maybeSingle<{ role: string; is_active: boolean }>();

    return profile;
  } catch {
    return null;
  }
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    config.supabase.url,
    config.supabase.anonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options: CookieOptions;
          }[],
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (
    !user &&
    (path.startsWith('/chat') ||
      path.startsWith('/import') ||
      path.startsWith('/admin') ||
      path.startsWith('/settings'))
  ) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (user && path === '/login') {
    return NextResponse.redirect(new URL('/chat', request.url));
  }

  // 仅 /admin 页面需要查 DB 角色；/chat /settings /api 由各自 API 校验
  if (user && path.startsWith('/admin') && !path.startsWith('/api/')) {
    const profile = await getUserProfile(user.id);

    if (profile && !profile.is_active) {
      return NextResponse.redirect(
        new URL('/login?error=account_disabled', request.url),
      );
    }

    if (
      !profile?.role ||
      !ADMIN_ROLES.includes(profile.role as (typeof ADMIN_ROLES)[number])
    ) {
      return NextResponse.redirect(new URL('/chat', request.url));
    }

    if (path.startsWith('/admin/system') && profile.role !== 'super_admin') {
      return NextResponse.redirect(new URL('/admin', request.url));
    }
  }

  return response;
}
