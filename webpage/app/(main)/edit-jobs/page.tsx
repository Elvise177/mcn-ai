'use client';

import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { ArrowLeft, Clapperboard, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type EditJob = {
  id: string;
  status: string;
  instruction: string | null;
  draft_url: string | null;
  error_message: string | null;
  created_at: string;
  imported_video_id: string | null;
};

type ImportedVideo = {
  id: string;
  aweme_id: string;
  video_desc: string | null;
  latest_transcript: { status: string } | null;
};

const STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: '排队中', className: 'bg-gray-100 text-gray-600' },
  claimed: { label: '已认领', className: 'bg-blue-100 text-blue-700' },
  analyzing: { label: 'AI 分析中', className: 'bg-amber-100 text-amber-700' },
  drafting: { label: '生成草稿中', className: 'bg-amber-100 text-amber-700' },
  done: { label: '已完成', className: 'bg-green-100 text-green-700' },
  failed: { label: '失败', className: 'bg-red-100 text-red-600' },
};

const ACTIVE_STATUSES = ['pending', 'claimed', 'analyzing', 'drafting'];

export default function EditJobsPage() {
  const [jobs, setJobs] = useState<EditJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/edit-jobs');
      if (!res.ok) throw new Error(await res.text());
      setJobs(await res.json());
    } catch {
      // 静默，避免轮询噪音
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 有进行中任务时每 5 秒轮询
  useEffect(() => {
    const hasActive = jobs.some((j) => ACTIVE_STATUSES.includes(j.status));
    if (!hasActive) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [jobs, refresh]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/chat" title="返回">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Clapperboard className="h-5 w-5 text-primary" />
              自动剪辑
            </h1>
            <p className="text-xs text-muted-foreground">
              AI 生成剪映草稿，剪辑师在剪映中精修导出
            </p>
          </div>
        </div>
        <Button
          className="bg-brand-gradient gap-2"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          新建剪辑
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          还没有剪辑任务。先在「视频导入」里转写视频，再来这里发起剪辑。
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const s = STATUS[job.status] ?? STATUS.pending;
            return (
              <div
                key={job.id}
                className="rounded-xl border bg-card p-4 shadow-soft"
              >
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs font-medium',
                      s.className,
                    )}
                  >
                    {ACTIVE_STATUSES.includes(job.status) && (
                      <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                    )}
                    {s.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(job.created_at), {
                      addSuffix: true,
                      locale: zhCN,
                    })}
                  </span>
                </div>
                {job.instruction && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    要求：{job.instruction}
                  </p>
                )}
                {job.status === 'done' && job.draft_url && (
                  <p className="mt-2 break-all text-sm">
                    草稿：
                    <span className="font-mono text-xs text-primary">
                      {job.draft_url}
                    </span>
                  </p>
                )}
                {job.status === 'failed' && job.error_message && (
                  <p className="mt-2 text-sm text-red-600">
                    {job.error_message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {createOpen && (
        <CreateJobDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function CreateJobDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [videos, setVideos] = useState<ImportedVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [awemeId, setAwemeId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/v1/videos/import?limit=50');
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as ImportedVideo[];
        // 只保留已转写的
        setVideos(
          data.filter((v) => v.latest_transcript?.status === 'done'),
        );
      } catch {
        toast.error('加载视频列表失败');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function submit() {
    if (!awemeId) {
      toast.error('请选择视频');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/edit-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ awemeId, instruction: instruction.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success(body.existed ? '该视频已有进行中的任务' : '剪辑任务已创建');
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新建剪辑任务</DialogTitle>
        </DialogHeader>
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : videos.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            没有已转写的视频。请先到「视频导入」解析视频并完成口播转写。
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>选择视频（仅显示已转写）</Label>
              <Select value={awemeId} onValueChange={setAwemeId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择一个已转写的视频" />
                </SelectTrigger>
                <SelectContent>
                  {videos.map((v) => (
                    <SelectItem key={v.id} value={v.aweme_id}>
                      {(v.video_desc || v.aweme_id).slice(0, 30)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>剪辑要求（可选）</Label>
              <Textarea
                className="min-h-[100px] text-sm"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="如：节奏快一点，突出前 3 秒钩子，保留卖点段落，去掉口误…"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            className="bg-brand-gradient"
            onClick={submit}
            disabled={submitting || loading || videos.length === 0}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
