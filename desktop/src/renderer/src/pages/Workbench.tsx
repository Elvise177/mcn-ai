import { useCallback, useEffect, useRef, useState } from 'react'
import { FastMarkdown } from '../components/Markdown'

const CHIPS = ['写种草脚本', '做课件 PPT', '生成周报', '达人复盘', '检索我的库']

const TOOL_ZH: Record<string, string> = {
  search_knowledge: '检索知识库',
  render_pptx: '渲染 PPT',
  render_document: '渲染文档',
  Read: '读取笔记',
  Grep: '全文查找',
  Glob: '定位文件',
  Write: '写入产物',
}

export default function Workbench({
  conv,
  onConvUpdate,
  onOpenNote,
}: {
  conv: Conversation
  onConvUpdate: (c: Conversation) => void
  onOpenNote: (wikiTarget: string) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(conv.messages)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [toolLine, setToolLine] = useState<string | null>(null)
  const sdkSession = useRef<string | undefined>(conv.sdkSessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const convRef = useRef(conv)
  convRef.current = conv

  useEffect(() => {
    setMessages(conv.messages)
    sdkSession.current = conv.sdkSessionId
    setDraft('')
    setStreaming(false)
  }, [conv.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return window.api.chat.onStream((p) => {
      if (p.sessionId !== convRef.current.id) return
      if (p.kind === 'delta' && p.text) {
        setDraft((d) => d + p.text)
        setToolLine(null)
      } else if (p.kind === 'tool' && p.tool) {
        const short = p.tool.replace(/^mcp__\w+__/, '')
        setToolLine(TOOL_ZH[short] ?? short)
      } else if (p.kind === 'assistant' && p.text != null) {
        if (p.sdkSessionId) sdkSession.current = p.sdkSessionId
        setMessages((ms) => {
          const next: ChatMessage[] = [...ms, { role: 'assistant' as const, text: p.text! }]
          const updated: Conversation = {
            ...convRef.current,
            messages: next,
            sdkSessionId: sdkSession.current,
            title: convRef.current.title === '新对话' && next[0] ? next[0].text.slice(0, 18) : convRef.current.title,
            updatedAt: Date.now(),
          }
          window.api.chat.save(updated)
          onConvUpdate(updated)
          return next
        })
        setDraft('')
      } else if (p.kind === 'done') {
        if (p.sdkSessionId) sdkSession.current = p.sdkSessionId
        setStreaming(false)
        setToolLine(null)
      } else if (p.kind === 'error') {
        setMessages((ms) => [...ms, { role: 'assistant', text: `⚠️ ${p.text}` }])
        setDraft('')
        setStreaming(false)
        setToolLine(null)
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, draft, toolLine])

  const send = useCallback(
    (text: string) => {
      const t = text.trim()
      if (!t || streaming) return
      setMessages((ms) => [...ms, { role: 'user', text: t }])
      setInput('')
      setStreaming(true)
      setDraft('')
      window.api.chat.send(convRef.current.id, t, sdkSession.current)
    },
    [streaming]
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
          <div className="flex flex-1 flex-col items-center justify-center px-8">
            <h1 className="mb-2 font-serif text-4xl">你好，大头</h1>
            <p className="mb-8 text-sm text-muted">问你的库，或直接说要做什么</p>
            <InputBox value={input} onChange={setInput} onSend={() => send(input)} streaming={false} wide />
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {CHIPS.map((c) => (
                <button
                  key={c}
                  onClick={() => setInput(c + '：')}
                  className="rounded-full border border-line bg-card px-3.5 py-1.5 text-[13px] hover:bg-rose-soft"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 overflow-auto px-8 py-6">
              <div className="mx-auto max-w-3xl space-y-5">
                {messages.map((m, i) =>
                  m.role === 'user' ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[80%] rounded-2xl bg-sidebar px-4 py-2.5 text-[14px]">{m.text}</div>
                    </div>
                  ) : (
                    <div key={i} className="group flex gap-3">
                      <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-rose" />
                      <div className="min-w-0 flex-1">
                        <FastMarkdown body={m.text} onLink={handleLink} />
                        <button
                          onClick={() => navigator.clipboard.writeText(m.text)}
                          className="mt-1 hidden rounded-full border border-line px-2.5 py-0.5 text-[11px] text-muted hover:text-rose group-hover:inline-block"
                        >
                          复制
                        </button>
                      </div>
                    </div>
                  )
                )}
                {(draft || toolLine) && (
                  <div className="flex gap-3">
                    <span className="mt-2 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-rose" />
                    <div className="min-w-0 flex-1">
                      {toolLine && <div className="mb-1 text-[12px] text-muted">⚙ {toolLine}…</div>}
                      {draft && <FastMarkdown body={draft} onLink={handleLink} />}
                    </div>
                  </div>
                )}
                {streaming && !draft && !toolLine && <div className="text-[12px] text-muted">思考中…</div>}
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
  return (
    <div className={`flex items-end gap-2 rounded-2xl border-2 border-line bg-card px-4 py-3 focus-within:border-rose ${wide ? 'w-full max-w-2xl' : ''}`}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onSend()
          }
        }}
        rows={Math.min(4, value.split('\n').length)}
        placeholder='问你的库，或说"把XX做成PPT"…'
        className="max-h-32 flex-1 resize-none bg-transparent text-[14px] leading-6 outline-none"
      />
      {streaming ? (
        <button onClick={onStop} className="rounded-full border border-rose px-3 py-1 text-[12px] text-rose hover:bg-rose-soft">
          停止
        </button>
      ) : (
        <button
          onClick={onSend}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-rose text-white hover:opacity-90"
          title="发送"
        >
          ↑
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
        className="absolute right-4 top-3 z-10 rounded-full border border-line bg-card px-3 py-1 text-[12px] text-muted hover:text-rose"
      >
        产物 {items.length}
      </button>
    )
  }

  return (
    <div className="flex w-[300px] shrink-0 flex-col border-l border-line">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="text-sm font-medium">
          产物 <span className="text-[11px] font-normal text-muted">90_产物/</span>
        </div>
        <button onClick={() => setVisible(false)} title="关闭产物面板" className="rounded px-1.5 text-muted hover:text-rose">
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {items.map((a) => (
          <div
            key={a.path}
            className={`rounded-xl border p-3 ${fresh === a.path ? 'border-rose bg-rose-soft' : 'border-line bg-card'}`}
          >
            <div className="truncate text-[13px] font-medium">{a.name}</div>
            <div className="mb-2 text-[11px] text-muted">
              {new Date(a.mtimeMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {' · '}
              {a.size > 1048576 ? `${(a.size / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(a.size / 1024))}KB`}
            </div>
            <div className="flex gap-2 text-[12px]">
              <button onClick={() => window.api.artifacts.open(a.path)} className="rounded-full border border-line px-2.5 py-0.5 hover:bg-rose-soft">
                打开
              </button>
              {a.name.endsWith('.md') && (
                <button
                  onClick={async () => setPreview({ path: a.path, text: await window.api.artifacts.readText(a.path) })}
                  className="rounded-full border border-line px-2.5 py-0.5 hover:bg-rose-soft"
                >
                  预览
                </button>
              )}
            </div>
            {preview?.path === a.path && (
              <div className="mt-2 max-h-60 overflow-auto rounded-lg bg-bg p-2 text-[12px]">
                <FastMarkdown body={preview.text} onLink={() => void 0} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
