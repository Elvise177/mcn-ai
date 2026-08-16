import { useEffect, useRef, useState } from 'react'
import { Loader2, AlertCircle, CloudOff } from 'lucide-react'
import { isActive, useAllTasks, useCloud } from '../hooks/useTasks'

/**
 * 全局任务条（设计见 docs/DESIGN-task-state.md §4.1）。
 *
 * 位置定在侧栏底部、身份行上方——右下角已经被投递箱面板和产物面板占了，
 * 顶部要留给 OfflineBar 且会挤压内容区。这里三个页面都常驻可见、不与任何浮层重叠。
 *
 * 它是纯投影：所有内容来自主进程的 task registry，本组件不持有任何任务状态。
 */

const PAGE_OF: Record<TaskKind, 'workbench' | 'vault' | 'settings'> = {
  inbox: 'vault',
  ingest: 'vault',
  agent: 'workbench',
  sync: 'settings',
  secret: 'settings',
}

function Bar({ t }: { t: Task }) {
  const pct = t.progress && t.progress.total > 0 ? Math.round((t.progress.done / t.progress.total) * 100) : 0
  return (
    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
      <div
        className={`task-bar-fill h-full rounded-full ${t.error ? 'bg-danger' : 'bg-accent'}`}
        style={{ width: `${Math.max(pct, 6)}%` }}
      />
    </div>
  )
}

export function TaskDock({ onOpen }: { onOpen: (page: 'workbench' | 'vault' | 'settings') => void }) {
  const all = useAllTasks()
  const cloud = useCloud()
  const [expanded, setExpanded] = useState(false)

  const active = all.filter(isActive)
  // 终态里只有"失败"值得占用全局位置；成功的事情让它安静地过去
  const failed = all.filter((t) => t.status === 'failed')
  const pendingSync = cloud.pendingSync

  const show = active.length > 0 || failed.length > 0 || pendingSync > 0
  // 收起时把展开态一并复位，否则下次出现会直接是展开的
  useEffect(() => {
    if (!show) setExpanded(false)
  }, [show])

  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!expanded) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setExpanded(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [expanded])

  const only = active.length === 1 ? active[0] : undefined
  const label =
    only?.title ??
    (active.length > 1
      ? `${active.length} 项进行中`
      : failed.length > 0
        ? failed[0].title
        : `${pendingSync} 条待同步`)

  return (
    <div data-testid="task-dock" className={`task-dock ${show ? 'task-dock-open' : ''}`}>
      <div ref={boxRef} className="relative px-3 pb-2">
        <button
          data-testid="task-dock-btn"
          onClick={() => {
            if (active.length + failed.length > 1) setExpanded((v) => !v)
            else if (only) onOpen(PAGE_OF[only.kind])
            else if (failed[0]) onOpen(PAGE_OF[failed[0].kind])
            else onOpen('settings')
          }}
          className="w-full rounded-md border border-line bg-card px-3 py-2 text-left hover:bg-hover"
        >
          <div className="flex items-center gap-2 text-xs">
            {active.length > 0 ? (
              <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
            ) : failed.length > 0 ? (
              <AlertCircle size={12} className="shrink-0 text-danger" />
            ) : (
              <CloudOff size={12} className="shrink-0 text-warn" />
            )}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {only?.progress && (
              <span className="shrink-0 text-muted">
                {only.progress.done}/{only.progress.total}
              </span>
            )}
          </div>
          {only && only.progress && <Bar t={only} />}
        </button>

        {/* ≥2 项时点开列表：不新开页面，就地一个小浮层 */}
        {expanded && (
          <div className="fade-up absolute bottom-full left-3 right-3 z-30 mb-1 overflow-hidden rounded-md border border-line bg-card py-1 shadow-pop">
            {[...active, ...failed].map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setExpanded(false)
                  onOpen(PAGE_OF[t.kind])
                }}
                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-hover"
              >
                <span className={t.status === 'failed' ? 'text-danger' : ''}>{t.title}</span>
                {t.progress && (
                  <span className="ml-1 text-muted">
                    {t.progress.done}/{t.progress.total}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
