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
      <h1 className="mb-2 font-serif text-3xl">建立你的知识库</h1>
      <p className="mb-10 text-sm text-muted">一个普通的 markdown 文件夹，数据永远在你自己手里</p>
      <div className="flex gap-6">
        <button
          disabled={busy}
          onClick={() => pick(true)}
          className="w-64 rounded-2xl border-2 border-rose bg-rose-soft p-6 text-left hover:opacity-90"
        >
          <div className="mb-1 font-medium text-rose">新建库</div>
          <div className="text-xs text-muted">按 MCN 模板创建分区结构，含投递箱与产物目录</div>
        </button>
        <button
          disabled={busy}
          onClick={() => pick(false)}
          className="w-64 rounded-2xl border border-line bg-card p-6 text-left hover:bg-rose-soft/40"
        >
          <div className="mb-1 font-medium">使用已有库</div>
          <div className="text-xs text-muted">指向现有 Obsidian vault 或任何 markdown 文件夹</div>
        </button>
      </div>
      {onSkip && (
        <button onClick={onSkip} className="mt-8 text-[12px] text-muted hover:text-rose hover:underline">
          暂时跳过，之后可在「个人知识库」里建
        </button>
      )}
    </div>
  )
}
