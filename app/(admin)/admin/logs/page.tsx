'use client';

import { format } from 'date-fns';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import useSWR from 'swr';

import { Button } from '@/components/ui/button';
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

type AuditLog = {
  id: string;
  createdAt: string;
  userEmail: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  details: unknown;
};

const ACTIONS = [
  'user.message.sent',
  'ai.response.generated',
  'conversation.created',
  'conversation.deleted',
  'user.logged_in',
  'user.logged_out',
  'admin.prompt.updated',
  'admin.role.created',
  'admin.user.created',
  'error.occurred',
];

export default function AdminLogsPage() {
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (action) params.set('action', action);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);

  const { data, isLoading } = useSWR<AuditLog[]>(
    `/api/v1/admin/logs?${params.toString()}`,
    adminFetcher,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">审计日志</h1>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <Label>操作类型</Label>
          <Select
            value={action || 'all'}
            onValueChange={(v) => setAction(v === 'all' ? '' : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="全部" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
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
      </div>

      {isLoading ? (
        <Loader2 className="h-6 w-6 animate-spin" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>时间</TableHead>
              <TableHead>用户</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>资源</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((log) => (
              <Fragment key={log.id}>
                <TableRow>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() =>
                        setExpanded(expanded === log.id ? null : log.id)
                      }
                    >
                      {expanded === log.id ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                  <TableCell>
                    {format(new Date(log.createdAt), 'yyyy-MM-dd HH:mm:ss')}
                  </TableCell>
                  <TableCell>{log.userEmail || '-'}</TableCell>
                  <TableCell className="font-mono text-xs">{log.action}</TableCell>
                  <TableCell>
                    {log.resourceType ?? '-'}
                    {log.resourceId ? ` / ${log.resourceId.slice(0, 8)}…` : ''}
                  </TableCell>
                </TableRow>
                {expanded === log.id && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
