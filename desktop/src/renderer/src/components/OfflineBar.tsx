import { CloudOff } from 'lucide-react'
import { useCloud } from '../hooks/useTasks'

/**
 * 云端离线说明条（Condition 的呈现，不是任务）。
 *
 * 对应 HANDOFF bug#1 的正确行为描述：照常开窗 + 本地功能可用 + 顶部「云端离线」提示；
 * 顺带兑现审计 M-28——本地模式下 AI 检索会静默从云端三层退回本地全文，用户得知道这件事。
 */
export function OfflineBar() {
  const cloud = useCloud()
  if (cloud.reachable !== false) return null
  return (
    <div
      data-testid="offline-bar"
      className="flex items-center gap-2 border-b border-line bg-warn-soft px-8 py-1.5 text-sm text-warn"
    >
      <CloudOff size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        云端离线，本地功能照常可用（知识库 / 投递箱）；AI 检索已降级为本地全文
        {cloud.pendingSync > 0 && ` · ${cloud.pendingSync} 条聊天记录待同步`}
      </span>
    </div>
  )
}
