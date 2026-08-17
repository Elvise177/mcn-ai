import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, Copy, Loader2, X, Paperclip, MessageSquare, Inbox, Check } from 'lucide-react'
import { FastMarkdown } from '../components/Markdown'
import { FileIcon } from '../components/FileIcon'
import { ui } from '../components/ui'
import { CHIPS } from '../config/chips'
import { greetingLine } from '../lib/profile'
import { errText } from '../lib/err'
import { useTask } from '../hooks/useTasks'

const TOOL_ZH: Record<string, string> = {
  search_knowledge: '检索知识库',
  render_pptx: '渲染 PPT',
  render_document: '渲染文档',
  Read: '读取笔记',
  Grep: '全文查找',
  Glob: '定位文件',
  Write: '写入产物',
}

/** 卡片区/产物面板共用的时间格式 */
const shortTime = (ms: number): string =>
  new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function Workbench({
  conv,
  onSend,
  onOpenNote,
  nickname,
  recentConvs,
  onOpenConv,
}: {
  conv: Conversation
  /** 返回 false = 主进程拒了这次发送（同一会话已在生成中，H-10），输入框内容要留着 */
  onSend: (text: string) => Promise<boolean>
  onOpenNote: (wikiTarget: string) => void
  nickname?: string
  recentConvs: Conversation[]
  onOpenConv: (c: Conversation) => void
}) {
  // 消息以 conv prop 为准（App 统一持久化）；这里只管流式草稿/工具行/输入框
  const messages = conv.messages
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const [toolLine, setToolLine] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const convRef = useRef(conv)
  convRef.current = conv

  // 「这个会话在不在生成」的真相在主进程，不再是本组件的局部量——
  // 切走再切回来、甚至 reload，状态都还在（H-10 的"看得见在跑"）
  const task = useTask('agent', conv.id)
  const taskRunning = task?.status === 'running'
  // sending 只是"刚点了发送、任务事件还没回来"的这几十毫秒的乐观态
  const streaming = sending || taskRunning

  useEffect(() => {
    setInput('')
    setDraft('')
    setToolLine(null)
    setSending(false)
  }, [conv.id])

  // 切回一个正在生成的会话：用主进程累积的 draft 补齐切走那段时间流出的字，
  // 之后继续听 agent:stream 逐字追加。只在本地为空时采纳，别把更新的本地内容盖回旧快照
  useEffect(() => {
    if (!taskRunning || !task) return
    setDraft((d) => d || task.draft)
    setToolLine((l) => l ?? (task.toolLine ? (TOOL_ZH[task.toolLine.replace(/^mcp__\w+__/, '')] ?? task.toolLine) : null))
  }, [taskRunning, task])

  useEffect(() => {
    return window.api.chat.onStream((p) => {
      if (p.sessionId !== convRef.current.id) return
      if (p.kind === 'delta' && p.text) {
        setDraft((d) => d + p.text)
        setToolLine(null)
      } else if (p.kind === 'tool' && p.tool) {
        const short = p.tool.replace(/^mcp__\w+__/, '')
        setToolLine(TOOL_ZH[short] ?? short)
      } else if (p.kind === 'assistant') {
        setDraft('')
      } else if (p.kind === 'done' || p.kind === 'error') {
        setDraft('')
        setSending(false)
        setToolLine(null)
      }
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, draft, toolLine])

  /**
   * 发送。**生成中也照发**——由主进程拒绝并回一条带「停止当前生成」动作的提示（设计 §5.3）。
   * 渲染层静默吞掉这次按键的话，用户敲了 Enter 什么都没发生，只会以为键盘坏了。
   */
  const send = useCallback(
    async (text: string) => {
      const t = text.trim()
      if (!t) return
      const busy = streaming
      if (!busy) {
        setSending(true)
        setDraft('')
      }
      const ok = await onSend(t)
      // 被拒：输入原样留着，用户点了 toast 上的「停止当前生成」就能接着发
      if (ok) setInput('')
      else if (!busy) setSending(false)
    },
    [streaming, onSend]
  )

  const handleLink = useCallback(
    async (href: string) => {
      if (href.startsWith('wiki:')) onOpenNote(decodeURIComponent(href.slice(5)))
    },
    [onOpenNote]
  )

  const empty = messages.length === 0 && !streaming

  // 拖文件进工作台页：以前没人拦，Electron 直接导航到 file:// 把整个应用替换掉。
  // 现在走和知识库页同一条链路（inbox.enqueue），拖入时给覆盖层告诉用户会发生什么
  const [dragOver, setDragOver] = useState(false)
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const paths = [...e.dataTransfer.files]
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p)
    if (!paths.length) return
    try {
      await window.api.inbox.enqueue(paths)
      ui.toast(`已送入投递箱（${paths.length} 个文件），可在「个人知识库」看处理进度`)
    } catch (err) {
      ui.toast(`入库失败：${errText(err)}`, 'error')
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
      onDrop={(e) => void onDrop(e)}
    >
      {dragOver && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-overlay p-6">
          <div className="flex w-full max-w-md flex-col items-center rounded-xl border-2 border-dashed border-accent bg-card px-8 py-10 text-center">
            <Inbox size={28} className="mb-3 text-accent" />
            <div className="text-xl font-semibold">松手即入库</div>
            <div className="mt-2 text-base text-muted">
              文件会送进投递箱，自动转成笔记并打标建链，之后就能被 AI 检索到
            </div>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {empty ? (
          // 问候区落在视口上方 1/3（--home-top），下面依次是输入框、快捷指令、最近卡片区
          <div className="flex flex-1 flex-col items-center overflow-auto px-8 pb-10 pt-home-top">
            {/* 衬线在米白底上偏轻飘：字号提到 38px 压住（见 --text-display 注释），
                字重 500 只对拉丁昵称生效，中文衬线没有 medium 字面 */}
            <h1 className="fade-up mb-2 font-serif text-display font-medium leading-tight">
              {greetingLine(nickname)}
            </h1>
            <p className="mb-8 text-md text-muted">问你的库，或直接说要做什么</p>
            <InputBox value={input} onChange={setInput} onSend={() => void send(input)} streaming={false} wide />
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {CHIPS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setInput(c.prompt)}
                  className="rounded-full border border-line bg-card px-3.5 py-1.5 text-base hover:bg-hover"
                >
                  {c.label}
                </button>
              ))}
            </div>
            <RecentDock convs={recentConvs} onOpenConv={onOpenConv} />
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 overflow-auto px-8 py-6">
              <div className="mx-auto max-w-3xl space-y-5">
                {messages.map((m, i) =>
                  m.role === 'user' ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[80%] rounded-xl bg-sidebar px-4 py-2.5 text-md">{m.text}</div>
                    </div>
                  ) : (
                    <div key={i} className="group flex gap-3">
                      <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />
                      <div className="min-w-0 flex-1">
                        <FastMarkdown body={m.text} onLink={handleLink} />
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(m.text)
                            ui.toast('已复制')
                          }}
                          className="mt-1 hidden items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:text-accent group-hover:inline-flex"
                        >
                          <Copy size={11} /> 复制
                        </button>
                      </div>
                    </div>
                  )
                )}
                {(draft || toolLine) && (
                  <div className="flex gap-3">
                    <span className="mt-2 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-accent" />
                    <div className="min-w-0 flex-1">
                      {toolLine && (
                        <div className="mb-1 flex items-center gap-1.5 text-sm text-muted">
                          <Loader2 size={12} className="animate-spin" /> {toolLine}…
                        </div>
                      )}
                      {/* streaming-body：给正文最后一行末尾接一个呼吸光标，边写边有"还在写"的实感 */}
                      {draft && (
                        <div className="streaming-body">
                          <FastMarkdown body={draft} onLink={handleLink} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {streaming && !draft && !toolLine && (
                  <div className="thinking-dots pl-6 pt-1"><span /><span /><span /></div>
                )}
              </div>
            </div>
            <div className="border-t border-line px-8 py-4">
              <div className="mx-auto max-w-3xl">
                <InputBox
                  value={input}
                  onChange={setInput}
                  onSend={() => void send(input)}
                  onStop={() => window.api.chat.stop(convRef.current.id)}
                  streaming={streaming}
                />
              </div>
            </div>
          </>
        )}
      </div>
      {/* 首页已经有「最近产物」卡片区，这里默认收起，避免同屏两份一样的内容 */}
      <ArtifactPanel homeEmpty={empty} onOpenNote={onOpenNote} />
    </div>
  )
}

