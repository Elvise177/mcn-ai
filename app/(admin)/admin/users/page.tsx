'use client';

import { format } from 'date-fns';
import { Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { adminFetcher } from '@/lib/admin/client';

type AdminUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
  monthlyMessages: number;
};

const ROLES = ['member', 'org_editor', 'org_admin', 'super_admin'];

export default function AdminUsersPage() {
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);

  const url = useMemo(() => {
    const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    return `/api/v1/admin/users${q}`;
  }, [search]);

  const { data, isLoading, mutate } = useSWR<AdminUser[]>(url, adminFetcher);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">用户管理</h1>
        <Button
          className="text-white hover:opacity-90"
          style={{ backgroundColor: '#FF3366' }}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          创建用户
        </Button>
      </div>

      <Input
        placeholder="按邮箱搜索..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />

      {isLoading ? (
        <Loader2 className="h-6 w-6 animate-spin" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>邮箱</TableHead>
              <TableHead>姓名</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>本月对话</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((user) => (
              <TableRow key={user.id}>
                <TableCell>{user.email}</TableCell>
                <TableCell>{user.name || '-'}</TableCell>
                <TableCell>{user.role}</TableCell>
                <TableCell>
                  <Badge variant={user.isActive ? 'default' : 'secondary'}>
                    {user.isActive ? '激活' : '禁用'}
                  </Badge>
                </TableCell>
                <TableCell>
                  {format(new Date(user.createdAt), 'yyyy-MM-dd')}
                </TableCell>
                <TableCell>{user.monthlyMessages}</TableCell>
                <TableCell className="space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditUser(user)}
                  >
                    编辑
                  </Button>
                  <Button variant="ghost" size="sm" asChild>
                    <Link
                      href={`/admin/conversations?userId=${user.id}`}
                    >
                      查看对话
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <UserFormDialog
        open={createOpen}
        title="创建用户"
        onOpenChange={setCreateOpen}
        onSubmit={async (values) => {
          const res = await fetch('/api/v1/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || '创建失败');
          toast.success('用户已创建');
          mutate();
        }}
      />

      {editUser && (
        <UserFormDialog
          open
          title="编辑用户"
          initial={editUser}
          onOpenChange={(open) => !open && setEditUser(null)}
          onSubmit={async (values) => {
            const res = await fetch(`/api/v1/admin/users/${editUser.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                role: values.role,
                isActive: values.isActive,
                name: values.name,
              }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || '更新失败');
            toast.success('已保存');
            setEditUser(null);
            mutate();
          }}
        />
      )}
    </div>
  );
}

function UserFormDialog({
  open,
  title,
  initial,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial?: AdminUser;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: {
    email: string;
    password: string;
    name: string;
    role: string;
    isActive?: boolean;
  }) => Promise<void>;
}) {
  const [email, setEmail] = useState(initial?.email ?? '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [role, setRole] = useState(initial?.role ?? 'member');
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    try {
      await onSubmit({ email, password, name, role, isActive });
      onOpenChange(false);
      setEmail('');
      setPassword('');
      setName('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {!initial && (
            <>
              <div className="space-y-2">
                <Label>邮箱</Label>
                <Input value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>密码</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </>
          )}
          <div className="space-y-2">
            <Label>姓名</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>角色</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {initial && (
            <div className="space-y-2">
              <Label>激活状态</Label>
              <Select
                value={isActive ? 'active' : 'inactive'}
                onValueChange={(v) => setIsActive(v === 'active')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">激活</SelectItem>
                  <SelectItem value="inactive">禁用</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
