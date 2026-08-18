import { useEffect, useRef, useState } from 'react'
import { Loader2, AlertCircle, CloudOff } from 'lucide-react'
import { isActive, useAllTasks, useCloud } from '../hooks/useTasks'
import { ui } from './ui'
import { inboxPanel } from '../lib/bus'

/**
 * 全局任务条（设计见 docs/DESIGN-task-state.md §4.1）。
 *
 * 位置定在侧栏底部、身份行上方——右下角已经被投递箱面板和产物面板占了，
 * 顶部要留给 OfflineBar 且会挤压内容区。这里三个页面都常驻可见、不与任何浮层重叠。
 *
 * 它是纯投影：所有内容来自主进程的 task registry，本组件不持有任何任务状态。
 */

/**
 * 点一条任务 = 「带我去看它」。光切页面是不够的：投递任务的详情在**投递箱浮窗**里，
 * 而那个浮窗可能已经被用户 ✕ 掉了——人本来就在知识库页时，切页面等于什么都没发生
 * （用户实测反馈「点了没反应」）。所以这里额外发一次唤回请求。
 */
const goTo = (kind: TaskKind, onOpen: (p: 'workbench' | 'vault' | 'settings') => void): void => {
  if (kind === 'inbox' || kind === 'ingest') inboxPanel.request()
  onOpen(PAGE_OF[kind])
}

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
  const [retrying, setRetrying] = useState(false)

  // sync 不进全局条：它几百毫秒就结束，冒一下又收回去只会让侧栏底部抽搐一下。
  // 设计 §1.3 写死了「这一类的目标是绝大多数时候不可见」——失败由 pendingSync 表达
  const active = all.filter((t) => isActive(t) && t.kind !== 'sync')
  // 终态里只有"失败"值得占用全局位置；成功的事情让它安静地过去。
  // **canceled 不算失败**——那是用户自己停的，不该在全局条上挂一句红字（设计 §5.1）。
  // sync 也排除：它的失败已经由 pendingSync 表达成「N 条待同步」，两条都挂等于说两遍
  const failed = all.filter((t) => t.status === 'failed' && t.kind !== 'sync')
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
            else if (only) goTo(only.kind, onOpen)
            else if (failed[0]) goTo(failed[0].kind, onOpen)
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

        {/* 待同步：退避阶梯跑完就转手动，出口只有这一颗。整队 tries 归零并立刻跑一轮（设计 §3.5） */}
        {pendingSync > 0 && active.length === 0 && (
          <button
            data-testid="sync-retry"
            disabled={retrying}
            onClick={async (e) => {
              e.stopPropagation()
              setRetrying(true)
              try {
                const r = await window.api.tasks.retrySync()
                ui.toast(r.pending === 0 ? '待同步的聊天记录已全部补上' : `还有 ${r.pending} 条没同步上去，稍后会自动再试`)
              } finally {
                setRetrying(false)
              }
            }}
            className="mt-1 w-full rounded-md border border-line px-3 py-1 text-xs text-muted hover:bg-hover disabled:opacity-60"
          >
            {retrying ? '重试中…' : '重试同步'}
          </button>
        )}

        {/* ≥2 项时点开列表：不新开页面，就地一个小浮层 */}
        {expanded && (
          <div className="fade-up absolute bottom-full left-3 right-3 z-30 mb-1 overflow-hidden rounded-md border border-line bg-card py-1 shadow-pop">
            {[...active, ...failed].map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setExpanded(false)
                  goTo(t.kind, onOpen)
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
