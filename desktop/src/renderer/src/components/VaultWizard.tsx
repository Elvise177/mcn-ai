import { useState } from 'react'

/** 建库引导（两分支）：首跑 onboarding 与知识库页共用 */
export function VaultWizard({
  onReady,
  onSkip,
}: {
  onReady: (v: { path: string; noteCount: number }) => void
  onSkip?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const pick = async (create: boolean): Promise<void> => {
    setBusy(true)
    const v = create ? await window.api.vault.createNew() : await window.api.vault.pickExisting()
    setBusy(false)
    if (v) onReady(v)
  }
  return (
    <div className="fade-up flex flex-col items-center">
      {/* 衬线只留给首页问候语，这里跟全局一样走黑体 */}
      <h1 className="mb-2 text-3xl font-semibold">建立你的知识库</h1>
      <p className="mb-10 text-md text-muted">一个普通的 markdown 文件夹，数据永远在你自己手里</p>
      <div className="flex gap-6">
        {/* 两张卡同为中性样式，靠 hover（描边转强调色 + 浅底）给明确反馈 */}
        <button
          disabled={busy}
          onClick={() => pick(true)}
          className="w-64 rounded-xl border border-line bg-card p-6 text-left transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-60"
        >
          <div className="mb-1 font-medium">新建库</div>
          <div className="text-sm text-muted">按 MCN 模板创建分区结构，含投递箱与产物目录</div>
        </button>
        <button
          disabled={busy}
          onClick={() => pick(false)}
          className="w-64 rounded-xl border border-line bg-card p-6 text-left transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-60"
        >
          <div className="mb-1 font-medium">使用已有库</div>
          <div className="text-sm text-muted">指向现有 Obsidian vault 或任何 markdown 文件夹</div>
        </button>
      </div>
      {/* 同样是真入口，给下划线链接样式，别混进说明文字里 */}
      {onSkip && (
        <button
          onClick={onSkip}
          className="mt-8 text-sm text-muted underline underline-offset-4 hover:text-accent"
        >
          暂时跳过，之后可在「个人知识库」里建
        </button>
      )}
    </div>
  )
}
