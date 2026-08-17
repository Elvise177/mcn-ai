import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

/**
 * 应用内交互组件体系——替代系统原生 prompt/alert/confirm（原生弹窗=廉价感头号来源）。
 * 用法：ui.confirm({...}) / ui.prompt({...}) / ui.toast(msg)；App 根部挂一次 <UiHost />
 */

type ConfirmOpts = { title: string; message?: string; danger?: boolean; okText?: string }
type PromptOpts = { title: string; placeholder?: string; initial?: string; okText?: string }
/** 多选一（>2 个出口）：编辑冲突的「覆盖 / 另存为副本 / 取消」就是它（设计 §5.2） */
type ChooseOption = { value: string; label: string; danger?: boolean; primary?: boolean }
type ChooseOpts = { title: string; message?: string; options: ChooseOption[] }
/** 光说"不行"等于把用户堵死在原地，得就地给出口（设计 §5.3） */
type ToastAction = { label: string; onClick: () => void }
type ToastItem = { id: number; msg: string; type: 'ok' | 'error'; action?: ToastAction }

type ModalState =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: 'choose'; opts: ChooseOpts; resolve: (v: string | null) => void }
  | null

let setModal: ((m: ModalState) => void) | null = null
let pushToast: ((t: Omit<ToastItem, 'id'>) => void) | null = null

export const ui = {
  confirm: (opts: ConfirmOpts): Promise<boolean> =>
    new Promise((resolve) => setModal?.({ kind: 'confirm', opts, resolve })),
  prompt: (opts: PromptOpts): Promise<string | null> =>
    new Promise((resolve) => setModal?.({ kind: 'prompt', opts, resolve })),
  /** 返回选中项的 value；关掉弹窗/点遮罩 = null */
  choose: (opts: ChooseOpts): Promise<string | null> =>
    new Promise((resolve) => setModal?.({ kind: 'choose', opts, resolve })),
  toast: (msg: string, type: 'ok' | 'error' = 'ok', action?: ToastAction): void =>
    pushToast?.({ msg, type, action }),
}

/** 同屏 toast 上限：再多就该用别的形式说话了 */
const MAX_TOASTS = 3

/**
 * 单条 toast 的生命周期（L-03）。倒计时放在这里而不是 pushToast 里，是为了
 * ① 鼠标悬停时暂停——长句 3.2 秒读不完，读到一半消失比不提示还气人；
 * ② 点击立刻关掉——用户已经看完了，不该被迫等它自己淡出。
 */
function ToastRow({ t, onClose }: { t: ToastItem; onClose: () => void }) {
  const [paused, setPaused] = useState(false)
  // 剩余时间跨暂停累计：悬停 → 移开之后接着走，而不是重新计时
  const left = useRef(t.action ? 8000 : 3200)

  useEffect(() => {
    if (paused) return
    const startedAt = Date.now()
    const timer = setTimeout(onClose, left.current)
    return () => {
      clearTimeout(timer)
      left.current = Math.max(0, left.current - (Date.now() - startedAt))
    }
  }, [paused, onClose])

  return (
    <div
      data-testid="toast"
      title="点击关闭"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={onClose}
      className={`fade-up pointer-events-auto flex cursor-pointer items-center gap-3 rounded-full px-4 py-2 text-base text-on-solid shadow-pop ${
        t.type === 'error' ? 'bg-danger' : 'bg-ink'
      }`}
    >
      <span>{t.msg}</span>
      {/* 动作按钮：拒绝一件事的同时给出出口（如「停止当前生成」） */}
      {t.action && (
        <button
          data-testid="toast-action"
          onClick={(e) => {
            e.stopPropagation() // 别让"点动作"顺带被当成"点关闭"
            t.action?.onClick()
            onClose()
          }}
          className="shrink-0 rounded-full border border-on-solid px-2.5 py-0.5 text-sm transition-opacity hover:opacity-80"
        >
          {t.action.label}
        </button>
      )}
    </div>
  )
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
      // 同屏最多 3 条（L-03）：连点几次「打开」之类的操作会一口气推十几条，
      // 糊满顶部之后连界面都看不见了。挤掉的是最老的那条
      setToasts((old) => [...old, { ...t, id }].slice(-MAX_TOASTS))
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
  /** 遮罩/✕ 的默认结果：confirm 是 false，prompt/choose 是 null（= 什么都不做） */
  const dismissed = (): boolean | null => (modal?.kind === 'confirm' ? false : null)

  return (
    <>
      {/* Toast */}
      <div className="pointer-events-none fixed left-1/2 top-4 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <ToastRow key={t.id} t={t} onClose={() => setToasts((old) => old.filter((x) => x.id !== t.id))} />
        ))}
      </div>

      {/* Modal */}
      {modal && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-overlay" onClick={() => close(dismissed())}>
          <div
            data-testid="modal"
            className={`fade-up rounded-xl border border-line bg-card p-6 shadow-pop ${
              modal.kind === 'choose' ? 'w-modal-wide' : 'w-modal'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between">
              <div className="text-lg font-semibold">{modal.opts.title}</div>
              <button onClick={() => close(dismissed())} className="rounded p-1 text-muted transition-colors hover:text-accent">
                <X size={15} />
              </button>
            </div>
            {(modal.kind === 'confirm' || modal.kind === 'choose') && modal.opts.message && (
              <div className="mb-4 whitespace-pre-line text-base leading-6 text-muted">{modal.opts.message}</div>
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
                className="mb-4 mt-2 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-md outline-none transition-colors focus:border-accent"
              />
            )}
            {modal.kind === 'choose' ? (
              // 多选一：主操作（primary）放最右并高亮——冲突弹窗里那是「另存为副本」，
              // 因为它是唯一零数据丢失的选项（设计 §5.2）
              <div className="flex flex-wrap justify-end gap-2">
                {modal.opts.options.map((o) => (
                  <button
                    key={o.value}
                    data-testid={`choose-${o.value}`}
                    data-primary={o.primary ? '1' : undefined}
                    autoFocus={o.primary}
                    onClick={() => close(o.value)}
                    className={
                      o.primary
                        ? 'rounded-full bg-accent px-4 py-1.5 text-base text-on-solid transition-opacity hover:opacity-90'
                        : `rounded-full border border-line px-4 py-1.5 text-base transition-colors hover:bg-hover ${
                            o.danger ? 'text-danger' : ''
                          }`
                    }
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => close(dismissed())}
                  className="rounded-full border border-line px-4 py-1.5 text-base transition-colors hover:bg-hover"
                >
                  取消
                </button>
                <button
                  onClick={() => close(modal.kind === 'confirm' ? true : text.trim() || null)}
                  className={`rounded-full px-4 py-1.5 text-base text-on-solid transition-opacity hover:opacity-90 ${
                    modal.kind === 'confirm' && modal.opts.danger ? 'bg-danger' : 'bg-accent'
                  }`}
                >
                  {modal.opts.okText ?? '确定'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
