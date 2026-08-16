import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, Copy, Loader2, X, Paperclip, MessageSquare } from 'lucide-react'
import { FastMarkdown } from '../components/Markdown'
import { FileIcon } from '../components/FileIcon'
import { ui } from '../components/ui'
import { CHIPS } from '../config/chips'
import { greetingLine } from '../lib/profile'

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
  onSend: (text: string) => void
  onOpenNote: (wikiTarget: string) => void
  nickname?: string
  recentConvs: Conversation[]
  onOpenConv: (c: Conversation) => void
}) {
  // 消息以 conv prop 为准（App 统一持久化）；这里只管流式草稿/工具行/输入框
  const messages = conv.messages
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [toolLine, setToolLine] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const convRef = useRef(conv)
  convRef.current = conv

  useEffect(() => {
    setInput('')
    setDraft('')
    setToolLine(null)
    setStreaming(false)
  }, [conv.id])

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
        setStreaming(false)
        setToolLine(null)
      }
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, draft, toolLine])

  const send = useCallback(
    (text: string) => {
      const t = text.trim()
      if (!t || streaming) return
      setInput('')
      setStreaming(true)
      setDraft('')
      onSend(t)
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

  return (
    <div className="relative flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {empty ? (
          // 问候区落在视口上方 1/3（--home-top），下面依次是输入框、快捷指令、最近卡片区
          <div className="flex flex-1 flex-col items-center overflow-auto px-8 pb-10 pt-home-top">
            <h1 className="fade-up mb-2 font-serif text-display leading-tight">{greetingLine(nickname)}</h1>
            <p className="mb-8 text-md text-muted">问你的库，或直接说要做什么</p>
            <InputBox value={input} onChange={setInput} onSend={() => send(input)} streaming={false} wide />
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
                  onSend={() => send(input)}
                  onStop={() => window.api.chat.stop(convRef.current.id)}
                  streaming={streaming}
                />
              </div>
            </div>
          </>
        )}
      </div>
      <ArtifactPanel />
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

function ArtifactPanel() {
  const [items, setItems] = useState<ArtifactInfo[]>([])
  const [fresh, setFresh] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null)
  const [open, setOpen] = useState(() => localStorage.getItem('chat.artifacts') !== '0')

  const setVisible = (v: boolean): void => {
    localStorage.setItem('chat.artifacts', v ? '1' : '0')
    setOpen(v)
  }

  const refresh = useCallback(() => {
    window.api.artifacts.list().then(setItems)
  }, [])

  useEffect(() => {
    refresh()
    return window.api.artifacts.onCreated((a) => {
      setFresh(a.path)
      refresh()
      setVisible(true) // 新产物生成时自动弹出
    })
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps

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
      <div className="flex-1 space-y-2 overflow-auto p-3">
        {items.map((a) => (
          <div
            key={a.path}
            className={`group rounded-lg border p-3 transition-colors ${
              fresh === a.path ? 'border-accent bg-accent-soft' : 'border-line bg-card hover:border-accent-line'
            }`}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5">
                <FileIcon name={a.name} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium" title={a.name}>
                  {a.name}
                </div>
                <div className="text-xs text-muted">
                  {shortTime(a.mtimeMs)}
                  {' · '}
                  {a.size > 1048576 ? `${(a.size / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(a.size / 1024))}KB`}
                </div>
              </div>
            </div>
            {/* 操作按钮只在 hover 时露出，静态时卡片保持干净 */}
            <div className="mt-2 hidden gap-2 text-sm group-hover:flex">
              <button
                onClick={() => window.api.artifacts.open(a.path)}
                className="rounded-full border border-line px-2.5 py-0.5 hover:bg-hover"
              >
                打开
              </button>
              <button
                onClick={async () => {
                  const s = await window.api.settings.get()
                  if (!s.vaultPath) return ui.toast('请先打开知识库', 'error')
                  await window.api.inbox.enqueue([s.vaultPath + '/90_产物/' + a.path])
                  ui.toast('已送入投递箱，处理完成后可被 AI 检索')
                }}
                className="rounded-full border border-line px-2.5 py-0.5 hover:bg-hover"
              >
                入库
              </button>
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
              <div className="mt-2 max-h-60 overflow-auto rounded-md bg-bg p-2 text-sm">
                <FastMarkdown body={preview.text} onLink={() => void 0} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
