import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, Sparkles } from 'lucide-react'

/**
 * 会话级模型档位选择器（位置与形态参照 Claude Desktop 的模型选择器）。
 *
 * **它在输入框的下沿控制条上，不在输入框里面**——输入框内部只放附件位与发送键，
 * 塞进去会挤掉正文的横向空间，而且档位是"这一轮怎么跑"的元信息，不是输入内容的一部分。
 *
 * 形态是低调的文字胶囊「标准 ⌄」：无边框、弱色，点开**向上**弹菜单，
 * 每一档下面一行灰色小字说明消耗差异。**说明写在菜单里而不是 tooltip 上**——
 * 消耗差几十倍这种事，得让人在"选之前"看见，而不是悬停两秒才看见。
 *
 * **界面上不出现供应商名与模型名**：用户要判断的是"这次值不值得多花钱"，
 * 不是"这条线路后面挂的是谁"。线路地址与模型串是运维配置，只在管理员区露出。
 *
 * 可用性来自主进程的轻量探测（结果缓存 5 分钟，见 main/ai/health.ts）：
 * 不可用的档位**置灰不让选**，而不是让人选了之后在发送时才撞一鼻子灰。
 */
export function TierSelector({
  value,
  onChange,
  disabled,
}: {
  value: TierId
  onChange: (t: TierId) => void
  /** 生成中不让改档：这一轮已经发出去了，改了也只对下一轮生效，反而误导 */
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [tiers, setTiers] = useState<AiTier[]>([])
  const [health, setHealth] = useState<Record<string, TierHealth>>({})
  const boxRef = useRef<HTMLDivElement>(null)

  // 探测走主进程的 5 分钟缓存：挂载与展开各问一次，实际发出去的请求远少于问的次数
  const probe = useCallback((): void => {
    void window.api.ai.tierHealth('enhanced').then((h) => setHealth((old) => ({ ...old, enhanced: h })))
  }, [])

  useEffect(() => {
    void window.api.ai.tiers().then((r) => setTiers(r.tiers))
    probe()
  }, [probe])

  useEffect(() => {
    if (!open) return
    probe()
    const onDoc = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, probe])

  const available = (id: TierId): boolean => (id === 'standard' ? true : health[id]?.ok !== false)
  const current = tiers.find((t) => t.id === value) ?? tiers.find((t) => t.id === 'standard')
  const enhancedDown = health.enhanced && !health.enhanced.ok
  // 按钮上只留短名：「标准（推荐）」在控制条上太长，推荐二字的信息量也只对第一次选择有用
  const shortLabel = (current?.label ?? '标准').replace(/（.*?）/g, '')

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        data-testid="tier-selector"
        data-tier={value}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors disabled:opacity-50 ${
          value === 'enhanced' ? 'text-accent hover:bg-accent-soft' : 'text-muted hover:bg-hover hover:text-ink'
        }`}
      >
        {value === 'enhanced' && <Sparkles size={12} />}
        {shortLabel}
        <ChevronDown size={12} />
      </button>

      {open && (
        <div
          data-testid="tier-menu"
          className="fade-up absolute bottom-full right-0 z-40 mb-2 w-72 rounded-lg border border-line bg-card p-1 shadow-pop"
        >
          {tiers.map((t) => {
            const ok = available(t.id)
            return (
              <button
                key={t.id}
                data-testid={`tier-option-${t.id}`}
                data-available={ok ? '1' : '0'}
                disabled={!ok}
                onClick={() => {
                  onChange(t.id)
                  setOpen(false)
                }}
                className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                  ok ? 'hover:bg-hover' : 'cursor-not-allowed opacity-45'
                }`}
              >
                <span className="mt-0.5 w-3.5 shrink-0">
                  {t.id === value && <Check size={13} className="text-accent" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-base font-medium">
                    {t.label}
                    {!ok && <span className="text-xs font-normal text-warn">暂时不可用</span>}
                  </span>
                  {/* 消耗差异就写在这一行灰色小字里 */}
                  <span className="mt-0.5 block text-sm leading-5 text-muted">{t.blurb}</span>
                </span>
              </button>
            )
          })}
          {enhancedDown && (
            <div className="px-2.5 pb-1.5 pt-1 text-xs leading-4 text-muted">
              {health.enhanced?.reason ?? '线路暂时连不上'}——标准模式不受影响，可正常使用。
            </div>
          )}
        </div>
      )}
    </div>
  )
}
