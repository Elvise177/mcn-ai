'use client';

import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { ChevronDown, ChevronUp, Copy } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  flattenTranscriptFields,
  importedVideoToParsed,
  type ImportHistoryItem,
} from '@/lib/import/map-record';
import type { ParsedVideo } from '@/lib/import/parser';
import { cn } from '@/lib/utils';

const ACTIVE_AWEME_KEY = 'mcn_import_active_aweme_id';

function formatCount(n: number): string {
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  return n.toString();
}

function persistActiveAwemeId(awemeId: string) {
  try {
    sessionStorage.setItem(ACTIVE_AWEME_KEY, awemeId);
  } catch {
    /* ignore */
  }
}

function readActiveAwemeId(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_AWEME_KEY);
  } catch {
    return null;
  }
}

function TranscriptStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    none: { label: '未转写', className: 'bg-gray-100 text-gray-600' },
    processing: { label: '转写中', className: 'bg-amber-100 text-amber-700' },
    done: { label: '已转写', className: 'bg-green-100 text-green-700' },
    failed: { label: '转写失败', className: 'bg-red-100 text-red-600' },
  };
  const item = map[status] ?? map.none;
  return (
    <span
      className={cn(
        'rounded px-2 py-0.5 text-[11px] font-medium',
        item.className,
      )}
    >
      {item.label}
    </span>
  );
}

