import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

/**
 * 应用内交互组件体系——替代系统原生 prompt/alert/confirm（原生弹窗=廉价感头号来源）。
 * 用法：ui.confirm({...}) / ui.prompt({...}) / ui.toast(msg)；App 根部挂一次 <UiHost />
 */

type ConfirmOpts = { title: string; message?: string; danger?: boolean; okText?: string }
type PromptOpts = { title: string; placeholder?: string; initial?: string; okText?: string }
type ToastItem = { id: number; msg: string; type: 'ok' | 'error' }

type ModalState =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | null

let setModal: ((m: ModalState) => void) | null = null
let pushToast: ((t: Omit<ToastItem, 'id'>) => void) | null = null

export const ui = {
  confirm: (opts: ConfirmOpts): Promise<boolean> =>
    new Promise((resolve) => setModal?.({ kind: 'confirm', opts, resolve })),
  prompt: (opts: PromptOpts): Promise<string | null> =>
    new Promise((resolve) => setModal?.({ kind: 'prompt', opts, resolve })),
  toast: (msg: string, type: 'ok' | 'error' = 'ok'): void => pushToast?.({ msg, type }),
}

export function UiHost() {
  const [modal, _setModal] = useState<ModalState>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [text, setText] = useState('')
  const seq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setModal = (m) => {
      _setModal(m)
      if (m?.kind === 'prompt') {
        setText(m.opts.initial ?? '')
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    }
    pushToast = (t) => {
      const id = ++seq.current
      setToasts((old) => [...old, { ...t, id }])
      setTimeout(() => setToasts((old) => old.filter((x) => x.id !== id)), 3200)
    }
    return () => {
      setModal = null
      pushToast = null
    }
  }, [])

  const close = (result: boolean | string | null): void => {
    if (!modal) return
    if (modal.kind === 'confirm') modal.resolve(result as boolean)
    else modal.resolve(result as string | null)
    _setModal(null)
  }

  return (
    <>
      {/* Toast */}
      <div className="pointer-events-none fixed left-1/2 top-4 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`fade-up pointer-events-auto rounded-full px-4 py-2 text-[13px] text-white shadow-lg ${
              t.type === 'error' ? 'bg-red-500/95' : 'bg-ink/90'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>

      {/* Modal */}
      {modal && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/25" onClick={() => close(modal.kind === 'confirm' ? false : null)}>
          <div className="fade-up w-[380px] rounded-2xl border border-line bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[15px] font-semibold">{modal.opts.title}</div>
              <button onClick={() => close(modal.kind === 'confirm' ? false : null)} className="rounded p-1 text-muted transition-colors hover:text-rose">
                <X size={15} />
              </button>
            </div>
            {modal.kind === 'confirm' && modal.opts.message && (
              <div className="mb-4 text-[13px] leading-6 text-muted">{modal.opts.message}</div>
            )}
            {modal.kind === 'prompt' && (
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && text.trim()) close(text.trim())
                  if (e.key === 'Escape') close(null)
                }}
                placeholder={modal.opts.placeholder}
                className="mb-4 mt-2 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-sm outline-none transition-colors focus:border-rose"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => close(modal.kind === 'confirm' ? false : null)}
                className="rounded-full border border-line px-4 py-1.5 text-[13px] transition-colors hover:bg-black/[0.03]"
              >
                取消
              </button>
              <button
                onClick={() => close(modal.kind === 'confirm' ? true : text.trim() || null)}
                className={`rounded-full px-4 py-1.5 text-[13px] text-white transition-opacity hover:opacity-90 ${
                  modal.kind === 'confirm' && modal.opts.danger ? 'bg-red-500' : 'bg-rose'
                }`}
              >
                {modal.opts.okText ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
