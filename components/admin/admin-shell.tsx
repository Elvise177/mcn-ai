'use client';

import {
  BarChart3,
  FileText,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Settings,
  Shield,
  UserCircle,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import useSWR from 'swr';

import { Button } from '@/components/ui/button';
import { adminFetcher } from '@/lib/admin/client';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

type AdminMe = {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  isSuperAdmin: boolean;
};

const NAV = [
  { href: '/admin', label: '总览 Dashboard', icon: LayoutDashboard },
  { href: '/admin/users', label: '用户管理', icon: Users },
  { href: '/admin/roles', label: '角色管理', icon: Shield },
  { href: '/admin/conversations', label: '对话监控', icon: MessageSquare },
  { href: '/admin/stats', label: '使用统计', icon: BarChart3 },
  { href: '/admin/logs', label: '审计日志', icon: FileText },
  {
    href: '/admin/system',
    label: '系统配置',
    icon: Settings,
    superAdminOnly: true,
  },
  { href: '/admin/profile', label: '个人中心', icon: UserCircle },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me } = useSWR<AdminMe>('/api/v1/admin/me', adminFetcher);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const displayName = me?.name || me?.email || '管理员';

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <Link href="/admin" className="text-lg font-bold text-[#FF3366]">
          OMG AI Admin
        </Link>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {displayName}
          </span>
          <Button variant="outline" size="sm" asChild>
            <Link href="/chat">返回用户视图</Link>
          </Button>
          <Button variant="ghost" size="icon" onClick={handleSignOut}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[220px] shrink-0 border-r bg-muted/30 p-3">
          <nav className="space-y-1">
            {NAV.filter(
              (item) => !item.superAdminOnly || me?.isSuperAdmin,
            ).map((item) => {
              const active =
                item.href === '/admin'
                  ? pathname === '/admin'
                  : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-background font-medium text-[#FF3366] shadow-sm'
                      : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
