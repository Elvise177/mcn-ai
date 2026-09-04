import { useEffect, useState } from 'react'
import { FilePen, ShieldAlert } from 'lucide-react'

/**
 * AI 要修改知识库文件时的确认卡（B4，2026-08-19）。
 *
 * **为什么要有它**：原来 AI 一律不许改库内文件，用户让它改自己的笔记只能得到
 * 「环境限制文件写入」——对客户就是产品残疾。放开的前提是**每次都问**：
 * 用户看得见改的是哪个文件、大概动了多少，点了才写。
 *
 * 三条刻意的取向：
 * ① **默认焦点在「不允许」**，回车不会误放行；Esc 也等于不允许
 * ② **不显示新内容全文**——模型一次可能写几千字，弹窗里滚不完也看不懂；
 *    用户真正要判断的是"改哪个文件、新建还是改写、动了多少"
 * ③ **60 秒不理，主进程默认拒**（超时逻辑在主进程，这里只负责显示倒计时）
 *
 * 硬禁区（`.mcnai/`、`.checkpoint.jsonl`、`00_投递箱/.done/` 等）**根本走不到这里**——
 * 主进程 `write-guard.ts` 直接拒，弹都不弹。用户点不到 = 不可能被诱导点同意。
 */
export function WriteConfirm() {
  const [req, setReq] = useState<{ id: string; rel: string; tool: string; summary: string } | null>(null)
  const [left, setLeft] = useState(60)

  useEffect(() => window.api.chat.onConfirmWrite((r) => {
    setReq(r as { id: string; rel: string; tool: string; summary: string })
    setLeft(60)
  }), [])

  useEffect(() => {
    if (!req) return
    const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000)
    return () => clearInterval(t)
  }, [req])

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') answer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req])

  const answer = (allow: boolean, scope?: 'once' | 'session'): void => {
    if (!req) return
    void window.api.chat.confirmWrite(req.id, allow, scope)
    setReq(null)
  }

  /** 这次要改的是哪个目录（F24 的「本会话此目录不再问」放开的就是它） */
  const dir = req?.rel.includes('/') ? req.rel.slice(0, req.rel.lastIndexOf('/')) : '知识库根目录'

  if (!req) return null
  return (
    <div data-testid="write-confirm" className="fixed inset-0 z-[80] flex items-center justify-center bg-overlay">
      <div className="w-[440px] rounded-xl border border-line bg-card p-5 shadow-lg">
        <div className="flex items-center gap-2 text-base font-semibold text-ink">
          <FilePen size={16} className="text-accent" />
          AI 想修改你知识库里的文件
        </div>
        <div className="mt-3 rounded-lg bg-surface px-3 py-2.5">
          <div data-testid="write-confirm-path" className="break-all font-mono text-sm text-ink">
            {req.rel}
          </div>
          <div className="mt-1.5 text-sm text-muted">{req.summary}</div>
        </div>
        <div className="mt-3 flex items-start gap-1.5 text-xs text-muted">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          <span>允许后会先备份原文，改完可以一键撤销。{left} 秒内不选择将自动取消。</span>
        </div>
        {/*
          F24 三档。中间那颗是这一版新加的：**它放开的是"打断"，不是"可追溯"**——
          点了之后同一个目录不再弹卡，但备份与撤销 toast 照旧。
          范围**收在目录这一级**，不给"整个库不再问"：库根一放开，这道确认就等于没有。
          HANDOFF 里这条原来记的是「故意不做」，理由是没有安全的记忆位置；
          现在位置有了（主进程内存 + 按会话 + 按目录），重启即失效。
        */}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            data-testid="write-deny"
            autoFocus
            onClick={() => answer(false)}
            className="rounded-full border border-line px-4 py-1.5 text-sm hover:bg-hover"
          >
            不允许
          </button>
          <button
            data-testid="write-allow-session"
            title={`之后 AI 再改「${dir}」里的文件就不再弹这张卡（本次运行有效，重启即失效）`}
            onClick={() => answer(true, 'session')}
            className="rounded-full border border-line px-4 py-1.5 text-sm hover:bg-hover"
          >
            允许，且此目录不再问
          </button>
          <button
            data-testid="write-allow"
            onClick={() => answer(true, 'once')}
            className="rounded-full bg-accent px-4 py-1.5 text-sm text-white hover:opacity-90"
          >
            允许修改
          </button>
        </div>
      </div>
    </div>
  )
}
