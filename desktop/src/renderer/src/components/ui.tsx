import { useEffect, useRef, useState } from 'react'
import { X, CheckCircle2, XCircle, AlertTriangle, Loader2 } from 'lucide-react'

/**
 * 应用内交互组件体系——替代系统原生 prompt/alert/confirm（原生弹窗=廉价感头号来源）。
 * 用法：ui.confirm({...}) / ui.prompt({...}) / ui.toast(msg)；App 根部挂一次 <UiHost />
 */

type ConfirmOpts = { title: string; message?: string; danger?: boolean; okText?: string; cancelText?: string }
type PromptOpts = { title: string; placeholder?: string; initial?: string; okText?: string }
/** 多选一（>2 个出口）：编辑冲突的「覆盖 / 另存为副本 / 取消」就是它（设计 §5.2） */
type ChooseOption = { value: string; label: string; danger?: boolean; primary?: boolean }
type ChooseOpts = { title: string; message?: string; options: ChooseOption[] }
/** 光说"不行"等于把用户堵死在原地，得就地给出口（设计 §5.3） */
type ToastAction = { label: string; onClick: () => void }
/**
 * toast 的语义（见 `docs/DESIGN-color-semantics.md`）。
 * **底色永远是炭黑，语义只由左侧图标表达**（三期重构，理由见 TOAST_BOX 上面那段）：
 *   info    无图标 —— **默认**。告知一件事发生了：已删除、已复制、已进入运维模式。
 *                     "解锁成功"这类也归这里：**解锁是告知，不是任务成功**
 *   ok      绿勾   —— 用户发起的操作真的完成了（保存落盘、入库完成）
 *   error   红叉   —— 失败，需要用户处理
 *   warn    金琥珀叹号 —— 做完了但有折损、或没东西可做，比 error 轻一档
 *   running 橙转圈 —— 进行中（瞬时提示里很少用；持续进行中该用状态条而不是 toast）
 */
export type ToastKind = 'info' | 'ok' | 'error' | 'warn' | 'running'
type ToastItem = { id: number; msg: string; type: ToastKind; action?: ToastAction }

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
  toast: (msg: string, type: ToastKind = 'info', action?: ToastAction): void =>
    pushToast?.({ msg, type, action }),
}

/** 同屏 toast 上限：再多就该用别的形式说话了 */
const MAX_TOASTS = 3

/**
 * **一种底色，语义靠图标**（2026-08-18 三期重构，推翻了"整条变底色"那版）。
 *
 * 上一版按语义整条铺底：三条琥珀「未发现可入库的文件」堆在一起是三条大黄横幅，
 * 刺眼且抢戏——瞬时提示本来就不该占据这么强的视觉权重。
 * 现在全部炭黑底，成功/错误/警告只由**左侧图标**表达（信息类干脆没有图标）。
 * 语义底色只留给**持续性状态条**（云端降级条橙、编辑冲突条浅金、错误气泡红边）——
 * 那些是"一直在的状态"，值得一直占着颜色；toast 是"说一声就走"。
 *
 * **几何只有这一份**：圆角/字号/内边距/间距全在这一行。宽度改为**按文案自适应 + 上限**，
 * 短文案短框（`max-w-toast`，不再是写死的等宽）；走查比的是"同宽度策略 + 同圆角字号内边距"。
 */
const TOAST_BOX =
  'fade-up pointer-events-auto flex max-w-toast cursor-pointer items-start gap-2.5 rounded-lg bg-ink px-4 py-2.5 text-left text-base leading-5 text-on-solid shadow-pop'
/** 动作按钮：描边胶囊，永远在文案右侧，间距节奏与图标一致（gap-2.5） */
const TOAST_ACTION =
  'shrink-0 rounded-full border border-on-solid px-2.5 py-0.5 text-sm transition-opacity hover:opacity-80'
/** 语义图标：颜色是**图标自己的**，底色始终炭黑。info 没有图标——它不需要被"标记" */
const TOAST_ICON: Record<ToastKind, { Icon: typeof CheckCircle2; cls: string } | null> = {
  info: null,
  ok: { Icon: CheckCircle2, cls: 'text-ok' },
  error: { Icon: XCircle, cls: 'text-danger' },
  warn: { Icon: AlertTriangle, cls: 'text-warning' },
  running: { Icon: Loader2, cls: 'text-accent animate-spin' },
}

/**
 * 单条 toast 的生命周期（L-03）。倒计时放在这里而不是 pushToast 里，是为了
 * ① 鼠标悬停时暂停——长句 3.2 秒读不完，读到一半消失比不提示还气人；
 * ② 点击立刻关掉——用户已经看完了，不该被迫等它自己淡出。
 */
function ToastRow({ t, onClose }: { t: ToastItem; onClose: () => void }) {
  const [paused, setPaused] = useState(false)
  const icon = TOAST_ICON[t.type]
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
      data-kind={t.type}
      data-icon={icon ? t.type : 'none'}
      title="点击关闭"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={onClose}
      className={TOAST_BOX}
    >
      {/* 语义图标在最左；info 不给图标（"已删除""已复制"不需要被标记成一件事） */}
      {icon && <icon.Icon size={15} className={`mt-px shrink-0 ${icon.cls}`} />}
      {/* 文字左对齐、按内容自适应宽度（上限 max-w-toast），长文案自己折行 */}
      <span className="min-w-0 flex-1">{t.msg}</span>
      {/* 动作按钮：拒绝一件事的同时给出出口（如「停止当前生成」「在 Finder 中显示」）。
          **描边按钮，不随语义换样式**——红底 toast 上的按钮以前看着像另一套控件 */}
      {t.action && (
        <button
          data-testid="toast-action"
          onClick={(e) => {
            e.stopPropagation() // 别让"点动作"顺带被当成"点关闭"
            t.action?.onClick()
            onClose()
          }}
          className={TOAST_ACTION}
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
      {/*
        落点在**标题/操作栏以下**（top-14），不是贴着窗口顶。
        原因是实测踩到的：toast 统一成固定宽度之后，它在窗口顶端横跨的范围变宽，
        正好压住笔记头部那排按钮（「编辑/保存/…」）——而 toast 悬停会暂停倒计时，
        于是鼠标往那颗按钮移过去的路上就把它自己钉死了，按钮永远点不到
        （2026-08-18 走查现场：`编辑` 点击 30 秒超时，报 toast intercepts pointer events）。
        往下挪 56px 之后它压的是正文区，不再挡任何常驻控件。
      */}
      <div className="pointer-events-none fixed left-1/2 top-14 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
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
                  {(modal.kind === 'confirm' && modal.opts.cancelText) || '取消'}
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
