import { memo, useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { wikiLinkPlugin } from 'remark-wiki-link'
import ForceGraph2D from 'react-force-graph-2d'
import { FastMarkdown } from '../components/Markdown'
import { VaultWizard } from '../components/VaultWizard'
import { ui } from '../components/ui'
import { X, Inbox, MoveUpLeft } from 'lucide-react'
import { pendingNote } from '../lib/bus'
import { GRAPH_GROUP_TOKENS, token } from '../theme'

const colorOf = (group: string): string => {
  let h = 0
  for (const c of group) h = (h * 31 + c.charCodeAt(0)) % 9973
  return token(GRAPH_GROUP_TOKENS[h % GRAPH_GROUP_TOKENS.length])
}

/** 超过该长度改走 marked 快速渲染（remark 管线解析大表会卡界面 2-4 秒；marked 快一个数量级） */
const RENDER_CAP = 60_000

export default function VaultPage() {
  const [vault, setVault] = useState<VaultOpenResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.api.vault.openStored().then((v) => {
      setVault(v)
      setLoading(false)
    })
  }, [])

  if (loading)
    return <div className="flex h-full items-center justify-center text-md text-muted">正在索引你的库…</div>
  if (!vault)
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <VaultWizard onReady={setVault} />
      </div>
    )
  return <Explorer vault={vault} onSwitch={() => setVault(null)} />
}

const STAGE_ZH: Record<string, string> = {
  init: '检查',
  enqueue: '入箱',
  convert: '转换',
  pii_guard: 'PII守卫',
  tag_llm: '智能打标',
  sensitive_enrich: '实体建链',
  gen_moc: '索引重建',
  archive: '归档',
  spawn: '引擎启动',
  done: '完成',
  cloud_sync: '上云', // 缺这条时日志里会直接漏出英文 stage id
}

function useInbox(onDone?: (files: string[]) => void, onEnd?: (ok: boolean) => void) {
  const [events, setEvents] = useState<InboxEvent[]>([])
  const [running, setRunning] = useState(false)
  const received = useRef<string[]>([])
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onEndRef = useRef(onEnd)
  onEndRef.current = onEnd
  useEffect(() => {
    window.api.inbox.lastRun().then(setEvents)
    return window.api.inbox.onEvent((ev) => {
      if (ev.type === 'run-start') {
        setRunning(true)
        setEvents([])
      } else if (ev.type === 'run-end') {
        setRunning(false)
        if (ev.ok && received.current.length) onDoneRef.current?.(received.current)
        received.current = []
        onEndRef.current?.(!!ev.ok)
      } else {
        if (ev.type === 'file-added' && ev.file) received.current.push(ev.file)
        setEvents((es) => [...es.slice(-30), ev])
      }
    })
  }, [])
  return { events, running }
}

/** 进度条用的主流程阶段（末尾"上云"是 M4 追加的第 6 段，未登录时会 skipped） */
const FLOW: Array<[string, string]> = [
  ['convert', '转换'],
  ['pii_guard', 'PII守卫'],
  ['tag_llm', '智能打标'],
  ['sensitive_enrich', '实体建链'],
  ['gen_moc', '索引重建'],
  ['cloud_sync', '上云'],
]

/** 从事件流推出「第几段 / 共几段」——阶段来一条推一格，宽度变化交给 CSS 过渡 */
function flowProgress(events: InboxEvent[]): { done: number; total: number; label: string; failed: boolean } {
  const total = FLOW.length
  let done = 0
  let label = ''
  let failed = false
  for (const ev of events) {
    if (ev.type !== 'stage' || !ev.stage) continue
    const i = FLOW.findIndex(([k]) => k === ev.stage)
    if (i < 0) continue
    if (ev.status === 'error') failed = true
    done = Math.max(done, i + 1)
    label = FLOW[i][1]
  }
  return { done, total, label, failed }
}

