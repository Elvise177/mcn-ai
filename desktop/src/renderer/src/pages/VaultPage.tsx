import { memo, useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
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
import { GRAPH_GROUP_TOKENS, token, tokenPx } from '../theme'
import { EMPTY_MARK, formatFrontmatterValue, formatNoteBody } from '../lib/note-format'
import { errText } from '../lib/err'
import { enqueueMessage } from '../lib/enqueue'
import { useTask } from '../hooks/useTasks'
import { useDragOver } from '../hooks/useDragOver'

const colorOf = (group: string): string => {
  let h = 0
  for (const c of group) h = (h * 31 + c.charCodeAt(0)) % 9973
  return token(GRAPH_GROUP_TOKENS[h % GRAPH_GROUP_TOKENS.length])
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

const STAGE_ZH: Record<string, string> = {
  init: '检查',
  enqueue: '入箱',
  convert: '转换',
  pii_guard: 'PII守卫',
  tag_llm: '智能打标',
  tag_rules: '规则打标',
  convert_failures: '转换结果',
  sensitive_enrich: '实体建链',
  gen_moc: '索引重建',
  build_cards: '实体建卡',
  archive: '归档',
  spawn: '引擎启动',
  done: '完成',
  cloud_sync: '上云', // 缺这条时日志里会直接漏出英文 stage id
}

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
function InboxPanel({ task, running, onClose }: { task?: InboxTask; running: boolean; onClose: () => void }) {
  const dot = (s?: string): string =>
    s === 'ok' ? 'bg-ok' : s === 'error' ? 'bg-danger' : s === 'warn' ? 'bg-warning' : 'bg-line'
  const events = task?.stages ?? []
  // A-4：pipeline 把没产出笔记的文件名放在 convert_failures 事件里，这里摊平成一张清单。
  // 只给数字没法处理——用户要知道是哪几个文件才能决定补什么
  const failures = events.flatMap((e) =>
    e.stage === 'convert_failures'
      ? [...((e as { failed?: string[] }).failed ?? []), ...((e as { unsupported?: string[] }).unsupported ?? [])]
      : []
  )
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
                ui.toast('已停止本轮投递，已完成的部分保留，未处理的文件仍在投递箱里')
              }}
              className="text-muted hover:text-accent disabled:opacity-60"
            >
              {stopping ? '停止中…' : '停止本轮'}
            </button>
          ) : (
            <button onClick={() => window.api.inbox.runNow()} className="text-muted hover:text-accent">
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
          {task?.title ?? '已停止'}；未处理的文件仍在投递箱里，点「立即处理」可接着做。
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
          <div className="mb-1 font-medium">以下文件没有生成笔记，原件已移到「投递箱/.failed/」：</div>
          <ul className="ml-4 list-disc text-muted">
            {failures.map((f) => (
              <li key={f} className="truncate">{f}</li>
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
      <div className="flex w-full max-w-md flex-col items-center rounded-xl border border-dashed border-accent-line bg-sidebar px-8 py-10 text-center">
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
    const off = window.api.vault.onChanged(({ path }) => {
      refreshTree()
      setCurrent((cur) => {
        if (cur === path) readNote(path, true)
        return cur
      })
    })
    return off
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
      message: `当前库：${vault.path}\n\n会回到建库/选库引导，在那里点「返回当前库」可以随时回来。`,
      okText: '去换库',
    })
    if (ok) onSwitch()
  }, [confirmDiscard, onSwitch, vault.path])

  const createNote = async (): Promise<void> => {
    const name = await ui.prompt({ title: '新建笔记', placeholder: '笔记名称' })
    if (!name) return
    const dir = current ? current.split('/').slice(0, -1).join('/') : ''
    const rel = await window.api.vault.createNote(dir, name)
    openNote(rel)
  }

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
  const dropPaths = (e: React.DragEvent): string[] =>
    [...(e.dataTransfer?.files ?? [])]
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p)

  const doEnqueue = async (e: React.DragEvent, subdir?: string): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    drag.reset()
    const paths = dropPaths(e)
    if (!paths.length) return
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
          {[{ name: '业务资料', desc: '公司文件 · 智能打标 → 80_Library', subdir: undefined as string | undefined }].concat(
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
                投递箱{inboxRunning ? '·忙' : ''}
              </button>
              <button onClick={createNote} title="新建笔记" className="hover:text-accent">
                新建
              </button>
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
        <div className="flex-1 overflow-auto p-2">
          {!query.trim() ? (
            <Tree nodes={tree} current={current} onOpen={openNote} depth={0} expanded={expanded} onToggle={toggleDir} />
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

function Tree({
  nodes,
  current,
  onOpen,
  depth,
  expanded,
  onToggle,
}: {
  nodes: VaultTreeNode[]
  current: string | null
  onOpen: (p: string) => void
  depth: number
  expanded: Set<string>
  onToggle: (p: string) => void
}) {
  return (
    <>
      {nodes.map((n) =>
        n.children ? (
          <div key={n.path}>
            <button
              onClick={() => onToggle(n.path)}
              className="w-full rounded px-2 py-1 text-left text-base text-ink-soft hover:bg-hover"
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {expanded.has(n.path) ? '▾' : '▸'} {n.name}
            </button>
            {expanded.has(n.path) && (
              <Tree nodes={n.children} current={current} onOpen={onOpen} depth={depth + 1} expanded={expanded} onToggle={onToggle} />
            )}
          </div>
        ) : (
          <button
            key={n.path}
            onClick={() => onOpen(n.path)}
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
    ui.toast(msg)
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

  // 空值不再整条丢掉，而是显示破折号——字段在不在，用户一眼能看见
  const fmEntries = Object.entries(note.frontmatter)
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
            {fmEntries.length > 0 && (
              <div className="mb-5 overflow-hidden rounded-xl border border-line">
                {fmEntries.map(([k, v]) => {
                  const shown = formatFrontmatterValue(v)
                  return (
                    <div key={k} className="flex border-b border-line text-sm last:border-0">
                      {/* 属性卡片的键列跟 markdown 表头同一个暖灰底，两处观感统一 */}
                      <div className="w-32 shrink-0 bg-table-head px-3 py-1.5 text-muted">{k}</div>
                      <div className={`px-3 py-1.5 ${shown === EMPTY_MARK ? 'text-muted-soft' : ''}`}>{shown}</div>
                    </div>
                  )
                })}
              </div>
            )}
            {emptyBody ? (
              <div className="rounded-xl bg-sidebar px-4 py-3 text-base text-muted">
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
}: {
  expanded: boolean
  width: number
  currentRef: MutableRefObject<string | null>
  onOpen: (p: string) => void
  onClose: () => void
}) {
  const [data, setData] = useState<GraphData>({ nodes: [], links: [] })
  const boxRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 320, h: 400 })
  const hoverRef = useRef<string | null>(null)
  const neighborsRef = useRef<Map<string, Set<string>>>(new Map())

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
      setData(d)
    }
    window.api.vault.graph().then(load)
    const off = window.api.vault.onChanged(() => window.api.vault.graph().then(load))
    return off
  }, [])

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* Obsidian 式绘制：圆点 + 下方文字标签（放大到一定倍率才显示，防止糊成一片）。
     currentRef 走 ref 而非 prop——点击笔记不触发图谱组件重渲染（此前卡顿来源之一） */
  const drawNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const id = String(node.id)
      const hov = hoverRef.current
      const isCurrent = id === currentRef.current
      const isHovered = hov === id
      const isNeighbor = !!hov && !!neighborsRef.current.get(hov)?.has(id)
      const dimmed = !!hov && !isHovered && !isNeighbor

      const r = (2 + Math.sqrt(node.val ?? 1)) * (isHovered ? 1.5 : 1)
      ctx.globalAlpha = dimmed ? 0.1 : 1
      ctx.beginPath()
      ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI)
      ctx.fillStyle = isCurrent || isHovered ? token('--color-accent') : colorOf(String(node.group ?? ''))
      ctx.fill()
      if (isCurrent || isHovered) {
        ctx.strokeStyle = token('--color-accent')
        ctx.lineWidth = 1.5 / globalScale
        ctx.beginPath()
        ctx.arc(node.x!, node.y!, r + 2.5 / globalScale, 0, 2 * Math.PI)
        ctx.stroke()
      }
      // 标签：悬停节点及其邻居无视缩放常显；其余放大后显示（悬停时淡化）
      const showLabel = isHovered || isNeighbor || globalScale > 1.2
      if (showLabel) {
        const label = String(node.name ?? '')
        const fontSize = isHovered ? Math.max(12 / globalScale, 4) : Math.min(11 / globalScale, 6)
        ctx.font = `${isHovered ? 'bold ' : ''}${fontSize}px ${token('--font-sans')}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = dimmed ? token('--color-graph-label-dim') : token('--color-graph-label')
        ctx.fillText(label.length > 12 ? label.slice(0, 12) + '…' : label, node.x!, node.y! + r + 1.5)
      }
      ctx.globalAlpha = 1
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
      <div ref={boxRef} className="flex-1">
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
          linkColor={(l: GLink) =>
            linkTouchesHover(l)
              ? token('--color-accent')
              : hoverRef.current
                ? token('--color-graph-link-dim')
                : token('--color-graph-link')
          }
          linkWidth={(l: GLink) => (linkTouchesHover(l) ? 1.8 : 1)}
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
