import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, FileText, CornerDownLeft, Command } from 'lucide-react'
import { matchConversations } from '../lib/conversations'

/**
 * 命令面板（F5 + F8 合并成的这一颗）。
 *
 * ## 为什么是一个入口而不是三个控件
 *
 * 阶段一的清单里「侧栏搜索对话」「全局搜笔记」「常用命令」是三件事，
 * 阶段二对照 Claude Desktop 之后并成一个 Cmd+K：**少做两个控件，用户也少记两个位置**。
 * 敲什么就搜什么——对话、笔记、命令同屏出结果，回车执行第一条。
 *
 * ## 三条取向
 *
 * ① **命令常驻在最上面**：搜索是渐进的，而「新对话」这类命令是用户带着目的来的，
 *    让它随搜索结果上下跳会点不中
 * ② **笔记检索是异步的**（要问主进程），所以它单独一段、带自己的"检索中"，
 *    不阻塞对话与命令那两段先出来
 * ③ **键盘全通**：↑↓ 选、回车执行、Esc 关。鼠标只是备选——
 *    Cmd+K 这种键位的用户本来就不打算把手挪到鼠标上
 */

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface NoteHit {
  path: string
  title: string
  snippet: string
}

type Row =
  | { kind: 'command'; key: string; label: string; hint?: string; run: () => void }
  | { kind: 'conv'; key: string; label: string; hint?: string; run: () => void }
  | { kind: 'note'; key: string; label: string; hint?: string; run: () => void }

export function CommandPalette({
  open,
  onClose,
  convs,
  commands,
  onOpenConv,
  onOpenNote,
}: {
  open: boolean
  onClose: () => void
  convs: Conversation[]
  commands: PaletteCommand[]
  onOpenConv: (c: Conversation) => void
  onOpenNote: (relPath: string) => void
}) {
  const [q, setQ] = useState('')
  const [notes, setNotes] = useState<NoteHit[]>([])
  const [searching, setSearching] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 每次打开都从干净状态开始：留着上次的关键词，等于替用户做了一个他没做的决定
  useEffect(() => {
    if (!open) return
    setQ('')
    setNotes([])
    setCursor(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  /**
   * 笔记检索**去抖 200ms**：这条要过 IPC 打到主进程的全文索引上，
   * 每敲一个字打一次，长关键词就是十几次无用查询。
   */
  useEffect(() => {
    if (!open) return
    const needle = q.trim()
    if (needle.length < 2) {
      setNotes([])
      setSearching(false)
      return
    }
    setSearching(true)
    let alive = true
    const t = setTimeout(async () => {
      try {
        const r = await window.api.vault.search(needle)
        if (alive) setNotes(r.hits.slice(0, 6).map((h) => ({ path: h.path, title: h.title, snippet: h.snippet })))
      } catch {
        if (alive) setNotes([]) // 没开库 / 索引没就绪：这一段空着就好，别把整个面板搞成错误态
      } finally {
        if (alive) setSearching(false)
      }
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, open])

  const rows: Row[] = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const cmdRows: Row[] = commands
      .filter((c) => !needle || c.label.toLowerCase().includes(needle))
      .map((c) => ({ kind: 'command', key: `cmd:${c.id}`, label: c.label, hint: c.hint, run: c.run }))
    const convRows: Row[] = matchConversations(convs, q, 6).map(({ conv, snippet }) => ({
      kind: 'conv',
      key: `conv:${conv.id}`,
      label: conv.title,
      hint: snippet,
      run: () => onOpenConv(conv),
    }))
    const noteRows: Row[] = notes.map((n) => ({
      kind: 'note',
      key: `note:${n.path}`,
      label: n.title,
      hint: n.snippet,
      run: () => onOpenNote(n.path),
    }))
    return [...cmdRows, ...convRows, ...noteRows]
  }, [q, commands, convs, notes, onOpenConv, onOpenNote])

  // 结果变了就把光标收回第一条：停在第 5 行而列表只剩 2 行的话，回车什么都不会发生
  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))), [rows.length])

  const exec = useCallback(
    (r?: Row) => {
      if (!r) return
      onClose()
      r.run()
    },
    [onClose]
  )

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') return onClose()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (rows.length ? (c + 1) % rows.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (rows.length ? (c - 1 + rows.length) % rows.length : 0))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      exec(rows[cursor])
    }
  }

  // 选中项滚进视野：键盘往下走到第 12 条时，看不见等于没选
  useEffect(() => {
    listRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, rows.length])

  if (!open) return null

  const SECTION: Record<Row['kind'], string> = { command: '命令', conv: '对话', note: '笔记' }
  let lastKind: Row['kind'] | null = null

  return (
    <div
      data-testid="palette-overlay"
      className="fixed inset-0 z-[95] flex items-start justify-center bg-overlay pt-24"
      onClick={onClose}
    >
      <div
        data-testid="command-palette"
        onClick={(e) => e.stopPropagation()}
        className="fade-up flex max-h-96 w-modal-wide flex-col overflow-hidden rounded-xl border border-line bg-card shadow-modal"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Command size={14} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            data-testid="palette-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="搜对话、搜笔记，或输入一个命令…"
            className="min-w-0 flex-1 bg-transparent text-md outline-none"
          />
          {searching && <span className="shrink-0 text-xs text-muted">检索中…</span>}
        </div>
        <div ref={listRef} data-testid="palette-list" className="min-h-0 flex-1 overflow-auto py-1">
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted">
              没有匹配的对话、笔记或命令
            </div>
          ) : (
            rows.map((r, i) => {
              const head = r.kind !== lastKind ? SECTION[r.kind] : null
              lastKind = r.kind
              return (
                <div key={r.key}>
                  {head && <div className="px-4 pb-1 pt-2 text-2xs tracking-wide text-muted-soft">{head}</div>}
                  <button
                    data-testid={`palette-row-${r.kind}`}
                    data-active={i === cursor ? '1' : ''}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => exec(r)}
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left ${
                      i === cursor ? 'bg-accent-soft' : 'hover:bg-hover'
                    }`}
                  >
                    <span className="shrink-0 text-muted">
                      {r.kind === 'conv' ? (
                        <MessageSquare size={14} />
                      ) : r.kind === 'note' ? (
                        <FileText size={14} />
                      ) : (
                        <CornerDownLeft size={14} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base">{r.label}</span>
                      {r.hint && <span className="block truncate text-sm text-muted">{r.hint}</span>}
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </div>
        <div className="border-t border-line px-4 py-1.5 text-2xs text-muted-soft">
          ↑↓ 选择 · Enter 打开 · Esc 关闭
        </div>
      </div>
    </div>
  )
}
