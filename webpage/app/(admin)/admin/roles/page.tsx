'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
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

const MODEL_OPTIONS = [
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'gpt-4o',
  'gpt-4o-mini',
];

type AdminRole = {
  id: string;
  name: string;
  icon: string | null;
  model: string;
  temperature: number;
  is_active: boolean;
  enable_rag: boolean;
  currentPromptVersion: number | null;
};

type RoleDetail = {
  role: AdminRole & { description: string | null; enable_rag: boolean };
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
  const [createOpen, setCreateOpen] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [ragTogglingId, setRagTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function toggleActive(role: AdminRole, next: boolean) {
    setTogglingId(role.id);
    try {
      const res = await fetch(`/api/v1/admin/roles/${role.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success(next ? '已启用角色' : '已禁用角色');
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    } finally {
      setTogglingId(null);
    }
  }

  async function toggleRag(role: AdminRole, next: boolean) {
    setRagTogglingId(role.id);
    try {
      const res = await fetch(`/api/v1/admin/roles/${role.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enableRag: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success(next ? '已开启知识库检索' : '已关闭知识库检索');
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    } finally {
      setRagTogglingId(null);
    }
  }

  async function deleteRole(role: AdminRole) {
    if (
      !window.confirm(
        `确定删除角色「${role.name}」？此操作不可恢复。若该角色已有对话记录将无法删除。`,
      )
    ) {
      return;
    }
    setDeletingId(role.id);
    try {
      const res = await fetch(`/api/v1/admin/roles/${role.id}`, {
        method: 'DELETE',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success('角色已删除');
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">角色管理</h1>
        <Button
          className="text-white hover:opacity-90"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          新建角色
        </Button>
      </div>

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
              <TableHead>启用</TableHead>
              <TableHead>知识库(RAG)</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((role) => (
              <TableRow
                key={role.id}
                className={!role.is_active ? 'opacity-60' : undefined}
              >
                <TableCell>{role.icon ?? '🤖'}</TableCell>
                <TableCell>{role.name}</TableCell>
                <TableCell className="font-mono text-xs">{role.model}</TableCell>
                <TableCell>{role.temperature}</TableCell>
                <TableCell>v{role.currentPromptVersion ?? '-'}</TableCell>
                <TableCell>
                  <Switch
                    checked={role.is_active}
                    disabled={togglingId === role.id}
                    onCheckedChange={(checked) => toggleActive(role, checked)}
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={role.enable_rag}
                    disabled={ragTogglingId === role.id}
                    onCheckedChange={(checked) => toggleRag(role, checked)}
                  />
                </TableCell>
                <TableCell className="space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditId(role.id)}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={deletingId === role.id}
                    onClick={() => deleteRole(role)}
                  >
                    {deletingId === role.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {createOpen && (
        <CreateRoleDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            mutate();
          }}
        />
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

function CreateRoleDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🤖');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [temperature, setTemperature] = useState(0.7);
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim()) {
      toast.error('请填写角色名称');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/v1/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          icon: icon.trim() || '🤖',
          model,
          temperature,
          prompt: prompt.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success('角色已创建');
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新建角色</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>名称</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：脚本策划"
              />
            </div>
            <div className="space-y-2">
              <Label>图标（emoji）</Label>
              <Input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="🤖"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>模型</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
          <div className="space-y-2">
            <Label>初始 System Prompt（可选）</Label>
            <Textarea
              className="min-h-[120px] font-mono text-sm"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="留空将使用默认模板"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            className="text-white"
            onClick={submit}
            disabled={saving}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🤖');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [prompt, setPrompt] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [isActive, setIsActive] = useState(true);
  const [enableRag, setEnableRag] = useState(false);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !initialized) {
      setName(data.role.name);
      setIcon(data.role.icon ?? '🤖');
      setModel(data.role.model);
      setPrompt(data.currentPrompt?.system_prompt ?? '');
      setTemperature(data.role.temperature);
      setIsActive(data.role.is_active);
      setEnableRag(data.role.enable_rag ?? false);
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
        body: JSON.stringify({
          name: name.trim(),
          icon: icon.trim(),
          model,
          temperature,
          isActive,
          enableRag,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success('角色设置已保存');
      mutate();
      onSaved();
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
          <DialogTitle>编辑角色</DialogTitle>
        </DialogHeader>

        {isLoading || !data ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>图标</Label>
                <Input value={icon} onChange={(e) => setIcon(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>模型</Label>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_OPTIONS.includes(model) ? null : (
                      <SelectItem value={model}>{model}</SelectItem>
                    )}
                    {MODEL_OPTIONS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-1">
                <Label>启用状态</Label>
                <p className="text-xs text-muted-foreground">
                  禁用后用户端聊天将不再显示该角色
                </p>
              </div>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-1">
                <Label>知识库检索（RAG）</Label>
                <p className="text-xs text-muted-foreground">
                  开启后，该角色生成前会自动检索同组织的爆款脚本/口播转写并作为参考注入。适合脚本生成、钩子生成类角色。
                </p>
              </div>
              <Switch checked={enableRag} onCheckedChange={setEnableRag} />
            </div>
            <Button
              variant="outline"
              onClick={saveMeta}
              disabled={saving || !name.trim()}
            >
              保存基本信息
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
                className="min-h-[320px] font-mono text-sm"
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
