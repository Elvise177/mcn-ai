import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ui } from './ui'
import { errText } from '../lib/err'

/** 建库引导（两分支）：首跑 onboarding 与知识库页共用 */
export function VaultWizard({
  onReady,
  onSkip,
  skipLabel = '暂时跳过，之后可在「个人知识库」里建',
}: {
  onReady: (v: { path: string; noteCount: number }) => void
  onSkip?: () => void
  /** 换库入口复用本组件，退出口的文案不是「跳过」而是「返回当前库」 */
  skipLabel?: string
}) {
  // 哪张卡在忙（不是单纯的 boolean）：忙态文案要贴着被点的那张卡说话
  const [busy, setBusy] = useState<'create' | 'existing' | null>(null)
  /**
   * H-12：以前 `pick()` 既没有 try 也没有 finally——`vault:createNew` 一抛错，
   * `setBusy(false)` 就永远不会执行，两张卡片半透明不可点、也没有任何报错，只能重启应用。
   */
  const pick = async (create: boolean): Promise<void> => {
    setBusy(create ? 'create' : 'existing')
    try {
      const v = create ? await window.api.vault.createNew() : await window.api.vault.pickExisting()
      // v === null = 用户在 Finder 选择框点了取消，不是错误，安静回到可点状态
      if (v) onReady(v)
    } catch (e) {
      ui.toast(`${create ? '新建库' : '打开库'}失败：${errText(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }
  /** 大库首次索引要扫全盘，几十秒很正常——不给文案就会被当成卡死而反复点 */
  const cardBody = (mine: 'create' | 'existing', title: string, desc: string): JSX.Element =>
    busy === mine ? (
      <>
        <div className="mb-1 flex items-center gap-1.5 font-medium text-accent">
          <Loader2 size={14} className="animate-spin" />
          {mine === 'create' ? '正在创建/索引…' : '正在打开/索引…'}
        </div>
        <div className="text-sm text-muted">大库首次索引可能要几十秒，请稍候</div>
      </>
    ) : (
      <>
        <div className="mb-1 font-medium">{title}</div>
        <div className="text-sm text-muted">{desc}</div>
      </>
    )
  return (
    <div className="fade-up flex flex-col items-center">
      {/* 衬线只留给首页问候语，这里跟全局一样走黑体 */}
      <h1 className="mb-2 text-3xl font-semibold">建立你的知识库</h1>
      <p className="mb-10 text-md text-muted">一个普通的 markdown 文件夹，数据永远在你自己手里</p>
      <div className="flex gap-6">
        {/* 两张卡同为中性样式，靠 hover（描边转强调色 + 浅底）给明确反馈 */}
        <button
          data-testid="wizard-create"
          disabled={!!busy}
          onClick={() => pick(true)}
          className="w-64 rounded-xl border border-line bg-card p-6 text-left transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-60"
        >
          {cardBody('create', '新建库', '按 MCN 模板创建分区结构，含投递箱与产物目录')}
        </button>
        <button
          data-testid="wizard-existing"
          disabled={!!busy}
          onClick={() => pick(false)}
          className="w-64 rounded-xl border border-line bg-card p-6 text-left transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-60"
        >
          {cardBody('existing', '使用已有库', '指向现有 Obsidian vault 或任何 markdown 文件夹')}
        </button>
      </div>
      {/* 同样是真入口，给下划线链接样式，别混进说明文字里 */}
      {onSkip && (
        <button
          onClick={onSkip}
          className="mt-8 text-sm text-muted underline underline-offset-4 hover:text-accent"
        >
          {skipLabel}
        </button>
      )}
    </div>
  )
}
