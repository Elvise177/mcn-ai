import { memo, useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { wikiLinkPlugin } from 'remark-wiki-link'
import ForceGraph2D from 'react-force-graph-2d'
import { FastMarkdown } from '../components/Markdown'
import { VaultWizard } from '../components/VaultWizard'
import { ui } from '../components/ui'
import { X } from 'lucide-react'
import { pendingNote } from '../lib/bus'

const GROUP_COLORS = ['#e25484', '#ba8c1e', '#4a76be', '#589860', '#8c6bb8', '#c96a4a', '#5aa7a7']
const colorOf = (group: string): string => {
  let h = 0
  for (const c of group) h = (h * 31 + c.charCodeAt(0)) % 9973
  return GROUP_COLORS[h % GROUP_COLORS.length]
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
    return <div className="flex h-full items-center justify-center text-sm text-muted">正在索引你的库…</div>
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

function InboxPanel({ events, running, onClose }: { events: InboxEvent[]; running: boolean; onClose: () => void }) {
  const dot = (s?: string): string =>
    s === 'ok' ? 'bg-emerald-500' : s === 'error' ? 'bg-red-500' : 'bg-line'
  return (
    <div className="absolute bottom-4 right-4 z-20 w-80 rounded-2xl border border-line bg-card shadow-lg">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="text-sm font-medium">
          投递箱 {running && <span className="text-[11px] text-rose">处理中…</span>}
        </div>
        <div className="flex gap-2 text-[12px]">
          {!running && (
            <button onClick={() => window.api.inbox.runNow()} className="text-muted hover:text-rose">
              立即处理
            </button>
          )}
          <button onClick={onClose} className="text-muted hover:text-rose">
            ✕
          </button>
        </div>
      </div>
      <div className="max-h-64 overflow-auto px-4 py-2">
        {events.length === 0 ? (
          <div className="py-3 text-[12px] text-muted">
            把文件拖进窗口，或在 Finder 里丢进投递箱目录，自动转换/打标/建链
          </div>
        ) : (
          events.map((ev, i) => (
            <div key={i} className="flex items-center gap-2 py-1 text-[12px]">
              <span className={`h-2 w-2 rounded-full ${ev.type === 'file-added' ? 'bg-rose' : dot(ev.status)}`} />
              {ev.type === 'file-added' ? (
                <span className="truncate">收到 {ev.file}</span>
              ) : (
                <span className="truncate">
                  {STAGE_ZH[ev.stage ?? ''] ?? ev.stage}
                  {ev.status === 'skipped' && <span className="text-muted">（跳过）</span>}
                  {ev.status === 'error' && <span className="text-red-600"> 失败：{ev.message}</span>}
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

  const setGraphVisible = (v: boolean): void => {
    localStorage.setItem('vault.showGraph', v ? '1' : '0')
    setShowGraph(v)
  }

  const refreshTree = useCallback(() => {
    window.api.vault.tree().then(setTree)
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

  return (
    <div
      className="relative flex h-full"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault()
        setDragOver(false)
        const paths = [...e.dataTransfer.files]
          .map((f) => (f as File & { path?: string }).path)
          .filter((p): p is string => !!p)
        if (paths.length) {
          setShowInbox(true)
          await window.api.inbox.enqueue(paths)
        }
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-4 border-dashed border-rose bg-rose-soft/60 text-lg font-medium text-rose">
          松手投递到知识库
        </div>
      )}
      {(showInbox || inboxRunning) && (
        <InboxPanel events={inboxEvents} running={inboxRunning} onClose={() => setShowInbox(false)} />
      )}
      {/* 分区树 */}
      <div className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索库…"
            className="w-full rounded-lg border border-line bg-card px-3 py-1.5 text-sm outline-none focus:border-rose"
          />
          <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
            <span>{vault.noteCount} 篇笔记</span>
            <span className="flex gap-2">
              <button
                onClick={() => setShowInbox((s) => !s)}
                className={inboxRunning ? 'text-rose' : 'hover:text-rose'}
              >
                投递箱{inboxRunning ? '·忙' : ''}
              </button>
              <button onClick={createNote} className="hover:text-rose">
                ＋新建
              </button>
              {!showGraph && (
                <button onClick={() => setGraphVisible(true)} className="hover:text-rose">
                  图谱
                </button>
              )}
              <button onClick={onSwitch} className="hover:text-rose">
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
                className="mb-1 w-full rounded-lg bg-card p-2 text-left hover:bg-rose-soft"
              >
                <div className="text-[13px] font-medium">{h.title}</div>
                <div className="line-clamp-2 text-[11px] text-muted">{h.snippet}</div>
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

      {/* 关系图：无笔记打开时占满右侧，有笔记时缩为侧栏（可关闭） */}
      {showGraph ? (
        <GraphPanel
          expanded={!current}
          currentRef={currentRef}
          onOpen={openNote}
          onClose={() => setGraphVisible(false)}
        />
      ) : (
        !current && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">
            选择左侧笔记，或
            <button onClick={() => setGraphVisible(true)} className="ml-1 text-rose hover:underline">
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
              className="w-full rounded px-2 py-1 text-left text-[13px] text-ink/80 hover:bg-black/[0.03]"
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
            className={`block w-full truncate rounded px-2 py-1 text-left text-[13px] ${
              current === n.path ? 'bg-rose-soft text-rose' : 'text-ink/70 hover:bg-black/[0.03]'
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
        <div className="truncate text-sm font-medium">{note.title}</div>
        <div className="flex gap-2 text-[12px]">
          {editing ? (
            <>
              <button
                onClick={save}
                className={`rounded-full px-3 py-1 ${dirty ? 'bg-rose text-white' : 'border border-line text-muted'}`}
              >
                保存
              </button>
              <button
                onClick={async () => {
                  if (dirty && !(await ui.confirm({ title: '放弃未保存的修改？', danger: true, okText: '放弃' }))) return
                  setEditing(false)
                }}
                className="rounded-full border border-line px-3 py-1 hover:bg-rose-soft"
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button onClick={startEdit} className="rounded-full border border-line px-3 py-1 hover:bg-rose-soft">
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
                className="rounded-full border border-line px-3 py-1 hover:bg-rose-soft"
              >
                重命名
              </button>
              <button onClick={onDelete} className="rounded-full border border-line px-3 py-1 text-muted hover:text-rose">
                删除
              </button>
              <button onClick={onClose} title="关闭文件" className="flex items-center rounded-full border border-line px-2.5 py-1 text-muted hover:text-rose">
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
          className="flex-1 resize-none bg-bg px-8 py-5 font-mono text-[13px] leading-6 outline-none"
        />
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl px-8 py-6">
            {fmEntries.length > 0 && (
              <div className="mb-5 overflow-hidden rounded-xl border border-line">
                {fmEntries.map(([k, v]) => (
                  <div key={k} className="flex border-b border-line text-[12px] last:border-0">
                    <div className="w-32 shrink-0 bg-sidebar px-3 py-1.5 text-muted">{k}</div>
                    <div className="px-3 py-1.5">{Array.isArray(v) ? v.join(' / ') : String(v)}</div>
                  </div>
                ))}
              </div>
            )}
            {emptyBody ? (
              <div className="rounded-xl bg-sidebar px-4 py-3 text-[13px] text-muted">
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
      ctx.fillStyle = isCurrent || isHovered ? '#e25484' : colorOf(String(node.group ?? ''))
      ctx.fill()
      if (isCurrent || isHovered) {
        ctx.strokeStyle = '#e25484'
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
        ctx.font = `${isHovered ? 'bold ' : ''}${fontSize}px PingFang SC, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = dimmed ? 'rgba(61,57,47,0.1)' : 'rgba(61,57,47,0.85)'
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
    <div className={`flex shrink-0 flex-col border-l border-line ${expanded ? 'flex-1' : 'w-[360px]'}`}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="text-sm font-medium">
          关系图{' '}
          <span className="text-[11px] font-normal text-muted">
            {data.nodes.length} 节点 · {data.links.length} 边 · 滚轮缩放显示标签
          </span>
        </div>
        <button onClick={onClose} title="关闭关系图" className="rounded p-1 text-muted hover:text-rose">
          <X size={14} />
        </button>
      </div>
      <div ref={boxRef} className="flex-1">
        <ForceGraph2D
          width={size.w}
          height={size.h}
          graphData={data}
          backgroundColor="#faf9f5"
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
            linkTouchesHover(l) ? '#e25484' : hoverRef.current ? 'rgba(220,215,201,0.25)' : '#dcd7c9'
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
