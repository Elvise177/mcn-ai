'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { adminFetcher } from '@/lib/admin/client';

type AdminRole = {
  id: string;
  name: string;
  icon: string | null;
  model: string;
  temperature: number;
  is_active: boolean;
  currentPromptVersion: number | null;
};

type RoleDetail = {
  role: AdminRole;
  currentPrompt: { system_prompt: string; version_number: number } | null;
  versions: {
    id: string;
    version_number: number;
    system_prompt: string;
    change_note: string | null;
    created_at: string;
  }[];
};

export default function AdminRolesPage() {
  const { data, isLoading, mutate } = useSWR<AdminRole[]>(
    '/api/v1/admin/roles',
    adminFetcher,
  );
  const [editId, setEditId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">角色管理</h1>

      {isLoading ? (
        <Loader2 className="h-6 w-6 animate-spin" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>图标</TableHead>
              <TableHead>名称</TableHead>
              <TableHead>模型</TableHead>
              <TableHead>温度</TableHead>
              <TableHead>Prompt 版本</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((role) => (
              <TableRow key={role.id}>
                <TableCell>{role.icon ?? '🤖'}</TableCell>
                <TableCell>{role.name}</TableCell>
                <TableCell className="font-mono text-xs">{role.model}</TableCell>
                <TableCell>{role.temperature}</TableCell>
                <TableCell>v{role.currentPromptVersion ?? '-'}</TableCell>
                <TableCell>
                  <Badge variant={role.is_active ? 'default' : 'secondary'}>
                    {role.is_active ? '激活' : '禁用'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditId(role.id)}
                  >
                    编辑
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editId && (
        <RoleEditDialog
          roleId={editId}
          onClose={() => setEditId(null)}
          onSaved={() => {
            setEditId(null);
            mutate();
          }}
        />
      )}
    </div>
  );
}

function RoleEditDialog({
  roleId,
  onClose,
  onSaved,
}: {
  roleId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data, isLoading, mutate } = useSWR<RoleDetail>(
    `/api/v1/admin/roles/${roleId}`,
    adminFetcher,
  );

  const [prompt, setPrompt] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [isActive, setIsActive] = useState(true);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !initialized) {
      setPrompt(data.currentPrompt?.system_prompt ?? '');
      setTemperature(data.role.temperature);
      setIsActive(data.role.is_active);
      setInitialized(true);
    }
  }, [data, initialized]);

  const displayPrompt =
    viewVersion !== null
      ? data?.versions.find((v) => v.version_number === viewVersion)
          ?.system_prompt
      : prompt;

  async function saveMeta() {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/admin/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ temperature, isActive }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success('角色设置已保存');
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function savePrompt() {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/admin/roles/${roleId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, changeNote }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success(`已创建 Prompt v${body.version_number}`);
      setChangeNote('');
      setViewVersion(null);
      mutate();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function rollback(versionNumber: number) {
    try {
      const res = await fetch(`/api/v1/admin/roles/${roleId}/prompt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionNumber }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success(`已回滚到 v${versionNumber}`);
      setViewVersion(null);
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '回滚失败');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            编辑角色：{data?.role.name ?? ''}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !data ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>温度 {temperature.toFixed(1)}</Label>
                <Slider
                  min={0}
                  max={1}
                  step={0.1}
                  value={[temperature]}
                  onValueChange={([v]) => setTemperature(v ?? 0.7)}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <Label>激活状态</Label>
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </div>
            </div>
            <Button variant="outline" onClick={saveMeta} disabled={saving}>
              保存温度/状态
            </Button>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>System Prompt</Label>
                <Select
                  value={viewVersion?.toString() ?? 'current'}
                  onValueChange={(v) => {
                    if (v === 'current') setViewVersion(null);
                    else setViewVersion(Number(v));
                  }}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="历史版本" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="current">当前编辑</SelectItem>
                    {data.versions.map((v) => (
                      <SelectItem
                        key={v.id}
                        value={String(v.version_number)}
                      >
                        v{v.version_number} - {v.change_note || '无说明'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                className="min-h-[420px] font-mono text-sm"
                value={displayPrompt ?? ''}
                onChange={(e) => {
                  setViewVersion(null);
                  setPrompt(e.target.value);
                }}
                readOnly={viewVersion !== null}
              />
              {viewVersion !== null && (
                <Button
                  variant="secondary"
                  onClick={() => rollback(viewVersion)}
                >
                  回滚到此版本
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <Label>改动说明</Label>
              <Input
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                placeholder="描述本次 Prompt 变更"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button
            style={{ backgroundColor: '#FF3366' }}
            className="text-white"
            onClick={savePrompt}
            disabled={saving || viewVersion !== null}
          >
            保存为新版本
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
