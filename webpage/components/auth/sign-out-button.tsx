'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleSignOut}
      disabled={loading}
    >
      {loading ? '退出中…' : '退出登录'}
    </Button>
  );
}
