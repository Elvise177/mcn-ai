import { FolderX } from 'lucide-react'
import { useVault } from '../hooks/useTasks'

/**
 * 知识库目录不可访问的顶条（R16 的呈现，Condition 不是任务）。
 *
 * 对应的静默失效：库放在外接盘 / 网盘 / iCloud 上，盘被拔了或目录被移走之后，
 * watcher 从此再也不报事件，而应用**一点反应都没有**——文件树还画着内存里那份旧快照、
 * 检索还在旧索引上命中，只有点开某一篇才报「找不到文件」。
 * 用户以为库好好的，实际每一次写入都在往一个不存在的路径上写。
 *
 * **不显示路径**（U3 #5：路径不泄漏）；出事的那个根只进日志。
 * 主进程每 30 秒自己重探一次，盘插回来这条会自动消失——不用重启（同 Q11 的教训）。
 */
export function VaultLostBar() {
  const vault = useVault()
  if (!vault.lost) return null
  return (
    <div
      data-testid="vault-lost-bar"
      className="flex items-center gap-2 border-b border-line bg-danger-soft px-8 py-1.5 text-sm text-danger"
    >
      <FolderX size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        知识库目录不可访问{vault.reason ? `：${vault.reason}` : ''}。接回来之后这条会自己消失，不用重启
      </span>
    </div>
  )
}