function InboxPanel({ events, running, onClose }: { events: InboxEvent[]; running: boolean; onClose: () => void }) {
  const dot = (s?: string): string => (s === 'ok' ? 'bg-ok' : s === 'error' ? 'bg-danger' : 'bg-line')
  const { done, total, label, failed } = flowProgress(events)
  const pct = running || done > 0 ? Math.round((done / total) * 100) : 0
  // 日志区跟着最新一条走：不然跑到一半新阶段全在折叠线以下，看着像卡住不动
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [events])
  return (
    <div className="slide-in-right absolute bottom-4 right-4 z-20 w-80 rounded-xl border border-line bg-card shadow-pop">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="text-md font-medium">
          投递箱 {running && <span className="text-xs text-accent">处理中…</span>}
        </div>
        <div className="flex gap-2 text-sm">
          {!running && (
            <button onClick={() => window.api.inbox.runNow()} className="text-muted hover:text-accent">
              立即处理
            </button>
          )}
          <button onClick={onClose} className="text-muted hover:text-accent">
            ✕
          </button>
        </div>
      </div>
      {/* 阶段进度条：过去只有一串日志行，看不出"还剩几步"，跑长任务时体感像卡死 */}
      {(running || done > 0) && (
        <div className="border-b border-line px-4 py-2.5">
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
            <span>{failed ? '有阶段失败' : label || '准备中'}</span>
            <span>
              {done}/{total}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className={`inbox-bar-fill h-full rounded-full ${failed ? 'bg-danger' : 'bg-accent'} ${
                running && !failed ? 'inbox-bar-running' : ''
              }`}
              style={{ width: `${Math.max(pct, running ? 6 : 0)}%` }}
            />
          </div>
        </div>
      )}
      <div ref={logRef} className="max-h-64 overflow-auto px-4 py-2">
        {events.length === 0 ? (
          <div className="py-3 text-sm text-muted">
            把文件拖进窗口，或在 Finder 里丢进投递箱目录，自动转换/打标/建链
          </div>
        ) : (
          events.map((ev, i) => (
            <div key={i} className="fade-up flex items-center gap-2 py-1 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${ev.type === 'file-added' ? 'bg-accent' : dot(ev.status)}`} />
              {ev.type === 'file-added' ? (
                <span className="truncate">收到 {ev.file}</span>
              ) : (
                <span className="truncate">
                  {ev.stage?.startsWith('route_')
                    ? `外部资料转换 · ${ev.stage.slice(6)}`
                    : (STAGE_ZH[ev.stage ?? ''] ?? ev.stage)}
                  {ev.status === 'skipped' && (
                    <span className="text-muted">（{ev.stage === 'convert' ? '本批已在分流完成' : '跳过'}）</span>
                  )}
                  {ev.status === 'error' && <span className="text-danger"> 失败：{ev.message}</span>}
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
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [showGraph, setShowGraph] = useState(() => localStorage.getItem('vault.showGraph') !== '0')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggleDir = useCallback((p: string) => {
    setExpanded((old) => {
      const next = new Set(old)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }, [])
  const { events: inboxEvents, running: inboxRunning } = useInbox(async (files) => {
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
  const [dragOver, setDragOver] = useState(false)

  // 从 Finder 直接丢进投递箱目录时没人开过面板，跑完那一刻面板会"啪"地消失、
  // 用户根本看不到结果。开跑就把面板钉住，结束后由上面的 4 秒计时器收起
  useEffect(() => {
    if (inboxRunning) setShowInbox(true)
  }, [inboxRunning])

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

  useEffect(() => {
    if (pendingNote.path) {
      openNote(pendingNote.path, true)
      pendingNote.path = null
    }
    refreshTree()
    const off = window.api.vault.onChanged(({ path }) => {
      refreshTree()
      setCurrent((cur) => {
        if (cur === path) window.api.vault.read(path).then(setNote).catch(() => setNote(null))
        return cur
      })
    })
    return off
  }, [refreshTree])

  const openNote = useCallback((path: string, reveal = false) => {
    setCurrent(path)
    currentRef.current = path
    setHits([])
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
    window.api.vault.read(path).then(setNote).catch(() => setNote(null))
  }, [])

  const closeNote = useCallback(() => {
    setCurrent(null)
    currentRef.current = null
    setNote(null)
  }, [])

  const createNote = async (): Promise<void> => {
    const name = await ui.prompt({ title: '新建笔记', placeholder: '笔记名称' })
    if (!name) return
    const dir = current ? current.split('/').slice(0, -1).join('/') : ''
    const rel = await window.api.vault.createNote(dir, name)
    openNote(rel)
  }

  const deleteNote = async (): Promise<void> => {
    if (!current) return
    const okd = await ui.confirm({ title: `删除「${note?.title}」？`, message: '将移入系统废纸篓，可随时找回。', danger: true, okText: '删除' })
    if (!okd) return
    await window.api.vault.deleteNote(current)
    closeNote()
  }

  useEffect(() => {
    if (!query.trim()) {
      setHits([])
      return
    }
    const t = setTimeout(() => window.api.vault.search(query).then(setHits), 200)
    return () => clearTimeout(t)
  }, [query])

  const [routes, setRoutes] = useState<Array<{ name: string; dest: string }>>([])
  useEffect(() => {
    void window.api.routes.get().then(setRoutes)
  }, [])

  const dropPaths = (e: React.DragEvent): string[] =>
    [...e.dataTransfer.files]
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p)

  const doEnqueue = async (e: React.DragEvent, subdir?: string): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const paths = dropPaths(e)
    if (paths.length) {
      setShowInbox(true)
      await window.api.inbox.enqueue(paths, subdir)
    }
  }

  return (
    <div
      className="relative flex h-full"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => void doEnqueue(e)}
    >
      {dragOver && (
        <div className="absolute inset-0 z-30 flex gap-3 bg-overlay p-6">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => void doEnqueue(e)}
            className="flex flex-1 flex-col items-center justify-center rounded-xl border-4 border-dashed border-accent bg-accent-soft text-accent"
          >
            <div className="text-xl font-semibold">业务资料</div>
            <div className="mt-2 text-base opacity-80">公司文件 · 智能打标 → 80_Library</div>
          </div>
          {routes.map((r) => (
            <div
              key={r.name}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => void doEnqueue(e, r.name)}
              className="flex flex-1 flex-col items-center justify-center rounded-xl border-4 border-dashed border-line bg-card text-ink"
            >
              <div className="text-xl font-semibold">{r.name}</div>
              <div className="mt-2 text-base text-muted">主题打标 · 概念建链 → {r.dest}/</div>
            </div>
          ))}
        </div>
      )}
      {(showInbox || inboxRunning) && (
        <InboxPanel events={inboxEvents} running={inboxRunning} onClose={() => setShowInbox(false)} />
      )}
      {/* 分区树 */}
      <div className="flex w-tree shrink-0 flex-col border-r border-line">
        <div className="border-b border-line p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索库…"
            className="w-full rounded-md border border-line bg-card px-3 py-1.5 text-md outline-none focus:border-accent"
          />
          <div className="mt-2 flex items-center justify-between text-xs text-muted">
            <span>{countNotes(tree) || vault.noteCount} 篇笔记</span>
            <span className="flex gap-2">
              {/* 空库时给投递箱入口加个描边，和中间区域的引导箭头对上 */}
              <button
                onClick={() => setShowInbox((s) => !s)}
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
              <button onClick={createNote} className="hover:text-accent">
                ＋新建
              </button>
              {!showGraph && !vaultEmpty && (
                <button onClick={() => setGraphVisible(true)} className="hover:text-accent">
                  图谱
                </button>
              )}
              <button onClick={onSwitch} className="hover:text-accent">
                换库
              </button>
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {hits.length > 0 ? (
            hits.map((h) => (
              <button
                key={h.path}
                onClick={() => openNote(h.path)}
                className="mb-1 w-full rounded-lg bg-card p-2 text-left hover:bg-accent-soft"
              >
                <div className="text-base font-medium">{h.title}</div>
                <div className="line-clamp-2 text-xs text-muted">{h.snippet}</div>
              </button>
            ))
          ) : (
            <Tree nodes={tree} current={current} onOpen={openNote} depth={0} expanded={expanded} onToggle={toggleDir} />
          )}
        </div>
      </div>

      {/* 正文（可关闭） */}
      {current && note && (
        <div className="min-w-0 flex-1 overflow-hidden">
          <NoteView
            key={current}
            path={current}
            note={note}
            onOpenLink={openNote}
            onDelete={deleteNote}
            onClose={closeNote}
          />
        </div>
      )}

      {/* 空库优先给引导；否则关系图：无笔记打开时占满右侧，有笔记时缩为侧栏（可关闭） */}
      {vaultEmpty ? (
        <EmptyVaultGuide onOpenInbox={() => setShowInbox(true)} />
      ) : showGraph ? (
        <GraphPanel
          expanded={!current}
          currentRef={currentRef}
          onOpen={openNote}
          onClose={() => setGraphVisible(false)}
        />
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

function NoteView({
  path,
  note,
  onOpenLink,
  onDelete,
  onClose,
}: {
  path: string
  note: NoteContent
  onOpenLink: (p: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)

  const startEdit = async (): Promise<void> => {
    setDraft(await window.api.vault.readRaw(path))
    setDirty(false)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    await window.api.vault.write(path, draft)
    setDirty(false)
    setEditing(false)
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
      await window.api.vault.openFile(href, path)
    }
  }

  const fmEntries = Object.entries(note.frontmatter).filter(([, v]) => v != null && v !== '')
  const emptyBody = note.body.trim().length === 0
  const oversize = note.body.length > RENDER_CAP

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
                  setEditing(false)
                }}
                className="rounded-full border border-line px-3 py-1 hover:bg-accent-soft"
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button onClick={startEdit} className="rounded-full border border-line px-3 py-1 hover:bg-accent-soft">
                编辑
              </button>
              <button
                onClick={async () => {
                  const name = await ui.prompt({ title: '重命名笔记', initial: note.title })
                  if (!name || name === note.title) return
                  try {
                    const newRel = await window.api.vault.renameNote(path, name)
                    onOpenLink(newRel)
                    ui.toast('已重命名')
                  } catch (e) {
                    ui.toast(String(e), 'error')
                  }
                }}
                className="rounded-full border border-line px-3 py-1 hover:bg-accent-soft"
              >
                重命名
              </button>
              <button onClick={onDelete} className="rounded-full border border-line px-3 py-1 text-muted hover:text-accent">
                删除
              </button>
              <button onClick={onClose} title="关闭文件" className="flex items-center rounded-full border border-line px-2.5 py-1 text-muted hover:text-accent">
                <X size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {editing ? (
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
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl px-8 py-6">
            {fmEntries.length > 0 && (
              <div className="mb-5 overflow-hidden rounded-xl border border-line">
                {fmEntries.map(([k, v]) => (
                  <div key={k} className="flex border-b border-line text-sm last:border-0">
                    <div className="w-32 shrink-0 bg-sidebar px-3 py-1.5 text-muted">{k}</div>
                    <div className="px-3 py-1.5">{Array.isArray(v) ? v.join(' / ') : String(v)}</div>
                  </div>
                ))}
              </div>
            )}
            {emptyBody ? (
              <div className="rounded-xl bg-sidebar px-4 py-3 text-base text-muted">
                该笔记只有属性、没有正文（模板类文件常见）。点右上角「编辑」可添加内容。
              </div>
            ) : oversize ? (
              <FastMarkdown body={note.body} onLink={handleLink} />
            ) : (
              <article className="md-article">
                <ReactMarkdown
                  urlTransform={(url) => url}
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
                  {note.body}
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
  currentRef,
  onOpen,
  onClose,
}: {
  expanded: boolean
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
    <div className={`flex shrink-0 flex-col border-l border-line ${expanded ? 'flex-1' : 'w-graph-panel'}`}>
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
