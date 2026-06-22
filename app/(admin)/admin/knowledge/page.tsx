'use client';

import { Loader2, Sparkles, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { adminFetcher } from '@/lib/admin/client';

type KnowledgeOverview = {
  counts: Record<string, number>;
  total: number;
};

const SOURCE_TYPES = [
  { value: 'viral_breakdown', label: '爆款拆解' },
  { value: 'hot_script', label: '热门脚本' },
  { value: 'editing_template', label: '剪辑模板' },
] as const;

const TYPE_LABELS: Record<string, string> = {
  hot_script: '热门脚本',
  viral_breakdown: '爆款拆解',
  transcript: '口播转写',
  editing_template: '剪辑模板',
};

export default function AdminKnowledgePage() {
  const { data, isLoading, mutate } = useSWR<KnowledgeOverview>(
    '/api/v1/admin/knowledge',
    adminFetcher,
  );

  const [sourceType, setSourceType] =
    useState<(typeof SOURCE_TYPES)[number]['value']>('viral_breakdown');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (content.trim().length < 20) {
      toast.error('内容至少 20 字');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/admin/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.trim(),
          sourceType,
          metadata: category.trim()
            ? { product_category_l2: category.trim() }
            : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast.success(`已入库，生成 ${body.chunks} 个切片`);
      setContent('');
      setCategory('');
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '入库失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">知识库管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          上传爆款拆解、热门脚本等资料，脚本生成类角色（已开启 RAG）会自动检索引用。
        </p>
      </div>

      {/* 概览 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          Object.entries(TYPE_LABELS).map(([key, label]) => (
            <Card key={key}>
              <CardContent className="pt-6">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-2xl font-semibold">
                  {data?.counts?.[key] ?? 0}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    切片
                  </span>
                </p>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* 上传 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="h-4 w-4" />
            上传知识
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>类型</Label>
              <Select
                value={sourceType}
                onValueChange={(v) =>
                  setSourceType(v as (typeof SOURCE_TYPES)[number]['value'])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>品类（可选，便于检索过滤）</Label>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="如：护肤 / 彩妆 / 眼部彩妆"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>内容</Label>
            <Textarea
              className="min-h-[200px] text-sm"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="粘贴爆款拆解文档 / 脚本全文，系统会自动切片并向量化入库…"
            />
          </div>
          <Button
            className="bg-brand-gradient gap-2"
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            入库
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
