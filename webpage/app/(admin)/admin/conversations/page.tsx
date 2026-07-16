'use client';

import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import useSWR from 'swr';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
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

type ConversationRow = {
  id: string;
  userEmail: string;
  roleName: string;
  title: string;
  messageCount: number;
  updatedAt: string;
};

type ConversationDetail = {
  conversation: { title: string; userEmail: string; roleName: string };
  messages: {
    id: string;
    role: string;
    content: string;
    created_at: string;
  }[];
};

function ConversationsPageContent() {
  const searchParams = useSearchParams();
  const initialUserId = searchParams.get('userId') ?? '';

  const [userId, setUserId] = useState(initialUserId);
  const [roleId, setRoleId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [viewId, setViewId] = useState<string | null>(null);

  const { data: users } = useSWR<{ id: string; email: string }[]>(
    '/api/v1/admin/users',
    adminFetcher,
  );
  const { data: roles } = useSWR<{ id: string; name: string }[]>(
    '/api/v1/admin/roles',
    adminFetcher,
  );

  const listUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (userId) params.set('userId', userId);
    if (roleId) params.set('roleId', roleId);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (search.trim()) params.set('search', search.trim());
    const q = params.toString();
    return `/api/v1/admin/conversations${q ? `?${q}` : ''}`;
  }, [userId, roleId, dateFrom, dateTo, search]);

  const { data, isLoading } = useSWR<ConversationRow[]>(listUrl, adminFetcher);
  const { data: detail } = useSWR<ConversationDetail>(
    viewId ? `/api/v1/admin/conversations/${viewId}` : null,
    adminFetcher,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">对话监控</h1>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <div className="space-y-1">
          <Label>用户</Label>
          <Select
            value={userId || 'all'}
            onValueChange={(v) => setUserId(v === 'all' ? '' : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="全部用户" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部用户</SelectItem>
              {(users ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>角色</Label>
          <Select
            value={roleId || 'all'}
            onValueChange={(v) => setRoleId(v === 'all' ? '' : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="全部角色" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部角色</SelectItem>
              {(roles ?? []).map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>开始日期</Label>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label>结束日期</Label>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label>搜索消息</Label>
          <Input
            placeholder="关键词..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <Loader2 className="h-6 w-6 animate-spin" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>标题</TableHead>
              <TableHead>消息数</TableHead>
              <TableHead>最近更新</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.userEmail}</TableCell>
                <TableCell>{row.roleName}</TableCell>
                <TableCell className="max-w-[240px] truncate">
                  {row.title}
                </TableCell>
                <TableCell>{row.messageCount}</TableCell>
                <TableCell>
                  {format(new Date(row.updatedAt), 'MM-dd HH:mm')}
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setViewId(row.id)}
                  >
                    查看
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={!!viewId} onOpenChange={(open) => !open && setViewId(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detail?.conversation.title ?? '对话详情'}
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {detail?.conversation.userEmail} · {detail?.conversation.roleName}
            </p>
          </DialogHeader>
          <div className="space-y-4">
            {(detail?.messages ?? []).map((m) => (
              <div
                key={m.id}
                className={
                  m.role === 'user'
                    ? 'ml-8 rounded-lg bg-muted p-3 text-sm'
                    : 'mr-8 rounded-lg border bg-white p-3 text-sm'
                }
              >
                <p className="mb-1 text-xs text-muted-foreground">
                  {m.role === 'user' ? '用户' : 'AI'} ·{' '}
                  {format(new Date(m.created_at), 'yyyy-MM-dd HH:mm:ss')}
                </p>
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AdminConversationsPage() {
  return (
    <Suspense fallback={<Loader2 className="h-6 w-6 animate-spin" />}>
      <ConversationsPageContent />
    </Suspense>
  );
}
