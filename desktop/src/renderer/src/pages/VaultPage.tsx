import { memo, useCallback, useEffect, useRef, useState, type MutableRefObject, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { wikiLinkPlugin } from 'remark-wiki-link'
import ForceGraph2D from 'react-force-graph-2d'
import { FastMarkdown, assetUrl } from '../components/Markdown'
import { VaultWizard } from '../components/VaultWizard'
import { ConflictBar } from '../components/ConflictBar'
import { ui } from '../components/ui'
import { X, Inbox, MoveUpLeft, MoreHorizontal, Loader2, FileWarning, RotateCcw } from 'lucide-react'
import { pendingNote, inboxPanel } from '../lib/bus'
import { GRAPH_KIND_TOKEN, GRAPH_LEGEND, token, tokenPx } from '../theme'
import { EMPTY_MARK, fmLabel, formatFrontmatterValue, formatNoteBody, splitFrontmatter } from '../lib/note-format'
import { STAGE_LABEL } from '../config/stages'
import { errText } from '../lib/err'
import { enqueueMessage, pathOfDropped } from '../lib/enqueue'
import { useTask } from '../hooks/useTasks'
import { useDragOver } from '../hooks/useDragOver'

/** 节点取色：角色 → token（角色由主进程算，见 vault/graph.ts 的 kindOf） */
const colorOf = (kind: string): string => token(GRAPH_KIND_TOKEN[kind] ?? GRAPH_KIND_TOKEN.doc)

/**
 * 边线透明度随缩放联动：k≤0.5（缩得很远）→ 0.55，k≥1.6（放大看细节）→ 1.0，中间线性。
 * **下限是调出来的**：第一版给 0.35，叠上已经调淡的线色之后整张图的边几乎看不见，
 * 团块之间怎么连的读不出来——毛毡感是消了，结构也一起没了。0.55 是"能看出结构、
 * 又不糊成一层"的那一档（563 节点 / 1973 边的 Maggie 库上目测定的）。
 * 十六进制 token 转 rgba 在这里做，theme.css 里只放一支颜色（别为透明度再开一堆 token）。
 */
const fadeLink = (hex: string, k: number): string => {
  const a = Math.max(0.55, Math.min(1, 0.55 + ((k - 0.5) / 1.1) * 0.45))
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a.toFixed(2)})`
}

/** 链接里的 %20 之类还原成可读文案；坏的百分号编码会抛，原样显示即可 */
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 超过该长度改走 marked 快速渲染（remark 管线解析大表会卡界面 2-4 秒；marked 快一个数量级） */
const RENDER_CAP = 60_000

/** 栏宽记忆：默认值与上下限都在 theme.css，这里只负责读写 localStorage */
const readWidth = (key: string, defToken: string, def: number): number => {
  const saved = Number(localStorage.getItem(key))
  return Number.isFinite(saved) && saved > 0 ? saved : tokenPx(defToken, def)
}

/**
 * 三栏之间的可拖拽分隔线。拖动时实时改宽度，松手写进 localStorage（下次开库沿用）。
 * invert = 被调整的栏在分隔线右侧（关系图），此时往左拖才是变宽。
 */
function Divider({
  testId,
  value,
  min,
  max,
  invert,
  onChange,
  onCommit,
}: {
  testId: string
  value: number
  min: number
  max: number
  invert?: boolean
  onChange: (w: number) => void
  onCommit: (w: number) => void
}) {
  const start = useRef({ x: 0, w: 0 })
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    start.current = { x: e.clientX, w: value }
    let latest = value
    const move = (ev: MouseEvent): void => {
      const dx = (ev.clientX - start.current.x) * (invert ? -1 : 1)
      latest = Math.min(max, Math.max(min, start.current.w + dx))
      onChange(latest)
    }
    const up = (): void => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      // 拖动过程中全局锁光标 + 禁选中，否则划过正文会把文字选成一片蓝
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onCommit(latest)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }
  return (
    <div
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      title="拖动调整宽度"
      onMouseDown={onMouseDown}
      className="group relative z-10 w-divider shrink-0 cursor-col-resize"
    >
      {/* 命中区 5px，画出来只有 1px：静态就是原来那条分栏线，hover 才透出可拖的暗示 */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors group-hover:bg-divider-hover" />
    </div>
  )
}

export default function VaultPage() {
  const [vault, setVault] = useState<VaultOpenResult | null>(null)
  const [loading, setLoading] = useState(true)
  // 换库：以前直接 setVault(null)，在 Finder 选择框点取消就永久停在向导页、回不到原来的库。
  // 现在原库留在 state 里（主进程的 currentRoot 本来也没变），向导给一个「返回当前库」的出口
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    window.api.vault.openStored().then((v) => {
      setVault(v)
      setLoading(false)
    })
  }, [])

  if (loading)
    return <div className="flex h-full items-center justify-center text-md text-muted">正在索引你的库…</div>
  if (!vault || switching)
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <VaultWizard
          onReady={(v) => {
            setVault(v)
            setSwitching(false)
          }}
          onSkip={switching ? () => setSwitching(false) : undefined}
          skipLabel="返回当前库"
        />
      </div>
    )
  return <Explorer vault={vault} onSwitch={() => setSwitching(true)} />
}

/**
 * 阶段名的用户词现在只有**一份**，在 `config/stages.ts`（U3 #6）。
 * 这里原来自己抄了一份 `STAGE_ZH`，与 `tasks/types.ts` 的 `INBOX_FLOW` 各写各的——
 * 同一个阶段在 Dock 和面板里叫同一个名字纯属它们碰巧一致，改一处必漏另一处。
 */
const STAGE_ZH = STAGE_LABEL

/**
 * 投递箱状态**不再由本页面持有**——它挂在 App 层的任务状态层里，切页面不会丢（H-07/H-08）。
 * 这里只做两件事：把任务投影成面板需要的形状，以及在"活跃→终态"这个边沿上触发回调。
 */
function useInbox(onDone?: (files: string[]) => void, onEnd?: (ok: boolean) => void) {
  const task = useTask('inbox')
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onEndRef = useRef(onEnd)
  onEndRef.current = onEnd

  const status = task?.status
  const prevStatus = useRef<TaskStatus | undefined>(undefined)
  useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = status
    if (!status || !was) return // 首次观察到（含重启后 seed 进来的终态）不触发
    const wasLive = was === 'queued' || was === 'running'
    const nowDone = status === 'succeeded' || status === 'failed' || status === 'canceled'
    if (!wasLive || !nowDone) return
    if (status === 'succeeded' && task?.files.length) onDoneRef.current?.(task.files)
    onEndRef.current?.(status === 'succeeded')
  }, [status, task])

  return { task, running: status === 'running' || status === 'queued' }
}

/** 阶段进度（done/total/label）由主进程算好放在 task.progress 里，这里只负责画 */
/**
 * 库变更 → 重建视图的防抖窗口（2026-08-19）。
 * 图谱那 3 秒是照投递箱的 3 秒去抖窗口取的，两边节奏对齐；文件树便宜，1 秒够。
 */
const GRAPH_REFRESH_DEBOUNCE_MS = 3000
const TREE_REFRESH_DEBOUNCE_MS = 1000
/** 少于这个数就不打扰用户——几篇的补齐在下次入库时顺手就完了，不值得弹窗 */
const STALE_TAG_PROMPT_MIN = 20

function InboxPanel({ task, running, onClose }: { task?: InboxTask; running: boolean; onClose: () => void }) {
  const dot = (s?: string): string =>
    s === 'ok' ? 'bg-ok' : s === 'error' ? 'bg-danger' : s === 'warn' ? 'bg-warning' : 'bg-line'
  const events = task?.stages ?? []
  // A-4：pipeline 把没产出笔记的文件名放在 convert_failures 事件里，这里摊平成一张清单。
  // 只给数字没法处理——用户要知道是哪几个文件才能决定补什么
  /**
   * 每条**带上原因**（0.1.2）。原来只摊平出文件名，用户看到一串光秃秃的路径
   * 仍然不知道为什么没进来——尤其那三份扫描 PDF，文件打开好好的，
   * 界面只说"没有生成笔记"，方向完全指错。
   * `reasons` 是 pipeline 在 `convert_failures` 事件里给的（转换失败那批）；
   * 格式不支持那批原因就是扩展名本身，在这儿拼。
   */
  const failures = events.flatMap((e) => {
    if (e.stage !== 'convert_failures') return []
    const ev = e as { failed?: string[]; unsupported?: string[]; reasons?: Record<string, string> }
    const why = ev.reasons ?? {}
    return [
      ...(ev.failed ?? []).map((rel) => ({ rel, reason: why[rel] || '转换没有产出内容' })),
      ...(ev.unsupported ?? []).map((rel) => ({
        rel,
        reason: `暂不支持 ${rel.slice(rel.lastIndexOf('.')) || '这种'} 格式`,
      })),
    ]
  })
  /**
   * **连续的同一阶段折成一行，并把 message 显示出来**（2026-08-18 真人测试反馈）。
   *
   * 用户报「右下角出现多次上云进度」。查实是**呈现问题不是真重复**：一次整包拖入
   * 只跑一轮 pipeline、只调一次 `cloudSync`（96 个文件实测 1 轮 1 次 1 条任务）。
   * 但 `cloudSync` 是分批推的，每批发一条 `stage: cloud_sync` 事件带
   * 「上云中 20/61 篇…」，而这里**只画 `STAGE_ZH[stage]`、把 message 丢了** ——
   * 于是屏幕上是四行一模一样的「上云」，看着就像同步了四遍。
   */
  const rows = events.reduce<InboxEvent[]>((acc, ev) => {
    const prev = acc[acc.length - 1]
    if (prev && prev.type === 'stage' && ev.type === 'stage' && prev.stage === ev.stage) {
      acc[acc.length - 1] = ev // 同阶段的后续事件就地更新，不再往下堆
      return acc
    }
    acc.push(ev)
    return acc
  }, [])
  const { done, total, label } = task?.progress ?? { done: 0, total: 6, label: '' }
  // 取消是用户主动的操作，不该看起来像出错：中性灰，不是红（设计 §5.1）
  const canceled = task?.status === 'canceled'
  const failed = !canceled && !!task?.error
  const pct = running || done > 0 ? Math.round((done / total) * 100) : 0
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!running) setStopping(false)
  }, [running])
  // 日志区跟着最新一条走：不然跑到一半新阶段全在折叠线以下，看着像卡住不动
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [events])
  return (
    <div
      data-testid="inbox-panel"
      className="slide-in-right absolute bottom-4 right-4 z-20 w-80 rounded-xl border border-line bg-card shadow-pop"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="text-md font-medium">
          投递箱 {running && <span className="text-xs text-accent">处理中…</span>}
          {canceled && <span className="text-xs text-muted">已停止</span>}
        </div>
        <div className="flex gap-2 text-sm">
          {running ? (
            // H-13：以前只有「立即处理」和「✕ 关闭」，误拖 200 个文件唯一的办法是退出应用
            <button
              data-testid="inbox-cancel"
              disabled={stopping}
              onClick={async () => {
                setStopping(true)
                await window.api.inbox.cancel()
                ui.toast('已停止本轮投递，已完成的部分保留。点「立即处理」可接着做')
              }}
              className="text-muted hover:text-accent disabled:opacity-60"
            >
              {stopping ? '停止中…' : '停止本轮'}
            </button>
          ) : (
            <button
              data-testid="inbox-run-now"
              onClick={async () => {
                // 空投递箱不再默默跑全库（客户 2026-08-19 提：「明明没有文件又在处理什么」）
                const r = await window.api.inbox.runNow()
                if (r && r.started === false) {
                  ui.toast('投递箱里没有待处理的文件。把文件拖进窗口，或在访达里放进库目录下的 00_投递箱 文件夹', 'info')
                }
              }}
              className="text-muted hover:text-accent"
            >
              立即处理
            </button>
          )}
          <button data-testid="inbox-panel-close" onClick={onClose} className="text-muted hover:text-accent">
            ✕
          </button>
        </div>
      </div>
      {/* 取消后把"发生了什么、东西还在不在"说清楚：不回滚是刻意的，删用户 vault 里的文件
          风险远大于收益（设计 §5.1） */}
      {canceled && (
        <div data-testid="inbox-canceled" className="border-b border-line px-4 py-2 text-sm text-muted">
          {/* 后半句由主进程按投递箱实际剩余文件数拼进 title —— 这里再写死一句会跟它打架
              （客户 2026-08-19 实测：提示说"仍在投递箱里"，点立即处理却说"没有文件"） */}
          {task?.title ?? '已停止'}，点「立即处理」可接着做。
        </div>
      )}
      {/* 阶段进度条：过去只有一串日志行，看不出"还剩几步"，跑长任务时体感像卡死 */}
      {(running || done > 0) && (
        <div className="border-b border-line px-4 py-2.5">
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
            <span>{canceled ? '已停止' : failed ? '有阶段失败' : label || '准备中'}</span>
            <span>
              {done}/{total}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className={`inbox-bar-fill h-full rounded-full ${
                canceled ? 'bg-muted-soft' : failed ? 'bg-danger' : 'bg-accent'
              } ${running && !failed ? 'inbox-bar-running' : ''}`}
              style={{ width: `${Math.max(pct, running ? 6 : 0)}%` }}
            />
          </div>
        </div>
      )}
      {failures.length > 0 && (
        <div data-testid="inbox-failures" className="border-b border-line bg-warning-soft px-4 py-2 text-sm">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-medium">{failures.length} 个文件没能进知识库，原件都还在</span>
            {/*
              **常驻入口**：面板会自动收起、应用也会重启，而"哪些文件没进来、为什么"
              是用户过几天还要回头查的东西。盘上的 `.failed/失败原因.txt` 才是持久记录，
              这个按钮只是把人直接带到那句话上。
            */}
            <button
              data-testid="inbox-open-failed"
              onClick={() => {
                void window.api.inbox.openFailed().then((r) => {
                  if (!r.ok) ui.toast(r.error || '打不开失败文件夹', 'error')
                })
              }}
              className="rounded-full border border-line px-2 py-0.5 text-xs hover:bg-card"
            >
              查看原件与原因
            </button>
          </div>
          <ul className="ml-4 list-disc text-muted">
            {failures.map((f) => (
              <li key={f.rel} className="truncate" title={`${f.rel} —— ${f.reason}`}>
                {f.rel}
                <span className="text-2xs"> —— {f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div ref={logRef} className="max-h-64 overflow-auto px-4 py-2">
        {rows.length === 0 ? (
          <div className="py-3 text-sm text-muted">
            把文件拖进窗口，或在 Finder 里丢进投递箱目录，自动转换/打标/建链
          </div>
        ) : (
          rows.map((ev, i) => (
            <div key={i} className="fade-up flex items-center gap-2 py-1 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${ev.type === 'file-added' ? 'bg-accent' : dot(ev.status)}`} />
              {ev.type === 'file-added' ? (
                <span className="truncate">收到 {ev.file}</span>
              ) : (
                <span className="truncate">
                  {ev.stage?.startsWith('route_')
                    ? `外部资料转换 · ${ev.stage.slice(6)}`
                    : (STAGE_ZH[ev.stage ?? ''] ?? ev.stage)}
                  {/* 带进度的阶段（上云分批）要把数字说出来，否则连着几行都是光秃秃的「上云」 */}
                  {ev.status === 'ok' && ev.message && (
                    <span className="text-muted"> · {ev.message}</span>
                  )}
                  {ev.status === 'skipped' && (
                    <span className="text-muted">
                      （{ev.stage === 'convert' ? '本批已在分流完成' : (ev.message ?? '跳过')}）
                    </span>
                  )}
                  {ev.status === 'error' && <span className="text-danger"> 失败：{ev.message}</span>}
                  {/* A-4：转换失败与格式不支持过去只写进 convert_fail.log，界面六阶段全绿、
                      原件照样进 .done，用户看投递箱空了就以为全入库了 */}
                  {ev.status === 'warn' && <span className="text-warning"> {ev.message}</span>}
                  {ev.stage === 'init' && ev.pending != null && <span className="text-muted"> · {ev.pending} 个文件</span>}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

const countNotes = (nodes: VaultTreeNode[]): number =>
  nodes.reduce((n, x) => n + (x.children ? countNotes(x.children) : 1), 0)

/** 空库引导：替代"什么都没有"的中间区域，把用户指向投递箱入口 */
function EmptyVaultGuide({ onOpenInbox }: { onOpenInbox: () => void }) {
  return (
    <div className="fade-up relative flex flex-1 flex-col items-center justify-center px-8">
      {/* 指向左上角「投递箱」入口的视觉引导 */}
      <div className="absolute left-6 top-4 flex items-center gap-1.5 text-xs text-accent">
        <MoveUpLeft size={14} />
        左上角「投递箱」可随时看处理进度
      </div>
      <div className="flex w-full max-w-md flex-col items-center rounded-xl border border-dashed border-accent-line bg-surface px-8 py-10 text-center">
        <Inbox size={28} className="mb-3 text-accent" />
        <div className="text-xl font-medium">拖入你的第一份资料试试</div>
        <div className="mt-2 text-md leading-base text-muted">
          把 Word / PPT / Excel / PDF 直接拖进这个窗口，投递箱会自动转成笔记、打标建链，
          之后就能被 AI 检索到。
        </div>
        <button
          onClick={onOpenInbox}
          className="mt-5 flex items-center gap-1.5 rounded-full border border-line bg-card px-4 py-1.5 text-base hover:bg-hover"
        >
          <Inbox size={14} /> 打开投递箱
        </button>
      </div>
      {/**
       * 「新建靠右键」得说一句（2026-08-19）。
       *
       * 工具栏那颗「新建」已撤（它建在哪是隐形规则，用户看不出来），新建统一走右键。
       * 对熟悉 Finder 的人这是常识，**但客户不一定是**——不告诉他，
       * 他会以为这个软件只能"拖进来"、自己写不了东西。
       * 放在空库这一屏：正是第一次面对空文件树、最可能想"我自己建一篇"的时刻。
       */}
      <div data-testid="empty-hint-newnote" className="mt-4 text-sm text-muted">
        想自己写一篇？<span className="text-ink">右键左侧文件树的空白处</span> → 新建笔记 / 新建文件夹
      </div>
    </div>
  )
}

function Explorer({ vault, onSwitch }: { vault: VaultOpenResult; onSwitch: () => void }) {
  const [tree, setTree] = useState<VaultTreeNode[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const currentRef = useRef<string | null>(null)
  const [note, setNote] = useState<NoteContent | null>(null)
  // M-02：读失败以前是 `.catch(() => setNote(null))`，而正文区的渲染条件是 `current && note`，
  // 于是"读失败 = 什么都不出现"，用户只会反复点同一条
  const [noteErr, setNoteErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // 搜索三态（H-11）：null=还没有结果（未搜索/检索中），有值才是"这就是全部结果"
  const [result, setResult] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  /** 丢弃迟到的检索响应：输入框改得快时，前一次的结果回来会盖掉后一次 */
  const searchSeq = useRef(0)
  const [showGraph, setShowGraph] = useState(() => localStorage.getItem('vault.showGraph') !== '0')
  // 三栏宽度：拖过就记住（默认值/上下限见 theme.css 的 --size-tree* / --size-graph-panel*）
  const [treeW, setTreeW] = useState(() => readWidth('vault.treeWidth', '--size-tree', 220))
  const [graphW, setGraphW] = useState(() => readWidth('vault.graphWidth', '--size-graph-panel', 360))
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleDir = useCallback((p: string) => {
    setExpanded((old) => {
      const next = new Set(old)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }, [])
  const { task: inboxTask, running: inboxRunning } = useInbox(async (files) => {
    // 入库完成：自动打开第一个新笔记，并在左侧树中展开定位
    const base = files[0]?.replace(/\.[^.]+$/, '')
    if (!base) return
    let resolved = await window.api.vault.resolveLink(base)
    if (!resolved) {
      await new Promise((r) => setTimeout(r, 1000))
      resolved = await window.api.vault.resolveLink(base)
    }
    if (resolved) openNote(resolved, true)
  }, (ok) => {
    if (ok) {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = setTimeout(() => setShowInbox(false), 4000)
    }
  })
  const [showInbox, setShowInbox] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hotZone, setHotZone] = useState<string | null>(null)
  // 进出计数判定，别用 `currentTarget === target`（拖出窗口时覆盖层消不掉，见 useDragOver）
  const drag = useDragOver(() => setHotZone(null))

  // 从 Finder 直接丢进投递箱目录时没人开过面板，跑完那一刻面板会"啪"地消失、
  // 用户根本看不到结果。开跑就把面板钉住，结束后由上面的 4 秒计时器收起
  useEffect(() => {
    if (inboxRunning) setShowInbox(true)
  }, [inboxRunning])

  /**
   * Dock 唤回：浮窗被 ✕ 掉之后，Dock 那条迷你指示是唯一还能回到这个任务的入口。
   * 订阅（本页已挂载）＋ 挂载时 consume（从别的页面点过来）两条路都要接，
   * 只接前者的话「请求发生在订阅之前」那一路会丢。
   */
  useEffect(() => {
    if (inboxPanel.consume()) setShowInbox(true)
    return inboxPanel.subscribe(() => {
      inboxPanel.consume()
      setShowInbox(true)
    })
  }, [])

  const setGraphVisible = (v: boolean): void => {
    localStorage.setItem('vault.showGraph', v ? '1' : '0')
    setShowGraph(v)
  }

  const [treeLoaded, setTreeLoaded] = useState(false)
  const refreshTree = useCallback(() => {
    window.api.vault.tree().then((t) => {
      setTree(t)
      setTreeLoaded(true)
    })
  }, [])
  // 空库：一篇笔记都没有时中间区域给引导，而不是一片空白的图谱。
  // 用树里的叶子（= 笔记，原件不进树）计数，入库成功后 watcher 刷新树，引导自动消失
  const vaultEmpty = treeLoaded && countNotes(tree) === 0 && !current

  /**
   * 读一篇笔记（M-02）。失败时不再一声不吭：正文区渲染错误态（带重试），
   * 用户点出来的那次还额外给一条 toast——watcher 触发的重读不 toast，
   * 投递箱跑批期间文件被反复重写，那会变成一串没人看得懂的报错
   */
  const readNote = useCallback((path: string, silent = false) => {
    window.api.vault
      .read(path)
      .then((n) => {
        setNote(n)
        setNoteErr(null)
      })
      .catch((e) => {
        setNote(null)
        setNoteErr(errText(e))
        if (!silent) ui.toast(`打不开这篇笔记：${errText(e)}`, 'error')
      })
  }, [])

  useEffect(() => {
    if (pendingNote.path) {
      openNote(pendingNote.path, true)
      pendingNote.path = null
    }
    refreshTree()
    /**
     * 树刷新也要防抖（同图谱那条的原因，只是它便宜些）：批量入库时几十次变更
     * 会让文件树连着重建几十遍，肉眼看到的是整棵树在闪。
     * **正在编辑的那篇笔记的重读不防抖**——那是用户在等的东西，慢一秒都不该。
     */
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.api.vault.onChanged(({ path }) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        refreshTree()
      }, TREE_REFRESH_DEBOUNCE_MS)
      setCurrent((cur) => {
        if (cur === path) readNote(path, true)
        return cur
      })
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [refreshTree, readNote])

  // 编辑态的「有未保存改动」提到这一层：NoteView 是 key={current} 挂载的，
  // 换一篇笔记它整个销毁，局部 dirty 跟着没了 —— 改动就这么静默丢掉
  const dirtyRef = useRef(false)
  const onDirty = useCallback((d: boolean) => {
    dirtyRef.current = d
  }, [])
  /** 任何会让当前编辑态消失的动作（换笔记/关笔记/换库）之前都先过这一关 */
  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true
    const ok = await ui.confirm({
      title: '放弃未保存的修改？',
      message: '当前笔记正在编辑且有未保存的改动，继续将丢失这些修改。',
      danger: true,
      okText: '放弃修改',
    })
    if (ok) dirtyRef.current = false
    return ok
  }, [])

  const openNoteRaw = useCallback((path: string, reveal = false) => {
    setCurrent(path)
    currentRef.current = path
    setNoteErr(null)
    setResult(null)
    setQuery('')
    if (reveal) {
      const parts = path.split('/')
      setExpanded((old) => {
        const next = new Set(old)
        let acc = ''
        for (const p of parts.slice(0, -1)) {
          acc = acc ? acc + '/' + p : p
          next.add(acc)
        }
        return next
      })
    }
    readNote(path)
  }, [readNote])

  const openNote = useCallback(
    async (path: string, reveal = false) => {
      if (!(await confirmDiscard())) return
      openNoteRaw(path, reveal)
    },
    [confirmDiscard, openNoteRaw]
  )

  const closeNote = useCallback(async () => {
    if (!(await confirmDiscard())) return
    dirtyRef.current = false
    setCurrent(null)
    currentRef.current = null
    setNote(null)
    setNoteErr(null)
  }, [confirmDiscard])

  /** 换库：先问未保存的改动，再确认这次切换本身（H-02 的确认在这里） */
  const switchVault = useCallback(async () => {
    if (!(await confirmDiscard())) return
    const ok = await ui.confirm({
      title: '切换到另一个知识库？',
      // U3 #5：**不摆绝对路径**。`/Users/xxx/Documents/AI/maggie-vault` 里既有用户名
      // 也有我们的目录结构，对"我要不要切"这个决定一点帮助都没有。只留文件夹名，
      // 真要看全路径的人有「在访达中显示」
      message: `当前知识库：${vault.path.split('/').filter(Boolean).pop() ?? vault.path}\n\n会回到建库/选库引导，在那里点「返回当前库」可以随时回来。`,
      okText: '去换库',
    })
    if (ok) onSwitch()
  }, [confirmDiscard, onSwitch, vault.path])

  /**
   * 新建文件夹（2026-08-19 客户提出）。落点跟「新建笔记」同一套：
   * 当前打开的笔记在哪个目录就建在哪儿，没开笔记就建在库根。
   * 主进程会顺手在新目录里放一篇同名笔记——**空目录在文件树里看不见**（树按笔记聚），
   * 不放的话用户点完"成功"却什么都没出现。
   */
  /**
   * 右键菜单（B5）。**菜单项两套**：右键目录能新建，右键笔记只能改这一篇。
   * 落点由"你右键的是谁"决定——这正是工具栏那个按钮做不到的事。
   */
  const [ctxMenu, setCtxMenu] = useState<{
    at: { x: number; y: number }
    items: Array<{ label: string; danger?: boolean; onClick: () => void }>
  } | null>(null)

  const onTreeContext = useCallback(
    (e: React.MouseEvent, path: string, isDir: boolean) => {
      e.preventDefault()
      e.stopPropagation()
      const at = { x: e.clientX, y: e.clientY }
      /**
       * 菜单项就写动词，**不要「在「XXX」下新建…」**（2026-08-19 真人指出："太奇怪了"）。
       * Finder / VS Code 都是直接「新建文件夹」——你右键的是谁，落点就在谁身上，
       * 再把路径写进标签是啰嗦；而且建完树上立刻能看见它落在哪，反馈本来就是即时的。
       */
      const items: Array<{ label: string; danger?: boolean; onClick: () => void }> = isDir
        ? [
            { label: '新建笔记', onClick: () => void createNoteIn(path) },
            { label: '新建文件夹', onClick: () => void createFolderIn(path) },
            ...(path ? [{ label: '在访达中显示', onClick: () => void window.api.vault.reveal(path) }] : []),
          ]
        : [
            { label: '打开', onClick: () => openNote(path) },
            { label: '重命名…', onClick: () => void renameAt(path) },
            { label: '在访达中显示', onClick: () => void window.api.vault.reveal(path) },
            { label: '删除', danger: true, onClick: () => void deleteAt(path) },
          ]
      setCtxMenu({ at, items })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openNote]
  )

  /** 在指定目录下新建笔记/文件夹——落点明确，不再"猜当前目录" */
  const createNoteIn = async (dir: string): Promise<void> => {
    const name = await ui.prompt({ title: '新建笔记', placeholder: '笔记名称' })
    if (!name) return
    try {
      openNote(await window.api.vault.createNote(dir, name))
    } catch (e) {
      ui.toast(`新建笔记失败：${errText(e)}`, 'error')
    }
  }
  const createFolderIn = async (dir: string): Promise<void> => {
    const name = await ui.prompt({ title: '新建文件夹', placeholder: '文件夹名称' })
    if (!name) return
    try {
      const rel = await window.api.vault.createFolder(dir, name)
      ui.toast(`已创建：${rel}`, 'ok')
    } catch (e) {
      ui.toast(`新建文件夹失败：${errText(e)}`, 'error')
    }
  }
  const renameAt = async (rel: string): Promise<void> => {
    const cur = (rel.split('/').pop() ?? '').replace(/\.md$/, '')
    const name = await ui.prompt({ title: '重命名', placeholder: '新名称', initial: cur })
    if (!name || name === cur) return
    try {
      const next = await window.api.vault.renameNote(rel, name)
      ui.toast('已重命名', 'ok')
      openNote(next)
    } catch (e) {
      ui.toast(`重命名失败：${errText(e)}`, 'error')
    }
  }
  const deleteAt = async (rel: string): Promise<void> => {
    const okd = await ui.confirm({
      title: '确认删除这篇笔记？',
      message: `${rel}\n\n将移入系统废纸篓，可随时找回。`,
      danger: true,
    })
    if (!okd) return
    try {
      await window.api.vault.deleteNote(rel)
      ui.toast('已删除，可在废纸篓找回', 'ok')
    } catch (e) {
      ui.toast(`删除失败：${errText(e)}`, 'error')
    }
  }

  /**
   * 旧标签升级的提示（B3b，2026-08-19）。
   *
   * **文案刻意软化**：说的是"升级后检索更准"，不是"你的库有问题"。
   * 这些笔记本来就是好的，只是标签是旧版打标器产出的、少了实体字段——
   * 让用户觉得自己的库"坏了"是最糟的表达。
   *
   * 只在**有库、且待升级数量值得打扰**时提示；用户选"以后再说"就本次运行不再问。
   */
  /** 资料库目录名：拖放分区要显示"文件会落到哪"，原来这行文案写死 `80_Library` */
  const [libraryName, setLibraryName] = useState('资料库')
  useEffect(() => {
    void window.api.settings.get().then((x) => setLibraryName(x.libraryName || '资料库'))
  }, [vault.path])

  const [staleAsked, setStaleAsked] = useState(false)
  useEffect(() => {
    if (!vault.path || staleAsked || inboxRunning) return
    let alive = true
    void window.api.inbox.staleTags().then(async (n) => {
      if (!alive || n < STALE_TAG_PROMPT_MIN) return
      setStaleAsked(true)
      const mins = Math.max(1, Math.round((n * 4) / 60)) // 实测每篇约 4 秒
      const go = await ui.confirm({
        title: '知识库可以升级一下',
        message:
          `有 ${n} 篇笔记的标签是旧版本生成的，升级后检索更准（约 ${mins} 分钟），随时可暂停。\n\n` +
          '升级期间可以照常使用，不影响新文件入库。',
        okText: '现在升级',
        cancelText: '以后再说',
      })
      if (!go) return
      /**
       * **结果必须接住**（0.1.2）。原来是 `void window.api.inbox.tagBackfill()`——
       * 主进程里三行裸 return 里的任何一条命中，界面上都毫无变化，
       * 真实客户点了「现在升级」以为软件坏了。
       * 现在没开成就把原因直接说出来（没库 / 投递箱忙 / 没密钥 / 本来就没有待升级的）。
       */
      const r = await window.api.inbox.tagBackfill()
      if (!r.ok) return ui.toast(r.message, r.reason === 'nothing' ? 'info' : 'error')
      // 这条 Promise 在子进程结束时才 resolve，所以到这儿就是**跑完了**
      if (r.failed) ui.toast(`标签升级失败：${r.failed}`, 'error')
      else if (r.canceled) ui.toast('标签升级已停止，已完成的部分保留', 'info')
      else ui.toast(`标签升级完成，共 ${r.done ?? 0} 篇`, 'ok')
    })
    return () => {
      alive = false
    }
  }, [vault.path, staleAsked, inboxRunning])

  const deleteNote = async (): Promise<void> => {
    if (!current) return
    // 二次确认里带上文件名与所在目录，避免删错文件
    const okd = await ui.confirm({
      title: '确认删除这篇笔记？',
      message: `${current}\n\n将移入系统废纸篓，可随时找回。`,
      danger: true,
      okText: '删除',
    })
    if (!okd) return
    await window.api.vault.deleteNote(current)
    ui.toast(`已删除「${note?.title ?? current}」，可在废纸篓找回`)
    dirtyRef.current = false // 文件都删了，别再问"放弃未保存的修改"
    void closeNote()
  }

  /**
   * H-11 搜索三态。以前是 `hits.length > 0 ? 结果 : <Tree/>`，把「没找到」和「没搜索」
   * 画成了同一个状态——搜一个库里没有的词，左栏显示的是整棵树，和没搜一样，
   * 用户只会以为搜索框坏了。现在按 query 分：未搜索→树／检索中→加载态／有词无结果→「没找到」
   */
  useEffect(() => {
    const q = query.trim()
    const my = ++searchSeq.current
    if (!q) {
      setResult(null)
      setSearching(false)
      return
    }
    // 防抖那 200ms 加上 worker 排队（大库重建索引时可达数秒）都算"检索中"，
    // 这段时间必须先把树换下去，否则用户以为输入没生效
    setSearching(true)
    const t = setTimeout(() => {
      window.api.vault
        .search(q)
        .then((r) => {
          if (my !== searchSeq.current) return
          setResult(r)
          setSearching(false)
        })
        .catch((e) => {
          if (my !== searchSeq.current) return
          setResult({ hits: [], total: 0 })
          setSearching(false)
          ui.toast(`检索失败：${errText(e)}`, 'error')
        })
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  const [routes, setRoutes] = useState<Array<{ name: string; dest: string }>>([])
  useEffect(() => {
    void window.api.routes.get().then(setRoutes)
  }, [])

  // dataTransfer 可能是 null（合成事件、或某些平台的异常 drop）——
  // 直接展开会抛 TypeError 冒到 window.onerror，用户看不到但日志里全是它
  /**
   * **取路径必须走 preload 的 `files.pathFor`**（内部是 `webUtils.getPathForFile`）。
   * `File.path` 在 Electron 32 被移除，直接读它恒为 undefined —— 2026-08-19 升到 43
   * 之后所有拖放入库当场全废，而且是**静默**全废，客户报的就是"拖进去没反应"。
   */
  const dropPaths = (e: React.DragEvent): string[] =>
    [...(e.dataTransfer?.files ?? [])].map(pathOfDropped).filter((p) => !!p)

  const doEnqueue = async (e: React.DragEvent, subdir?: string): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    drag.reset()
    const dropped = [...(e.dataTransfer?.files ?? [])]
    const paths = dropPaths(e)
    /**
     * **拿不到路径必须说话**。原来这里是 `if (!paths.length) return` —— 静默返回，
     * 于是"取路径的 API 被 Electron 删了"这种要命的故障，在界面上和"用户拖了个空东西"
     * 长得一模一样：什么都不发生。真出问题时没人查得到。
     */
    if (!paths.length) {
      if (dropped.length) {
        ui.toast(`拖入失败：读不到这 ${dropped.length} 个文件的路径。临时办法：在访达里把文件放进知识库目录下的 00_投递箱 文件夹，会自动入库。请把这条报给我们`, 'error')
      }
      return
    }
    setShowInbox(true)
    // A-1：这条路径以前拿到结果就扔了，整包拖进来一个文件都没收也是这个样子
    try {
      const r = await window.api.inbox.enqueue(paths, subdir)
      const m = enqueueMessage(r)
      ui.toast(m.text, m.type)
    } catch (err) {
      ui.toast(`入库失败：${errText(err)}`, 'error')
    }
  }

  return (
    <div
      data-testid="vault-root"
      className="relative flex h-full"
      {...drag.handlers}
      onDrop={(e) => void doEnqueue(e)}
    >
      {drag.over && (
        // 静态时两个投递区一模一样（中性白底灰虚线），只有文件悬在哪个区上方，
        // 哪个区才高亮——之前粉底那块会被当成"已选中"，误导用户
        <div className="absolute inset-0 z-30 flex gap-3 bg-overlay p-6">
          {[{ name: '业务资料', desc: `公司文件 · 智能打标 → ${libraryName}`, subdir: undefined as string | undefined }].concat(
            routes.map((r) => ({ name: r.name, desc: `主题打标 · 概念建链 → ${r.dest}/`, subdir: r.name }))
          ).map((z) => (
            <div
              key={z.name}
              onDragOver={(e) => {
                e.preventDefault()
                setHotZone(z.name)
              }}
              onDragLeave={() => setHotZone((h) => (h === z.name ? null : h))}
              onDrop={(e) => {
                setHotZone(null)
                void doEnqueue(e, z.subdir)
              }}
              className={`flex flex-1 flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors ${
                hotZone === z.name
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line bg-card text-ink'
              }`}
            >
              <div className="text-xl font-semibold">{z.name}</div>
              <div className={`mt-2 text-base ${hotZone === z.name ? '' : 'text-muted'}`}>{z.desc}</div>
            </div>
          ))}
        </div>
      )}
      {/* 可见性只认 `showInbox` 一个源。以前是 `showInbox || inboxRunning`，
          于是跑批期间点 ✕ 关不掉（`inboxRunning` 立刻把它顶回来），
          「关闭」按钮成了摆设。开跑自动展开由上面那个 effect 负责，
          关掉之后想再看，走 Dock 唤回 */}
      {ctxMenu && <TreeContextMenu at={ctxMenu.at} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />}
      {showInbox && (
        <InboxPanel task={inboxTask} running={inboxRunning} onClose={() => setShowInbox(false)} />
      )}
      {/* 分区树（宽度可拖，右侧分隔线兼作分栏线） */}
      <div data-testid="tree-col" style={{ width: treeW }} className="flex shrink-0 flex-col">
        {/* 顶部两行：搜索框独占一行，下一行「篇数居左 · 操作居右」 */}
        <div className="border-b border-line px-3 py-2.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索库…"
            className="h-8 w-full rounded-md border border-line bg-card px-2.5 text-md outline-none focus:border-accent"
          />
          <div className="mt-2.5 flex items-center justify-between gap-2 text-xs text-muted">
            <span className="shrink-0">{countNotes(tree) || vault.noteCount} 篇</span>
            <span className="flex shrink-0 items-center gap-2.5">
              {/* 空库时给投递箱入口加个描边，和中间区域的引导箭头对上 */}
              <button
                data-testid="inbox-toggle"
                onClick={() => setShowInbox((s) => !s)}
                title="投递箱"
                className={
                  inboxRunning
                    ? 'text-accent'
                    : vaultEmpty
                      ? 'rounded-full border border-accent-line px-2 text-accent'
                      : 'hover:text-accent'
                }
              >
                {/* 加图标：原来三个灰色小字挤在一起，客户反馈"根本找不到投递箱在哪" */}
                <Inbox size={12} className="inline -mt-0.5 mr-0.5" />
                投递箱{inboxRunning ? '·忙' : ''}
              </button>
              {/* 「新建」按钮已撤（2026-08-19）：它建在"当前打开那篇笔记所在的目录"，
                  规则是隐形的——用户看不出会建到哪，正是撤掉「新建文件夹」时批评的同一个毛病。
                  新建统一走**右键**：右键目录建在那个目录，右键树的空白处建在库根，
                  所见即所得。工具栏这一行只留"看/切换"类操作。 */}
              {/* 「新建文件夹」按钮已撤（B5）：工具栏按钮说不清"建在哪一级"，
                  改由**右键文件树上的目录**出菜单——你右键谁就建在谁下面 */}
              {!showGraph && !vaultEmpty && (
                <button onClick={() => setGraphVisible(true)} title="打开关系图" className="hover:text-accent">
                  图谱
                </button>
              )}
              <button onClick={() => void switchVault()} title="切换知识库" className="hover:text-accent">
                换库
              </button>
            </span>
          </div>
        </div>
        {/* 空白处右键 → 在库根新建。**没有它右键这条路是残的**：一篇笔记都没有时
            树上没有任何可右键的对象，用户会以为"这个软件建不了东西"。
            节点自己的 onContextMenu 会 stopPropagation，所以只有真空白才走到这里 */}
        <div
          data-testid="tree-blank"
          className="flex-1 overflow-auto p-2"
          onContextMenu={(e) => onTreeContext(e, '', true)}
        >
          {!query.trim() ? (
            <Tree nodes={tree} current={current} onOpen={openNote} depth={0} expanded={expanded} onToggle={toggleDir} onContext={onTreeContext} />
          ) : searching || !result ? (
            <div data-testid="search-loading" className="flex items-center gap-2 px-2 py-3 text-sm text-muted">
              <Loader2 size={13} className="animate-spin" /> 检索中…
            </div>
          ) : result.hits.length === 0 ? (
            <div data-testid="search-empty" className="px-2 py-3">
              <div className="text-base">
                没找到「<span className="text-accent">{query.trim()}</span>」
              </div>
              <div className="mt-1 text-xs text-muted">换个说法，或清空搜索回到文件树</div>
              <button
                data-testid="search-clear"
                onClick={() => setQuery('')}
                className="mt-2.5 rounded-full border border-line px-2.5 py-0.5 text-xs hover:bg-hover"
              >
                清空搜索
              </button>
            </div>
          ) : (
            <>
              {/* M-13：结果静默截断到 20 条，不给总数的话"只有这些"和"还有很多"长得一样 */}
              <div
                data-testid="search-count"
                className="mb-1.5 flex items-center justify-between px-1 text-xs text-muted"
              >
                <span>
                  {/* 精确没找到、退到相近结果时必须说出来：不说的话用户会以为这就是精确命中（B-1） */}
                  {result.fuzzy && <span className="text-accent">相近结果 · </span>}
                  {result.hits.length} / 共 {result.total} 条
                </span>
                <button
                  data-testid="search-clear"
                  onClick={() => setQuery('')}
                  className="shrink-0 hover:text-accent"
                >
                  清空
                </button>
              </div>
              {result.hits.map((h) => (
                <button
                  key={h.path}
                  onClick={() => openNote(h.path)}
                  className="mb-1 w-full rounded-lg bg-card p-2 text-left hover:bg-accent-soft"
                >
                  <div className="text-base font-medium">{h.title}</div>
                  <div className="line-clamp-2 text-xs text-muted">{h.snippet}</div>
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      <Divider
        testId="divider-tree"
        value={treeW}
        min={tokenPx('--size-tree-min', 160)}
        max={tokenPx('--size-tree-max', 420)}
        onChange={setTreeW}
        onCommit={(w) => localStorage.setItem('vault.treeWidth', String(Math.round(w)))}
      />

      {/* 正文（可关闭）；读不出来时占同一块位置给错误态，而不是一片空白 */}
      {current && (note || noteErr) && (
        <div className="min-w-0 flex-1 overflow-hidden">
          {note ? (
            <NoteView
              key={current}
              path={current}
              note={note}
              onOpenLink={openNote}
              onDelete={deleteNote}
              onClose={closeNote}
              onDirty={onDirty}
            />
          ) : (
            <NoteError path={current} error={noteErr!} onRetry={() => readNote(current)} onClose={closeNote} />
          )}
        </div>
      )}

      {/* 空库优先给引导；否则关系图：无笔记打开时占满右侧，有笔记时缩为侧栏（可关闭） */}
      {vaultEmpty ? (
        <EmptyVaultGuide onOpenInbox={() => setShowInbox(true)} />
      ) : showGraph ? (
        <>
          {/* 图谱缩为侧栏时才可拖（占满右侧时没有可分的两栏） */}
          {current && note && (
            <Divider
              testId="divider-graph"
              value={graphW}
              min={tokenPx('--size-graph-panel-min', 240)}
              max={tokenPx('--size-graph-panel-max', 680)}
              invert
              onChange={setGraphW}
              onCommit={(w) => localStorage.setItem('vault.graphWidth', String(Math.round(w)))}
            />
          )}
          <GraphPanel
            expanded={!current}
            width={graphW}
            currentRef={currentRef}
            onOpen={openNote}
            onClose={() => setGraphVisible(false)}
            ingesting={inboxRunning}
          />
        </>
      ) : (
        !current && (
          <div className="flex flex-1 items-center justify-center text-md text-muted">
            选择左侧笔记，或
            <button onClick={() => setGraphVisible(true)} className="ml-1 text-accent hover:underline">
              打开关系图
            </button>
          </div>
        )
      )}
    </div>
  )
}

/**
 * 笔记读取失败的正文区（M-02）。失败原因大多是可恢复的（文件被 Obsidian 锁着、
 * 权限不对、库被移走），所以主操作是「重试」而不是让用户自己去猜。
 */
function NoteError({
  path,
  error,
  onRetry,
  onClose,
}: {
  path: string
  error: string
  onRetry: () => void
  onClose: () => void
}) {
  return (
    <div
      data-testid="note-error"
      className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
    >
      <FileWarning size={26} className="text-danger" />
      <div className="text-lg font-medium">这篇笔记打不开</div>
      <div className="max-w-md break-all text-sm text-muted">{path}</div>
      <div className="max-w-md break-all text-sm text-danger">{error}</div>
      <div className="mt-1 flex gap-2">
        <button
          data-testid="note-retry"
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-base text-on-solid hover:opacity-90"
        >
          <RotateCcw size={13} /> 重试
        </button>
        <button
          onClick={onClose}
          className="rounded-full border border-line px-4 py-1.5 text-base hover:bg-hover"
        >
          关闭
        </button>
      </div>
    </div>
  )
}

/**
 * 文件树右键菜单（B5，2026-08-19）。
 *
 * **为什么要有它**：之前"新建文件夹"是工具栏上一个按钮，用户根本不知道它会建在哪一级
 * （真人验收原话：「我怎么知道我的文件夹建在哪一级？不应该跟成熟的软件一样么？」）。
 * Finder / VS Code / Obsidian 都是**右键目标对象**出菜单——所见即所得，
 * 你右键的是谁就作用在谁身上。工具栏那个按钮已撤掉，避免两套语义不一致的入口。
 *
 * 三个容易漏的细节，都做了：
 * ① **点外面关**（mousedown 捕获，不是 click——click 会被菜单项自己吃掉）
 * ② **Esc 关**
 * ③ **贴边翻转**：菜单在窗口右/下边缘时往回翻，否则会被裁掉一半
 */
function TreeContextMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number }
  items: Array<{ label: string; danger?: boolean; onClick: () => void }>
  onClose: () => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  // 贴边翻转：量出真实尺寸再决定落点（菜单项数量不固定，写死高度会翻错）
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: at.x + r.width > window.innerWidth - 8 ? Math.max(8, at.x - r.width) : at.x,
      y: at.y + r.height > window.innerHeight - 8 ? Math.max(8, at.y - r.height) : at.y,
    })
  }, [at])

  return (
    <div
      ref={boxRef}
      data-testid="tree-context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[70] min-w-[168px] overflow-hidden rounded-lg border border-line bg-card py-1 shadow-lg"
    >
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          onClick={() => {
            onClose()
            it.onClick()
          }}
          className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-hover ${
            it.danger ? 'text-danger' : 'text-ink'
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

function Tree({
  nodes,
  current,
  onOpen,
  depth,
  expanded,
  onToggle,
  onContext,
}: {
  nodes: VaultTreeNode[]
  current: string | null
  onOpen: (p: string) => void
  depth: number
  expanded: Set<string>
  onToggle: (p: string) => void
  /** 右键：dir=true 表示右键的是目录（菜单项两套不一样） */
  onContext: (e: React.MouseEvent, path: string, dir: boolean) => void
}) {
  return (
    <>
      {nodes.map((n) =>
        n.children ? (
          <div key={n.path}>
            <button
              onClick={() => onToggle(n.path)}
              onContextMenu={(e) => onContext(e, n.path, true)}
              className="w-full rounded px-2 py-1 text-left text-base text-ink-soft hover:bg-hover"
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {expanded.has(n.path) ? '▾' : '▸'} {n.name}
            </button>
            {expanded.has(n.path) && (
              <Tree nodes={n.children} current={current} onOpen={onOpen} depth={depth + 1} expanded={expanded} onToggle={onToggle} onContext={onContext} />
            )}
          </div>
        ) : (
          <button
            key={n.path}
            onClick={() => onOpen(n.path)}
            onContextMenu={(e) => onContext(e, n.path, false)}
            className={`block w-full truncate rounded px-2 py-1 text-left text-base ${
              current === n.path ? 'bg-accent-soft text-accent' : 'text-ink-soft hover:bg-hover'
            }`}
            style={{ paddingLeft: 22 + depth * 14 }}
          >
            {n.name}
          </button>
        )
      )}
    </>
  )
}

/** 笔记头部的 ··· 菜单：低频/危险操作收进来，常驻位置只留「编辑」 */
function MoreMenu({ items }: { items: Array<{ label: string; danger?: boolean; onClick: () => void }> }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center rounded-full border border-line px-2.5 py-1 text-muted hover:bg-hover ${
          open ? 'bg-hover text-ink' : ''
        }`}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          role="menu"
          className="fade-up absolute right-0 top-8 z-30 w-32 overflow-hidden rounded-md border border-line bg-card py-1 shadow-pop"
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              onClick={() => {
                setOpen(false)
                it.onClick()
              }}
              className={`block w-full px-3 py-1.5 text-left text-base hover:bg-hover ${
                it.danger ? 'text-danger' : ''
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NoteView({
  path,
  note,
  onOpenLink,
  onDelete,
  onClose,
  onDirty,
}: {
  path: string
  note: NoteContent
  onOpenLink: (p: string) => void
  onDelete: () => void
  onClose: () => void
  /** 把「有未保存改动」上报给 Explorer，换笔记/关笔记/换库时由它统一拦一道 */
  onDirty: (d: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  /**
   * M-27 编辑冲突：进编辑态记一次内容基线，保存时拿它跟磁盘比。
   * 用**内容 hash** 不用 mtime——chokidar 的 awaitWriteFinish 会让 mtime 对不上，
   * 那样每次自己保存都会给自己报冲突（设计 §8 风险 3）
   */
  const baseHash = useRef('')
  /** 编辑期间检测到的外部改动（非模态提示条），值是磁盘上那一版的正文 */
  const [conflict, setConflict] = useState<string | null>(null)

  useEffect(() => {
    onDirty(dirty)
    // 卸载（换 key）时复位：此时要么已确认放弃、要么是保存后正常离开
    return () => onDirty(false)
  }, [dirty, onDirty])

  const startEdit = async (): Promise<void> => {
    try {
      const raw = await window.api.vault.readRaw(path)
      const st = await window.api.vault.stat(path)
      baseHash.current = st.hash
      setConflict(null)
      setDraft(raw)
      setDirty(false)
      setEditing(true)
    } catch (e) {
      ui.toast(`打不开编辑器：${errText(e)}`, 'error')
    }
  }

  /**
   * 编辑期间的外部改动（设计 §5.2 时机 (b)）：**只挂一条非模态提示条，不打断用户**。
   * 用户正在打字，弹模态会吞掉击键、打断输入法组合，比不提示还差。
   * `self` 是主进程给的标记：应用自己 write 出去的那一下不算冲突。
   */
  useEffect(() => {
    if (!editing) return
    return window.api.vault.onChanged(async (p) => {
      if (p.path !== path || p.self) return
      const st = await window.api.vault.stat(path).catch(() => null)
      if (!st || st.hash === baseHash.current) return
      setConflict(await window.api.vault.readRaw(path).catch(() => ''))
    })
  }, [editing, path])

  /** 落盘成功后的收尾：基线跟上、冲突条撤掉、退出编辑态 */
  const afterSaved = (msg: string): void => {
    void window.api.vault.stat(path).then((st) => {
      baseHash.current = st.hash
    })
    setConflict(null)
    setDirty(false)
    setEditing(false)
    // 真·成功（内容已落盘）→ 绿；「已删除」「已重命名」这类只是告知 → 保持默认炭黑
    ui.toast(msg, 'ok')
  }

  /** 冲突条上的「用我的覆盖」：不等到保存那一步，就地把磁盘那版盖掉（对方改动会丢） */
  const overwrite = async (): Promise<void> => {
    try {
      await window.api.vault.write(path, draft)
      afterSaved('已保存（已覆盖磁盘上的版本）')
    } catch (e) {
      ui.toast(`保存失败：${errText(e)}`, 'error')
    }
  }

  // 保存三态：以前无论写盘成不成功都是"按钮变灰 + 退出编辑态"，
  // 磁盘只读/文件被 Obsidian 锁住/库被移走，用户全都以为存上了
  const save = async (): Promise<void> => {
    try {
      // 时机 (c)：写盘那一刻服务端再校验一次基线，兜住提示条漏掉的窗口 / TOCTOU。
      // 此刻用户已经决定要写盘了，打断是合理的
      const r = await window.api.vault.writeChecked(path, draft, baseHash.current)
      if (r.ok) {
        afterSaved('已保存')
        return
      }
      setConflict(r.current)
      const choice = await ui.choose({
        title: '这个文件已在外部被修改',
        message:
          '你打开编辑之后，磁盘上的这个文件被别的程序（Obsidian？）改过了。\n' +
          '直接保存会把对方的改动覆盖掉，请选择怎么处理：',
        options: [
          { value: 'cancel', label: '取消（回到编辑）' },
          { value: 'overwrite', label: '覆盖对方版本', danger: true },
          // 唯一零数据丢失的选项 → 默认高亮（Obsidian / Dropbox / 坚果云的通行做法）
          { value: 'copy', label: '另存为副本', primary: true },
        ],
      })
      if (choice === 'overwrite') {
        await window.api.vault.write(path, draft)
        afterSaved('已保存（已覆盖磁盘上的版本）')
      } else if (choice === 'copy') {
        const rel = await window.api.vault.saveCopy(path, draft)
        // 磁盘上那一版原样保留，我的这一版写进副本——两份都在
        afterSaved(`已另存为副本「${rel}」，两份都保留了`)
      }
      // 取消：什么都不做，留在编辑态（草稿一个字都不少）
    } catch (e) {
      // 失败保留编辑态与 draft，用户还能复制内容出去，别把人家写的东西弄没了
      ui.toast(`保存失败：${errText(e)}`, 'error')
    }
  }

  const handleLink = async (href: string): Promise<void> => {
    if (href.startsWith('wiki:')) {
      const target = decodeURIComponent(href.slice(5))
      const resolved = await window.api.vault.resolveLink(target)
      if (resolved) onOpenLink(resolved)
      return
    }
    if (/^https?:\/\//.test(href) || !href.match(/^[a-z]+:/)) {
      // 库内相对路径：md 优先库内打开，其余（PDF 等）交系统应用
      if (href.toLowerCase().endsWith('.md')) {
        let decoded = href
        try {
          decoded = decodeURIComponent(href)
        } catch {
          /* noop */
        }
        const resolved = await window.api.vault.resolveLink(decoded.replace(/^\.\//, ''))
        if (resolved) {
          onOpenLink(resolved)
          return
        }
      }
      // M-04：openFile 的返回值以前被直接丢掉——链接指向已移动/改名的附件时，
      // 点了纯粹没反应，用户只会以为是应用坏了
      const ok = await window.api.vault.openFile(href, path)
      if (!ok) ui.toast(`找不到文件：${safeDecode(href)}`, 'error')
    }
  }

  // 空值不再整条丢掉，而是显示破折号——字段在不在，用户一眼能看见。
  // U3 #1：键名走中文映射、值里的英文枚举一并映射、内部字段折进「更多字段」
  const fm = splitFrontmatter(note.frontmatter)
  const fmEntries = fm.shown
  const emptyBody = note.body.trim().length === 0
  const shownBody = formatNoteBody(note.body)
  const oversize = shownBody.length > RENDER_CAP
  // 嵌图引用是**相对这篇笔记**写的，换算成库根相对要靠它（见 components/Markdown.tsx）
  const baseDir = path.split('/').slice(0, -1).join('/')

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-8 py-2.5">
        <div className="truncate text-md font-medium">{note.title}</div>
        <div className="flex gap-2 text-sm">
          {editing ? (
            <>
              <button
                onClick={save}
                className={`rounded-full px-3 py-1 ${dirty ? 'bg-accent text-on-solid' : 'border border-line text-muted'}`}
              >
                保存
              </button>
              <button
                onClick={async () => {
                  if (dirty && !(await ui.confirm({ title: '放弃未保存的修改？', danger: true, okText: '放弃' }))) return
                  setDirty(false) // 不复位的话 Explorer 那边的 dirtyRef 会一直挂着
                  setEditing(false)
                }}
                className="rounded-full border border-line px-3 py-1 hover:bg-accent-soft"
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button onClick={startEdit} className="rounded-full border border-line px-3 py-1 hover:bg-hover">
                编辑
              </button>
              {/* 重命名/删除收进 ···，低频且危险的操作不占常驻位置 */}
              <MoreMenu
                items={[
                  {
                    label: '重命名',
                    onClick: async () => {
                      const name = await ui.prompt({ title: '重命名笔记', initial: note.title })
                      if (!name || name === note.title) return
                      try {
                        const newRel = await window.api.vault.renameNote(path, name)
                        onOpenLink(newRel)
                        ui.toast('已重命名')
                      } catch (e) {
                        ui.toast(String(e), 'error')
                      }
                    },
                  },
                  { label: '删除', danger: true, onClick: onDelete },
                ]}
              />
              <button onClick={onClose} title="关闭文件" className="flex items-center rounded-full border border-line px-2.5 py-1 text-muted hover:text-accent">
                <X size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <>
        {/* 非模态：正文顶上挂一条，用户照常打字（设计 §5.2 时机 (b)） */}
        {conflict !== null && <ConflictBar diskText={conflict} onOverwrite={overwrite} />}
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setDirty(true)
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault()
              save()
            }
          }}
          spellCheck={false}
          className="flex-1 resize-none bg-bg px-8 py-5 font-mono text-base leading-6 outline-none"
        />
        </>
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl px-8 py-6">
            {(fmEntries.length > 0 || fm.more.length > 0) && (
              <div data-testid="note-frontmatter" className="mb-5 overflow-hidden rounded-xl border border-line">
                {fmEntries.map(([k, v]) => {
                  const shown = formatFrontmatterValue(v, k)
                  return (
                    <div key={k} data-fm-key={k} className="flex border-b border-line text-sm last:border-0">
                      {/* 属性卡片的键列跟 markdown 表头同一个暖灰底，两处观感统一 */}
                      <div className="w-32 shrink-0 bg-table-head px-3 py-1.5 text-muted">{fmLabel(k)}</div>
                      <div className={`px-3 py-1.5 ${shown === EMPTY_MARK ? 'text-muted-soft' : ''}`}>{shown}</div>
                    </div>
                  )
                })}
                {fm.more.length > 0 && (
                  // 内部字段（`rule_tagged` / `schema_rev` …）与没见过的键：折起来但不丢掉——
                  // 排查"这篇为什么没被打标"的时候要靠它们
                  <details data-testid="note-frontmatter-more" className="border-t border-line text-sm">
                    <summary className="cursor-pointer bg-table-head px-3 py-1.5 text-muted">
                      更多字段（{fm.more.length}）
                    </summary>
                    {fm.more.map(([k, v]) => (
                      <div key={k} data-fm-key={k} className="flex border-t border-line">
                        <div className="w-32 shrink-0 px-3 py-1.5 font-mono text-muted-soft">{k}</div>
                        <div className="px-3 py-1.5">{formatFrontmatterValue(v, k)}</div>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            )}
            {emptyBody ? (
              <div className="rounded-xl bg-surface px-4 py-3 text-base text-muted">
                该笔记只有属性、没有正文（模板类文件常见）。点右上角「编辑」可添加内容。
              </div>
            ) : oversize ? (
              <FastMarkdown body={shownBody} onLink={handleLink} baseDir={baseDir} />
            ) : (
              <article className="md-article">
                <ReactMarkdown
                  // 两条渲染路径（大文件走 FastMarkdown、常规走这里）必须用同一套图片改写，
                  // 否则"图能不能看见"会取决于笔记多长
                  urlTransform={(url) => assetUrl(url, baseDir) ?? url}
                  remarkPlugins={[
                    remarkGfm,
                    [
                      wikiLinkPlugin,
                      {
                        aliasDivider: '|',
                        pageResolver: (name: string) => [name],
                        hrefTemplate: (permalink: string) => `wiki:${encodeURIComponent(permalink)}`,
                      },
                    ],
                  ]}
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault()
                          if (href) handleLink(href)
                        }}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {shownBody}
                </ReactMarkdown>
              </article>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface GNode {
  id?: string | number
  name?: string
  group?: string
  /** 节点角色：取色的唯一依据，主进程算好下发（vault/graph.ts 的 kindOf） */
  kind?: string
  val?: number
  x?: number
  y?: number
}

const GraphPanel = memo(function GraphPanel({
  expanded,
  width,
  currentRef,
  onOpen,
  onClose,
  ingesting,
}: {
  expanded: boolean
  width: number
  currentRef: MutableRefObject<string | null>
  onOpen: (p: string) => void
  onClose: () => void
  /** 投递箱正在跑：这期间**完全不刷图**（每次变更都重载会让力导向永远收敛不了） */
  ingesting: boolean
}) {
  const [data, setData] = useState<GraphData>({ nodes: [], links: [] })
  /** 这张图上实际出现了哪些节点类型——图例按它筛 */
  const kindsOnGraph = useMemo(
    () => new Set((data.nodes as Array<{ kind?: string }>).map((n) => n.kind ?? 'doc')),
    [data]
  )
  const boxRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 320, h: 400 })
  const hoverRef = useRef<string | null>(null)
  const neighborsRef = useRef<Map<string, Set<string>>>(new Map())
  /** 当前缩放倍率（onZoom 写入）：边线透明度按它联动。**不进 state** —— 每帧 setState 会把 canvas 拖卡 */
  const zoomRef = useRef(1)
  /** 每个节点这一帧画出来的半径（标签层要用它决定文字落在圆下面多远） */
  const radiusRef = useRef<Map<string, number>>(new Map())
  /** 全量图数据的引用：标签层要"看到全图"才能排优先级，而 state 在回调里拿到的是快照 */
  const dataRef = useRef<{ nodes: unknown[]; links: unknown[] }>({ nodes: [], links: [] })

  useEffect(() => {
    const load = (d: GraphData): void => {
      // 邻接表：悬停高亮节点 + 相连边 + 一跳邻居用
      const nb = new Map<string, Set<string>>()
      for (const l of d.links) {
        if (!nb.has(l.source)) nb.set(l.source, new Set())
        if (!nb.has(l.target)) nb.set(l.target, new Set())
        nb.get(l.source)!.add(l.target)
        nb.get(l.target)!.add(l.source)
      }
      neighborsRef.current = nb
      dataRef.current = d
      setData(d)
    }
    /**
     * **防抖 + 入库期间不刷**（客户 2026-08-19 实测：一次投 14 个文件，关系图十分钟一直在动）。
     *
     * 原来是每收到一次 `vault:changed` 就重取整图并 `load()`，而 `load()` 会让力导向模拟
     * 从头跑一遍。批量入库时几十次变更连着来 → 图**永远收敛不了**，节点一直在飘，
     * 既看不清也点不中。
     *
     * 两道闸：① 变更停下来 3 秒才重取；② 投递箱在跑时**完全不刷**，跑完再刷一次。
     * 3 秒是照着投递箱那条既有的 3 秒去抖窗口取的（见 orchestrator），两边节奏对齐。
     */
    window.api.vault.graph().then(load)
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void window.api.vault.graph().then(load)
      }, GRAPH_REFRESH_DEBOUNCE_MS)
    }
    // 入库期间不接变更；`ingesting` 翻回 false 时这个 effect 重跑，顺带补刷一次
    const off = ingesting ? () => {} : window.api.vault.onChanged(schedule)
    if (!ingesting) schedule()
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [ingesting])

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* Obsidian 式绘制：圆点 + 下方文字标签（放大到一定倍率才显示，防止糊成一片）。
     currentRef 走 ref 而非 prop——点击笔记不触发图谱组件重渲染（此前卡顿来源之一） */
  /* 当前缩放倍率：边线透明度按它联动（onZoom 回调写入，不进 state——
     每帧 setState 会把 canvas 拖到卡） */
  const drawNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const id = String(node.id)
      const hov = hoverRef.current
      const isCurrent = id === currentRef.current
      const isHovered = hov === id
      const isNeighbor = !!hov && !!neighborsRef.current.get(hov)?.has(id)
      const dimmed = !!hov && !isHovered && !isNeighbor

      const kind = String(node.kind ?? 'doc')
      // 枢纽（MOC/主题索引/合同）用**重量**而不是颜色跳出来：半径 ×1.4 + 深炭色。
      // 再给它一支颜色的话，"少数发声"就又变成"大家一起喊"
      const hub = kind === 'hub'
      /**
       * 尺寸服从同一条原则：**数量最大的最安静，显眼度让给数量少的**。
       *   枢纽 ×1.4（30 个）· 合作方/产品卡 ×1.2（本库只有 2 + 1 个，不放大整图里根本找不到）
       *   达人卡 ×0.88（121 张，最大的一类）· 普通文档 ×1
       * 光靠颜色降饱和不够——同样面积铺满一片，眼睛还是会先看到它。
       */
      const sizeK = hub ? 1.4 : kind === 'talent' ? 0.88 : kind === 'partner' || kind === 'product' ? 1.2 : 1
      const r = (2 + Math.sqrt(node.val ?? 1)) * sizeK * (isHovered ? 1.5 : isNeighbor ? 1.15 : 1)
      // 压暗到 0.12 而不是全隐：整图的"形状"还得在，否则悬停时上下文全没了
      ctx.globalAlpha = dimmed ? 0.12 : 1
      ctx.beginPath()
      ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI)
      // **填色始终是角色色，高亮只靠环**：以前选中态把填色换成主色，
      // 于是"选中的达人"和"选中的产品"长得一模一样，选中反而抹掉了信息
      ctx.fillStyle = colorOf(kind)
      ctx.fill()
      if (isCurrent || isHovered) {
        // 先描一圈纸色再描橙环：达人卡本身就是橙的，不隔一道底色的话环和点会糊成一坨
        ctx.strokeStyle = token('--color-graph-bg')
        ctx.lineWidth = 2 / globalScale
        ctx.beginPath()
        ctx.arc(node.x!, node.y!, r + 1.5 / globalScale, 0, 2 * Math.PI)
        ctx.stroke()
        ctx.strokeStyle = token('--color-accent')
        ctx.lineWidth = 1.8 / globalScale
        ctx.beginPath()
        ctx.arc(node.x!, node.y!, r + 3 / globalScale, 0, 2 * Math.PI)
        ctx.stroke()
      }
      // **标签不在这里画**：分级显示 + 碰撞剔除需要"看到全图"才能决定谁让谁，
      // 而 nodeCanvasObject 是逐节点回调、画完就盖不掉了。统一挪到 drawLabels（每帧收尾时跑一次）
      ctx.globalAlpha = 1
      // 半径要留给标签层用（它得知道文字该落在圆下面多远）
      radiusRef.current.set(id, r)
    },
    [currentRef]
  )

  /**
   * 标签层（2026-08-18 三期重写，真人验收点名"放大图里标签互相压字"）。
   *
   * 两件事，都必须"看到全图"才能做，所以从 `nodeCanvasObject` 里搬出来、
   * 改成每帧收尾时统一画一次（`onRenderFramePost`）：
   *
   * ① **分级显示**：远景只出枢纽，拉近逐级放出实体卡、最后才是普通文档。
   *    以前是"放大到 1.2 倍就把所有标签一起放出来"，560 个节点当场糊成一片。
   * ② **碰撞剔除**：按优先级从高到低摆放，占了位置就登记矩形，
   *    后来者与已登记矩形相交就**不画**（Obsidian 的行为）。
   *    逐节点回调做不到这件事——先画的已经落在画布上，盖不掉了。
   *
   * 优先级 = 角色（枢纽 > 实体卡 > 文档），同级按连接数。悬停节点与它的一度邻居永远优先且必显。
   */
  const drawLabels = useCallback(
    (ctx: CanvasRenderingContext2D, k: number) => {
      const nodes = (dataRef.current.nodes ?? []) as GNode[]
      if (!nodes.length) return
      const hov = hoverRef.current
      const cur = currentRef.current
      const nb = hov ? neighborsRef.current.get(hov) : null
      /**
       * 各角色开始显示标签的缩放阈值：**数量越多、越晚出场**。
       * 数值是对着整图定的，不是拍的——本库 563 节点默认 fit 之后 k≈0.65，
       * 所以枢纽给 0.4（远景就该有名字，否则整张图没有一个地标）、
       * 合作方/产品 0.5（各只有个位数，出得起）、
       * 达人卡 0.8（121 张，远景全放出来会被碰撞剔除成一片随机散点，比"没有"更糟）、
       * 普通文档 1.8（拉到能看清单个节点了才需要读名字）。
       */
      const MIN_ZOOM: Record<string, number> = { hub: 0.4, partner: 0.5, product: 0.5, talent: 0.8, doc: 1.8 }
      const PRIORITY: Record<string, number> = { hub: 4, partner: 3, product: 3, talent: 2, doc: 1 }

      // 视口裁剪：屏幕外的节点不用量文字（560 个节点每帧全量 measureText 会掉帧）
      const t = ctx.getTransform()
      const W = ctx.canvas.width
      const H = ctx.canvas.height
      const onScreen = (x: number, y: number): boolean => {
        const sx = t.a * x + t.e
        const sy = t.d * y + t.f
        return sx > -60 && sx < W + 60 && sy > -40 && sy < H + 40
      }

      const ranked = nodes
        .filter((n) => n.x != null && n.y != null && onScreen(n.x!, n.y!))
        .map((n) => {
          const id = String(n.id)
          const kind = String(n.kind ?? 'doc')
          const forced = id === hov || id === cur || !!nb?.has(id)
          return { n, id, kind, forced, p: (forced ? 10 : PRIORITY[kind] ?? 1) * 100 + Math.min(99, n.val ?? 1) }
        })
        .filter((x) => x.forced || k >= (MIN_ZOOM[x.kind] ?? 2))
        .sort((a, b) => b.p - a.p)

      const placed: Array<[number, number, number, number]> = []
      const hit = (x0: number, y0: number, x1: number, y1: number): boolean =>
        placed.some(([a0, b0, a1, b1]) => x0 < a1 && x1 > a0 && y0 < b1 && y1 > b0)

      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      const dimAll = !!hov
      for (const item of ranked) {
        const { n, id, forced } = item
        const isHovered = id === hov
        const label = String(n.name ?? '')
        if (!label) continue
        const text = label.length > 12 ? label.slice(0, 12) + '…' : label
        /**
         * **屏幕恒定字号**：11px（悬停 12px）除以缩放，换算成图坐标。
         * 旧写法 `Math.min(11/k, 6)` 有个上限，于是缩小时字跟着一起缩——
         * 远景标签只有 4px 高，等于画了一堆看不清的斑点（真人验收前一版就是这个毛病）。
         * 现在字在屏幕上永远一样大，放不下的交给碰撞剔除去掉，这也是 Obsidian 的做法。
         */
        const fontSize = (isHovered ? 12 : 11) / k
        ctx.font = `${isHovered ? 'bold ' : ''}${fontSize}px ${token('--font-sans')}`
        const w = ctx.measureText(text).width
        const r = radiusRef.current.get(id) ?? 3
        const x0 = n.x! - w / 2
        const y0 = n.y! + r + 1.5
        // 让出一点行距，否则上下两行文字贴着也算"没碰上"
        const box: [number, number, number, number] = [x0 - 1, y0 - 0.5, x0 + w + 1, y0 + fontSize + 1]
        if (hit(...box)) continue
        placed.push(box)
        ctx.fillStyle = dimAll && !forced ? token('--color-graph-label-dim') : token('--color-graph-label')
        ctx.fillText(text, n.x!, y0)
      }
    },
    [currentRef]
  )

  interface GLink {
    source?: GNode | string
    target?: GNode | string
  }
  const linkTouchesHover = (l: GLink): boolean => {
    const hov = hoverRef.current
    if (!hov) return false
    const s = typeof l.source === 'object' ? String(l.source?.id) : String(l.source)
    const t = typeof l.target === 'object' ? String(l.target?.id) : String(l.target)
    return s === hov || t === hov
  }

  return (
    <div
      data-testid="graph-col"
      style={expanded ? undefined : { width }}
      className={`flex shrink-0 flex-col ${expanded ? 'flex-1' : ''}`}
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="text-md font-medium">
          关系图{' '}
          <span className="text-xs font-normal text-muted">
            {data.nodes.length} 节点 · {data.links.length} 边 · 滚轮缩放显示标签
          </span>
        </div>
        <button onClick={onClose} title="关闭关系图" className="rounded p-1 text-muted hover:text-accent">
          <X size={14} />
        </button>
      </div>
      <div ref={boxRef} className="relative flex-1">
        {/*
          图例：颜色语义不许让用户猜。放左下角——右下角是投递箱浮窗的地盘，
          顶部是标题栏。`pointer-events-none` 让它不挡住底下的节点交互。
          **底色用实色不用半透明**：Tailwind 的透明度修饰符（bg-card/90）对 var() 颜色无效，
          写了会直接失效成透明（HANDOFF §4-13）。
        */}
        <div
          data-testid="graph-legend"
          className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-card px-2.5 py-1.5 text-2xs text-muted"
        >
          {/*
            **只列图上真有的类型**（2026-08-21 批 3）。原来是把 GRAPH_LEGEND 整个铺出来，
            于是一个刚建好的通用模板库，图上只有一篇「欢迎」，图例却先摆出
            「达人 · 产品 · 合作方」——跟 `40_带货` 目录、「写种草脚本」快捷指令
            同一类毛病：**别人家的业务，出现在新客户的第一眼里**。
            图例本来就该描述这张图，不是描述产品的所有可能性。
          */}
          {GRAPH_LEGEND.filter((it) => kindsOnGraph.has(it.kind)).map((it) => (
            <span key={it.kind} data-legend={it.kind} className="flex items-center gap-1">
              <i
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: `var(${GRAPH_KIND_TOKEN[it.kind]})` }}
              />
              {it.label}
            </span>
          ))}
        </div>
        <ForceGraph2D
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor={token('--color-graph-bg')}
          nodeLabel="name"
          autoPauseRedraw={false}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={(node: GNode, color: string, ctx: CanvasRenderingContext2D) => {
            ctx.beginPath()
            ctx.arc(node.x!, node.y!, 6, 0, 2 * Math.PI)
            ctx.fillStyle = color
            ctx.fill()
          }}
          /**
           * 边线（三期调）：**线宽降到 Obsidian 量级 0.6px、颜色再淡一档，
           * 且透明度随缩放联动**——缩得越远、边越淡。
           * 500+ 节点铺开时边的数量远多于点，等宽等色画出来是一层毛毡，
           * 先被糊掉的恰恰是节点本身。缩远时人看的是"团块结构"，边只需要暗示；
           * 放大后才需要看清"谁连着谁"。
           */
          linkColor={(l: GLink) =>
            linkTouchesHover(l)
              ? token('--color-accent')
              : hoverRef.current
                ? token('--color-graph-link-dim')
                : fadeLink(token('--color-graph-link'), zoomRef.current)
          }
          linkWidth={(l: GLink) => (linkTouchesHover(l) ? 1.2 : 0.6)}
          onZoom={(z: { k: number }) => {
            zoomRef.current = z.k
          }}
          // 标签统一在这一帧的最后画：节点全部落笔之后才知道谁挤着谁
          onRenderFramePost={(ctx: CanvasRenderingContext2D, k: number) => drawLabels(ctx, k)}
          onNodeHover={(n: GNode | null) => {
            hoverRef.current = n?.id != null ? String(n.id) : null
            if (boxRef.current) boxRef.current.style.cursor = n ? 'pointer' : 'default'
          }}
          onNodeClick={(n: GNode) => n.id && onOpen(String(n.id))}
          d3VelocityDecay={0.25}
          cooldownTime={8000}
        />
      </div>
    </div>
  )
})