function TranscriptCard({
  row,
  transcribing,
  onTranscribe,
}: {
  row: ImportHistoryItem | null;
  transcribing: boolean;
  onTranscribe: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const t = row ? flattenTranscriptFields(row) : null;
  const status = t?.transcript_status ?? 'none';
  const busy = transcribing || status === 'processing';

  async function copyTranscript() {
    if (!t?.transcript) return;
    try {
      await navigator.clipboard.writeText(t.transcript);
      toast.success('已复制口播稿');
    } catch {
      toast.error('复制失败');
    }
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-800">口播稿</span>
          <TranscriptStatusBadge status={status} />
        </div>
        <div className="flex items-center gap-2">
          {status === 'done' && t?.transcript ? (
            <>
              <button
                type="button"
                onClick={() => void copyTranscript()}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-white"
              >
                <Copy className="h-3.5 w-3.5" />
                复制
              </button>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-0.5 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-white"
              >
                {expanded ? (
                  <>
                    收起 <ChevronUp className="h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    展开 <ChevronDown className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={onTranscribe}
            className="rounded-md bg-white px-3 py-1.5 text-xs text-rose-600 ring-1 ring-rose-200 hover:bg-rose-50 disabled:opacity-50"
          >
            {busy
              ? '转写中...'
              : status === 'done'
                ? '重新转写'
                : '生成口播稿'}
          </button>
        </div>
      </div>

      {status === 'done' && t?.transcript && expanded ? (
        <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-gray-700">
          {t.transcript}
        </p>
      ) : status === 'failed' ? (
        <p className="mt-2 text-xs text-red-500">
          {t?.transcript_error || '转写失败，请重试'}
        </p>
      ) : status === 'done' && t?.transcript && !expanded ? (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-gray-500">
          {t.transcript}
        </p>
      ) : (
        <p className="mt-2 text-xs text-gray-500">
          转写完成后可用于「写同类脚本」；口播稿会自动带入对话。
        </p>
      )}
    </div>
  );
}

function VideoCard({
  video,
  onAction,
}: {
  video: ParsedVideo;
  onAction: (action: 'analyze' | 'script') => void;
}) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className="flex gap-3">
        {video.cover_url ? (
          <img
            src={video.cover_url}
            alt=""
            className="h-32 w-24 shrink-0 rounded-lg bg-gray-100 object-cover"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            <span className="text-xs font-medium text-gray-500">
              @{video.author.nickname || '未知达人'}
            </span>
            {video.author.is_verified && (
              <span className="text-xs text-blue-500">✓</span>
            )}
            <span className="text-xs text-gray-400">
              · {video.author.aweme_count}作品 · 历史
              {formatCount(video.author.total_favorited)}赞
            </span>
          </div>

          <p className="mb-2 line-clamp-2 text-sm font-medium leading-snug text-gray-900">
            {video.desc}
          </p>

          <div className="mb-2 flex flex-wrap gap-3 text-xs text-gray-400">
            <span>❤️ {formatCount(video.stats.like)}</span>
            <span>💬 {formatCount(video.stats.comment)}</span>
            <span>↗ {formatCount(video.stats.share)}</span>
            <span>⭐ {formatCount(video.stats.collect)}</span>
          </div>

          <div className="mb-2 flex flex-wrap gap-2">
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
              收藏率 {video.stats.collect_rate}%
            </span>
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
              分享率 {video.stats.share_rate}%
            </span>
          </div>

          {video.category_tags.length > 0 && (
            <div className="mb-2 text-xs text-gray-500">
              📂 {video.category_tags.join(' / ')}
            </div>
          )}

          {video.is_shopping && video.product ? (
            <div className="mt-2 rounded-lg bg-pink-50 p-2">
              <div className="mb-1 line-clamp-2 text-xs font-medium text-pink-700">
                🛍 {video.product.title}
              </div>
              <div className="text-xs text-pink-500">
                {video.product.category_l1}/{video.product.category_l2}/
                {video.product.category_l3}
                · 累计已售 {formatCount(video.product.sales_total)}
              </div>
            </div>
          ) : (
            <div className="mt-2 text-xs text-amber-600">⚠️ 这不是带货视频</div>
          )}
        </div>
      </div>

      <div className="mt-4 flex gap-2 border-t border-gray-100 pt-4">
        <button
          type="button"
          onClick={() => onAction('analyze')}
          className="flex-1 rounded-lg bg-rose-50 py-2 text-sm text-rose-600 transition-colors hover:bg-rose-100"
        >
          🔍 一键拆解
        </button>
        <button
          type="button"
          onClick={() => onAction('script')}
          className="flex-1 rounded-lg bg-pink-50 py-2 text-sm text-pink-600 transition-colors hover:bg-pink-100"
        >
          ✍️ 写同类脚本
        </button>
      </div>
    </div>
  );
}

export default function VideoImportPage() {
  const router = useRouter();
  const [shareUrl, setShareUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [history, setHistory] = useState<ImportHistoryItem[]>([]);
  const [video, setVideo] = useState<ParsedVideo | null>(null);
  const [activeRecord, setActiveRecord] = useState<ImportHistoryItem | null>(
    null,
  );
  const [activeAwemeId, setActiveAwemeId] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState('');

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/v1/videos/import?limit=30');
      const data = await res.json();
      if (!res.ok || !Array.isArray(data)) {
        return [];
      }
      setHistory(data as ImportHistoryItem[]);
      return data as ImportHistoryItem[];
    } catch {
      return [];
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const selectVideo = useCallback((row: ImportHistoryItem) => {
    const parsed = importedVideoToParsed(row);
    setVideo(parsed);
    setActiveRecord(row);
    setActiveAwemeId(row.aweme_id);
    persistActiveAwemeId(row.aweme_id);
  }, []);

  const startTranscribe = useCallback(
    async (awemeId: string, options?: { silent?: boolean }) => {
      setTranscribing(true);
      if (!options?.silent) setError('');
      try {
        const res = await fetch(`/api/v1/videos/${awemeId}/transcribe`, {
          method: 'POST',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '口播转写失败');

        const list = await loadHistory();
        const updated = list.find((r) => r.aweme_id === awemeId);
        if (updated) selectVideo(updated);
      } catch (e: unknown) {
        if (!options?.silent) {
          setError(e instanceof Error ? e.message : '口播转写失败');
        }
      } finally {
        setTranscribing(false);
      }
    },
    [loadHistory, selectVideo],
  );

  useEffect(() => {
    void (async () => {
      const list = await loadHistory();
      const savedId = readActiveAwemeId();
      const target =
        (savedId && list.find((r) => r.aweme_id === savedId)) || list[0];
      if (target) {
        selectVideo(target);
      }
    })();
  }, [loadHistory, selectVideo]);

  async function handleParse() {
    if (!shareUrl.trim()) {
      setError('请粘贴抖音视频分享链接');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/v1/videos/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_url: shareUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '解析失败');

      if (data.video) {
        const row = data.video as ImportHistoryItem;
        setHistory((prev) => {
          const rest = prev.filter((r) => r.aweme_id !== row.aweme_id);
          return [row, ...rest];
        });
        selectVideo(row);
        void startTranscribe(row.aweme_id, { silent: true });
      } else if (data.parsed) {
        setVideo(data.parsed as ParsedVideo);
        setActiveAwemeId(data.parsed.aweme_id);
        persistActiveAwemeId(data.parsed.aweme_id);
        void loadHistory();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '解析失败，请检查链接是否正确';
      setError(msg === 'fetch failed' ? '网络请求失败，请稍后重试' : msg);
    } finally {
      setLoading(false);
    }
  }

  function goToChat(action: 'analyze' | 'script') {
    if (!video) return;
    persistActiveAwemeId(video.aweme_id);
    const params = new URLSearchParams({
      action,
      aweme_id: video.aweme_id,
    });
    router.push(`/chat?${params.toString()}`);
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/chat"
          className="text-sm text-gray-500 hover:text-gray-800"
        >
          ← 返回对话
        </Link>
        <div>
          <h1 className="text-xl font-bold text-gray-900">📥 视频快速导入</h1>
          <p className="text-sm text-gray-500">
            解析后自动生成口播稿；从聊天返回后可在左侧历史继续操作
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
          <h2 className="mb-2 px-1 text-sm font-semibold text-gray-800">
            导入历史
          </h2>
          {historyLoading ? (
            <p className="px-1 text-xs text-gray-400">加载中...</p>
          ) : history.length === 0 ? (
            <p className="px-1 text-xs text-gray-400">暂无记录，解析后会出现在这里</p>
          ) : (
            <ul className="space-y-1">
              {history.map((item) => {
                const ts = flattenTranscriptFields(item);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => selectVideo(item)}
                      className={cn(
                        'w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-gray-50',
                        activeAwemeId === item.aweme_id &&
                          'bg-rose-50 ring-1 ring-rose-200',
                      )}
                    >
                      <p className="line-clamp-2 text-xs font-medium text-gray-900">
                        {item.video_desc?.trim() || '（无标题）'}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-gray-500">
                        @{item.author_nickname || '未知'}
                      </p>
                      <div className="mt-0.5 flex items-center justify-between gap-1">
                        <p className="text-[11px] text-gray-400">
                          {formatDistanceToNow(new Date(item.created_at), {
                            addSuffix: true,
                            locale: zhCN,
                          })}
                        </p>
                        {ts.transcript_status === 'done' && (
                          <span className="text-[10px] text-green-600">稿</span>
                        )}
                        {ts.transcript_status === 'processing' && (
                          <span className="text-[10px] text-amber-600">转写中</span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div>
          <div className="space-y-3">
            <textarea
              value={shareUrl}
              onChange={(e) => setShareUrl(e.target.value)}
              placeholder="例如：3.38 复制打开抖音，看看【谈大头的作品】... https://v.douyin.com/qrqGY1WpteI/"
              className="h-24 w-full resize-none rounded-lg border border-gray-200 p-3 text-sm transition-colors focus:border-rose-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleParse}
              disabled={loading || !shareUrl.trim()}
              className="w-full rounded-lg bg-rose-500 py-2.5 font-medium text-white transition-colors hover:bg-rose-600 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {loading ? '解析中...' : '解析视频'}
            </button>
            {error && <p className="text-sm text-red-500">{error}</p>}
          </div>

          {video ? (
            <div className="mt-6 space-y-4">
              <TranscriptCard
                row={activeRecord}
                transcribing={transcribing}
                onTranscribe={() =>
                  activeAwemeId && void startTranscribe(activeAwemeId)
                }
              />
              <VideoCard video={video} onAction={goToChat} />
            </div>
          ) : (
            !historyLoading &&
            history.length === 0 && (
              <p className="mt-8 text-center text-sm text-gray-400">
                粘贴链接并解析后，可在此查看视频详情
              </p>
            )
          )}
        </div>
      </div>
    </div>
  );
}
