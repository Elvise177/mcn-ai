import { useEffect, useState } from 'react'
import { ArrowUpCircle, Download, AlertTriangle, X } from 'lucide-react'

/**
 * 更新条（自动更新，策略 = 提示后更新，不静默）。
 *
 * ## 0.1.2 之前它只有一种形态
 *
 * 只有**下完之后**才挂出来，下载全程界面上什么都不出。227MB 的包在客户网速下
 * 就是十几分钟全黑：查更新、发现新版、下载中，一律零显示。真实客户在这段沉默里
 * 以为软件坏了，来问我们"点了更新怎么没反应"。
 *
 * 而且点「立即重启」之后 `install()` 的返回值被 `void` 扔掉了——真失败的话，
 * 按钮就永远停在「正在重启…」。**那句"卡住"是字面意义上的：它真的不会再变。**
 *
 * 现在四种形态各说各的话：下载中报百分比、就绪催重启、失败说原因、其余不出现。
 *
 * 两个保留的取向：
 * ① **可关掉**（只关这一次运行）。它不是故障、不需要立刻处理，一直钉着等于长期占地方。
 * ② **走 snapshot 打底**：推送在窗口 reload 期间会静默丢，所以挂载时先拿权威快照。
 */
export function UpdateBar() {
  const [st, setSt] = useState<{
    ready: boolean
    version: string | null
    phase: string
    percent: number
    error: string | null
  } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.update.state().then((s) => alive && setSt(s))
    const off = window.api.update.onReady((s) => setSt(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!st || dismissed) return null
  const failed = st.phase === 'error' || !!installError
  const downloading = st.phase === 'downloading'
  if (!failed && !downloading && !st.ready) return null

  const tone = failed
    ? 'border-danger-line bg-danger-soft text-danger'
    : 'border-accent-line bg-accent-soft text-accent'

  return (
    <div
      data-testid="update-bar"
      data-version={st.version ?? ''}
      data-phase={failed ? 'error' : downloading ? 'downloading' : 'ready'}
      className={`flex items-center gap-2 border-b px-8 py-1.5 text-sm ${tone}`}
    >
      {failed ? (
        <AlertTriangle size={13} className="shrink-0" />
      ) : downloading ? (
        <Download size={13} className="shrink-0 animate-pulse" />
      ) : (
        <ArrowUpCircle size={13} className="shrink-0" />
      )}

      <span className="min-w-0 flex-1 truncate" data-testid="update-text">
        {failed
          ? `更新失败：${installError ?? st.error}。稍后会自动重试，也可以联系我们`
          : downloading
            ? /**
               * 百分比必须出现在文案里——「正在下载新版本…」这种没有数字的说法，
               * 在慢网络下和"卡死了"长得一模一样（这正是要修的那个观感）
               */
              `正在下载新版本 ${st.version ?? ''} … ${st.percent}%`
            : `新版本 ${st.version} 已就绪，重启生效`}
      </span>

      {downloading && (
        <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-line">
          <span
            data-testid="update-progress"
            className="block h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${Math.max(st.percent, 2)}%` }}
          />
        </span>
      )}

      {st.ready && !failed && (
        <button
          data-testid="update-install"
          disabled={restarting}
          onClick={() => {
            setRestarting(true)
            setInstallError(null)
            /**
             * **返回值必须接住**。原来是 `void window.api.update.install()`——
             * 失败时按钮永远停在「正在重启…」，用户只能重启电脑。
             * 现在失败就说原因、按钮复位，让他还能再点一次。
             */
            void window.api.update
              .install()
              .then((r) => {
                if (r?.ok) return
                setInstallError(r?.error || '安装没能启动')
                setRestarting(false)
              })
              .catch((e) => {
                setInstallError(String(e?.message ?? e))
                setRestarting(false)
              })
          }}
          className="shrink-0 rounded-full border border-accent-line px-2.5 py-0.5 hover:bg-card disabled:opacity-60"
        >
          {restarting ? '正在重启…' : '立即重启'}
        </button>
      )}

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
