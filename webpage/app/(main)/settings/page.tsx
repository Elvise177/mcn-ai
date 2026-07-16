'use client';

import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SignOutButton } from '@/components/auth/sign-out-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { UserRole } from '@/types';

const ROLE_LABELS: Record<UserRole, string> = {
  member: '普通成员',
  org_editor: '组织编辑',
  org_admin: '组织管理员',
  super_admin: '超级管理员',
};

const ADMIN_ROLES: UserRole[] = ['super_admin', 'org_admin', 'org_editor'];

type ProfileResponse = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
};

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/v1/profile');
        const body = (await res.json()) as ProfileResponse & { error?: string };
        if (!res.ok) throw new Error(body.error ?? '加载失败');
        setEmail(body.email);
        setName(body.name ?? '');
        setRole(body.role);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '加载用户信息失败');
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  async function saveName() {
    if (!name.trim()) {
      toast.error('姓名不能为空');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/v1/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success('姓名已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function changePassword() {
    if (newPassword.length < 6) {
      toast.error('新密码至少 6 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次密码不一致');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/v1/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success('密码已更新');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新失败');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </main>
    );
  }

  const isAdmin = ADMIN_ROLES.includes(role);

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/chat" title="返回聊天">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
          <p className="text-sm text-muted-foreground">管理你的账号信息</p>
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">账号信息</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>邮箱</Label>
              <Input value={email} disabled />
            </div>
            <div className="space-y-2">
              <Label>角色</Label>
              <Input value={ROLE_LABELS[role] ?? role} disabled />
              {!isAdmin && (
                <p className="text-xs text-muted-foreground">
                  如需管理后台权限，请联系超级管理员，或在 Supabase 执行
                  PROMOTE_USER_TO_ADMIN.sql。
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>姓名</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button onClick={saveName} disabled={saving}>
              保存姓名
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">修改密码</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>新密码</Label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>确认密码</Label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <Button onClick={changePassword} disabled={saving}>
              更新密码
            </Button>
          </CardContent>
        </Card>

        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">管理后台</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                AI 模型、Provider、用量限制等系统配置在管理后台维护，普通设置页不提供修改。
              </p>
              <Button variant="outline" asChild>
                <Link href="/admin" className="gap-2">
                  进入管理后台
                  <ExternalLink className="h-4 w-4" />
                </Link>
              </Button>
              {role === 'super_admin' && (
                <Button variant="outline" asChild>
                  <Link href="/admin/system">系统配置（仅超级管理员）</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        <div className="pt-2">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
