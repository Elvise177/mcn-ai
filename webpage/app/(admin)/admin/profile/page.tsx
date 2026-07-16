'use client';

import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { adminFetcher } from '@/lib/admin/client';

type Profile = {
  id: string;
  email: string;
  name: string | null;
  role: string;
};

type AuditLog = {
  id: string;
  action: string;
  created_at: string;
  resource_type: string | null;
  details: unknown;
};

export default function AdminProfilePage() {
  const { data: profile, mutate } = useSWR<Profile>(
    '/api/v1/admin/profile',
    adminFetcher,
  );
  const { data: logs, isLoading: logsLoading } = useSWR<AuditLog[]>(
    '/api/v1/admin/profile/logs',
    adminFetcher,
  );

  const [name, setName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile?.name) setName(profile.name);
  }, [profile]);

  async function saveName() {
    setSaving(true);
    try {
      const res = await fetch('/api/v1/admin/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success('姓名已更新');
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    } finally {
      setSaving(false);
    }
  }

  async function changePassword() {
    if (newPassword !== confirmPassword) {
      toast.error('两次密码不一致');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/v1/admin/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success('密码已更新');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">个人中心</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>邮箱</Label>
            <Input value={profile?.email ?? ''} disabled />
          </div>
          <div className="space-y-2">
            <Label>角色</Label>
            <Input value={profile?.role ?? ''} disabled />
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">我的操作日志</CardTitle>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead>资源</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(logs ?? []).map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      {format(new Date(log.created_at), 'yyyy-MM-dd HH:mm')}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {log.action}
                    </TableCell>
                    <TableCell>{log.resource_type ?? '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