/** 首页输入框下方的「最近产物 / 最近对话」卡片区：复用现有数据，各最多 6 个，都没有就整块不出现 */
function RecentDock({ convs, onOpenConv }: { convs: Conversation[]; onOpenConv: (c: Conversation) => void }) {
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])

  useEffect(() => {
    window.api.artifacts.list().then((list) => setArtifacts(list.slice(0, 6)))
    return window.api.artifacts.onCreated(() => {
      window.api.artifacts.list().then((list) => setArtifacts(list.slice(0, 6)))
    })
  }, [])

  const recent = convs.slice(0, 6)
  if (artifacts.length === 0 && recent.length === 0) return null
  // 只有一栏数据时铺满，别在右边留一块空白
  const cols = artifacts.length > 0 && recent.length > 0 ? 'sm:grid-cols-2' : 'grid-cols-1'

  return (
    <div className={`fade-up mt-12 grid w-full max-w-2xl gap-6 ${cols}`}>
      {artifacts.length > 0 && (
        <section>
          <div className="mb-2 text-2xs tracking-wide text-muted-soft">最近产物</div>
          <div className="space-y-1.5">
            {artifacts.map((a) => (
              <button
                key={a.path}
                onClick={() => window.api.artifacts.open(a.path)}
                title={a.name}
                className="flex w-full items-center gap-2.5 rounded-md border border-line bg-card px-3 py-2 text-left hover:bg-hover"
              >
                <FileIcon name={a.name} />
                <span className="min-w-0 flex-1 truncate text-base">{a.name}</span>
                <span className="shrink-0 text-xs text-muted">{shortTime(a.mtimeMs)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <div className="mb-2 text-2xs tracking-wide text-muted-soft">最近对话</div>
          <div className="space-y-1.5">
            {recent.map((c) => (
              <button
                key={c.id}
                onClick={() => onOpenConv(c)}
                title={c.title}
                className="flex w-full items-center gap-2.5 rounded-md border border-line bg-card px-3 py-2 text-left hover:bg-hover"
              >
                <MessageSquare size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-base">{c.title}</span>
                <span className="shrink-0 text-xs text-muted">{shortTime(c.updatedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function InputBox({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  wide,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop?: () => void
  streaming: boolean
  wide?: boolean
}) {
  // 高度跟随实际内容（含自动折行）：rows 按 \n 计数会漏掉软换行，长句折行时上一行被顶出视野
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 128) + 'px'
  }, [value])
  return (
    <div
      className={`flex min-h-input items-end gap-2 rounded-input border border-line bg-card px-3 py-2.5 transition-colors focus-within:border-accent ${
        wide ? 'w-full max-w-2xl' : ''
      }`}
    >
      {/* 附件入口：本次只占位，先把位置和视觉留出来 */}
      <button
        onClick={() => ui.toast('附件上传即将支持，先把文件拖进窗口即可入库')}
        title="添加附件（即将支持）"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink"
      >
        <Paperclip size={16} />
      </button>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onSend()
          }
        }}
        rows={1}
        placeholder='问你的库，或说"把XX做成PPT"…'
        className="max-h-32 flex-1 resize-none self-center overflow-y-auto bg-transparent py-1 text-md leading-6 outline-none"
      />
      {streaming ? (
        <button
          onClick={onStop}
          title="停止生成"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent text-accent hover:bg-accent-soft"
        >
          <Square size={12} fill="currentColor" />
        </button>
      ) : (
        <button
          onClick={onSend}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-solid hover:opacity-90"
          title="发送"
        >
          <ArrowUp size={16} />
        </button>
      )}
    </div>
  )
}

/**
 * 入库按钮三态（未入库 / 入库中 / 已入库 ✓）。
 * 「入库中」来自全局任务层，所以切页面再回来仍然是转圈的；
 * 「已入库」来自落盘表，重开应用也还在——这两条正是过去缺的反馈。
 */
function IngestButton({
  artifact,
  ingested,
  onDone,
  onOpenNote,
}: {
  artifact: ArtifactInfo
  ingested?: { at: number; noteRel?: string }
  onDone: () => void
  onOpenNote: (t: string) => void
}) {
  const task = useTask('ingest', artifact.path)
  const busy = task?.status === 'queued' || task?.status === 'running'
  const prev = useRef<TaskStatus | undefined>(undefined)
  useEffect(() => {
    const was = prev.current
    prev.current = task?.status
    if (was && was !== task?.status && task?.status === 'succeeded') onDone()
  }, [task?.status, onDone])

  if (busy) {
    return (
      <span
        data-testid="ingest-busy"
        className="flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-muted"
      >
        <Loader2 size={11} className="animate-spin" /> 入库中
      </span>
    )
  }
  if (ingested) {
    return (
      <button
        data-testid="ingest-done"
        title={ingested.noteRel ? `已入库 · 打开「${ingested.noteRel}」` : '已入库'}
        onClick={() => {
          if (!ingested.noteRel) return ui.toast('已入库（未找到对应笔记）')
          onOpenNote(ingested.noteRel.replace(/\.md$/, '').split('/').pop() ?? ingested.noteRel)
        }}
        className="flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-ok hover:bg-hover"
      >
        <Check size={11} /> 已入库
      </button>
    )
  }
  return (
    <button
      onClick={async () => {
        const r = await window.api.artifacts.ingest(artifact.path)
        if (r.ok) ui.toast('已送入投递箱，处理完成后可被 AI 检索')
        else ui.toast(r.error ?? '入库失败', 'error')
      }}
      className="rounded-full border border-line px-2.5 py-0.5 hover:bg-hover"
    >
      入库
    </button>
  )
}

function ArtifactPanel({ homeEmpty, onOpenNote }: { homeEmpty: boolean; onOpenNote: (t: string) => void }) {
  const [items, setItems] = useState<ArtifactInfo[]>([])
  // 「已入库」是持久化的（复合键 路径+内容哈希，主进程校验后给结论），重开应用照样认得
  const [ingested, setIngested] = useState<Record<string, { at: number; noteRel?: string }>>({})
  const refreshIngested = useCallback(() => {
    void window.api.artifacts.ingested().then(setIngested)
  }, [])
  const [fresh, setFresh] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null)
  const prefersOpen = (): boolean => localStorage.getItem('chat.artifacts') !== '0'
  const [open, setOpen] = useState(() => !homeEmpty && prefersOpen())

  // 首页（空态）默认收起，进了对话恢复用户上次的偏好；对话中新产物落地时下面会自动展开
  useEffect(() => {
    setOpen(homeEmpty ? false : prefersOpen())
  }, [homeEmpty])

  const setVisible = (v: boolean): void => {
    localStorage.setItem('chat.artifacts', v ? '1' : '0')
    setOpen(v)
  }

  const refresh = useCallback(() => {
    window.api.artifacts.list().then(setItems)
  }, [])

  useEffect(() => {
    refresh()
    refreshIngested()
    return window.api.artifacts.onCreated((a) => {
      setFresh(a.path)
      refresh()
      setVisible(true) // 新产物生成时自动弹出
    })
  }, [refresh, refreshIngested]) // eslint-disable-line react-hooks/exhaustive-deps

  if (items.length === 0) return null

  if (!open) {
    return (
      <button
        onClick={() => setVisible(true)}
        title="打开产物面板"
        className="absolute right-4 top-3 z-10 rounded-full border border-line bg-card px-3 py-1 text-sm text-muted hover:text-accent"
      >
        产物 {items.length}
      </button>
    )
  }

  return (
    <div className="slide-in-right flex w-artifact-panel shrink-0 flex-col border-l border-line">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="text-md font-medium">
          产物 <span className="text-xs font-normal text-muted">90_产物/</span>
        </div>
        <button onClick={() => setVisible(false)} title="关闭产物面板" className="rounded p-1 text-muted hover:text-accent">
          <X size={14} />
        </button>
      </div>
      {/* 无框列表：一行一个产物（图标 + 文件名 + 时间），靠行距和 hover 浅底分隔，
          和首页「最近产物」是同一种轻量观感——卡片的边框+阴影在窄侧栏里太重 */}
      <div className="flex-1 space-y-0.5 overflow-auto p-2">
        {items.map((a) => (
          <div
            key={a.path}
            className={`group rounded-md px-2 py-1.5 transition-colors ${
              fresh === a.path ? 'bg-accent-soft' : 'hover:bg-hover'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <FileIcon name={a.name} size={16} />
              <span className="min-w-0 flex-1 truncate text-base" title={a.name}>
                {a.name}
              </span>
              <span
                className="shrink-0 text-xs text-muted"
                title={
                  a.size > 1048576
                    ? `${(a.size / 1048576).toFixed(1)}MB`
                    : `${Math.max(1, Math.round(a.size / 1024))}KB`
                }
              >
                {shortTime(a.mtimeMs)}
              </span>
            </div>
            {/* 操作按钮只在 hover 时露出，静态时列表保持干净 */}
            <div className="ml-6 mt-1.5 hidden gap-2 text-sm group-hover:flex">
              <button
                onClick={() => window.api.artifacts.open(a.path)}
                className="rounded-full border border-line px-2.5 py-0.5 hover:bg-hover"
              >
                打开
              </button>
              <IngestButton
                artifact={a}
                ingested={ingested[a.path]}
                onDone={refreshIngested}
                onOpenNote={onOpenNote}
              />
              {a.name.endsWith('.md') && (
                <button
                  onClick={async () => setPreview({ path: a.path, text: await window.api.artifacts.readText(a.path) })}
                  className="rounded-full border border-line px-2.5 py-0.5 hover:bg-hover"
                >
                  预览
                </button>
              )}
            </div>
            {preview?.path === a.path && (
              <div className="ml-6 mt-2 max-h-60 overflow-auto rounded-md bg-sidebar p-2 text-sm">
                <FastMarkdown body={preview.text} onLink={() => void 0} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
