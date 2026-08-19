import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * 编辑冲突提示条（M-27，设计 §5.2 的时机 (b)）。
 *
 * **非模态**是刻意的：用户正在打字，弹模态会吞掉击键、打断输入法组合，比不提示还差。
 * 真正打断用户的只有保存那一刻的三选一（时机 (c)）——那时他已经决定要写盘了。
 *
 * 「Obsidian 同时编辑」是对外宣传的卖点，所以这条路径上一个字都不能悄悄丢。
 */
export function ConflictBar({
  diskText,
  onOverwrite,
}: {
  /** 磁盘上现在的内容（对方那一版），用于「查看对方版本」就地展开 */
  diskText: string
  onOverwrite: () => void
}) {
  const [showTheirs, setShowTheirs] = useState(false)
  return (
    /* 浅金底 + 深金字（三期）：这是一条**常驻在正文上方**的横幅，铺深色会一直拽走视线；
       而它又必须一眼看见，所以用浅底深字而不是弱化成灰。云端降级条那条仍是橙系——
       两者语义不同：降级是"系统在退让"，冲突是"有东西等你决定" */
    <div data-testid="conflict-bar" className="border-b border-gold-line bg-gold-soft">
      <div className="flex items-center gap-2 px-8 py-2 text-sm text-gold-ink">
        <AlertTriangle size={14} className="shrink-0" />
        <span className="min-w-0 flex-1">
          此文件已在外部被修改（Obsidian？）。你的改动还在，保存时会让你选怎么处理。
        </span>
        <button
          data-testid="conflict-view-theirs"
          onClick={() => setShowTheirs((v) => !v)}
          className="shrink-0 rounded-full border border-gold-line px-2.5 py-0.5 hover:bg-card"
        >
          {showTheirs ? '收起对方版本' : '查看对方版本'}
        </button>
        <button
          data-testid="conflict-overwrite"
          onClick={onOverwrite}
          className="shrink-0 rounded-full border border-gold-line px-2.5 py-0.5 hover:bg-card"
        >
          用我的覆盖
        </button>
      </div>
      {showTheirs && (
        <pre
          data-testid="conflict-theirs"
          className="max-h-48 overflow-auto border-t border-warn-line bg-card px-8 py-3 font-mono text-sm leading-6"
        >
          {diskText || '（对方那一版已被删除或读不到）'}
        </pre>
      )}
    </div>
  )
}
