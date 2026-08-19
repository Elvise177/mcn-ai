import { useEffect, useState } from 'react'
import { ArrowUpCircle, X } from 'lucide-react'

/**
 * 新版本就绪条（自动更新，策略 = 提示后更新，不静默）。
 *
 * 下载全程界面上什么都不出，只有**下完之后**才挂这一条。点「立即重启」才换版本；
 * 不点也不催——用户手动退出应用时也会装上（`autoInstallOnAppQuit`），所以「重启生效」是句实话。
 *
 * 两个刻意的取向：
 * ① **可关掉**（只关这一次运行）。它不是故障、不需要立刻处理，一直钉在正文上方等于长期占地方；
 *    关掉之后下次启动还会再出现，不会真的丢。
 * ② **走 snapshot 打底**：`onReady` 推送在窗口 reload 期间会静默丢（同任务层的约定），
 *    所以挂载时先 `update.state()` 拿权威快照，事件只负责"运行期间刚下完"这一种情况。
 */
export function UpdateBar() {
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.update.state().then((s) => {
      if (alive && s.ready) setVersion(s.version)
    })
    const off = window.api.update.onReady((s) => {
      if (s.ready) setVersion(s.version)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!version || dismissed) return null
  return (
    <div
      data-testid="update-bar"
      data-version={version}
      className="flex items-center gap-2 border-b border-accent-line bg-accent-soft px-8 py-1.5 text-sm text-accent"
    >
      <ArrowUpCircle size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">新版本 {version} 已就绪，重启生效</span>
      <button
        data-testid="update-install"
        disabled={restarting}
        onClick={() => {
          setRestarting(true)
          void window.api.update.install()
        }}
        className="shrink-0 rounded-full border border-accent-line px-2.5 py-0.5 hover:bg-card disabled:opacity-60"
      >
        {restarting ? '正在重启…' : '立即重启'}
      </button>
      <button
        data-testid="update-dismiss"
        title="稍后再说（下次启动还会提示）"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded-full p-1 hover:bg-card"
      >
        <X size={13} />
      </button>
    </div>
  )
}
