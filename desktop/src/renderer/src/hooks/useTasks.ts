import { useSyncExternalStore } from 'react'

/**
 * 全局任务状态层的渲染层镜像（设计见 docs/DESIGN-task-state.md §2.4）。
 *
 * **主进程 registry 是唯一真相源，这里只是它的镜像，页面组件是纯投影。**
 * 页面组件不得自己 setState 维护任务态——唯一例外是 Workbench 的逐字 draft
 * 允许本地累积（性能），但每次挂载必须先用 task.draft 做基线。
 *
 * 用 useSyncExternalStore 而不是 Context+useState：Context 一变全树重渲染，
 * AI 生成时每 500ms 一次全树重渲染会拖慢逐字输出。它是 React 18 内置 API，
 * 不违反「不引入状态管理库」。
 */

const EMPTY_CLOUD: CloudState = {
  reachable: null,
  loggedIn: false,
  checkedAt: 0,
  pendingSync: 0,
}

/** 整块替换而不是就地改：useSyncExternalStore 靠引用相等判断要不要重渲染 */
const EMPTY_VAULT: VaultState = { lost: false, root: null, checkedAt: 0 }
let snap: { tasks: Task[]; cloud: CloudState; vault: VaultState } = { tasks: [], cloud: EMPTY_CLOUD, vault: EMPTY_VAULT }
const listeners = new Set<() => void>()

const publish = (next: { tasks: Task[]; cloud: CloudState; vault: VaultState }): void => {
  snap = next
  listeners.forEach((l) => l())
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let started = false

/** App 挂载时调一次。先 tasks:list 打底（push 会在 reload 期间丢），再订阅增量 */
export function startTaskSync(): () => void {
  if (started) return () => void 0
  started = true

  void window.api.tasks.list().then((s) => publish({ tasks: s.tasks, cloud: s.cloud, vault: s.vault ?? EMPTY_VAULT }))

  const off = window.api.tasks.onEvent((p) => {
    if (p.type === 'snapshot') {
      publish({ tasks: p.tasks, cloud: p.cloud, vault: p.vault ?? EMPTY_VAULT })
      return
    }
    if (p.type === 'vault') {
      publish({ ...snap, vault: p.vault })
      return
    }
    if (p.type === 'cloud') {
      publish({ ...snap, cloud: p.cloud })
      return
    }
    if (p.type === 'remove') {
      publish({ ...snap, tasks: snap.tasks.filter((t) => t.id !== p.id) })
      return
    }
    // upsert：seq 用来丢弃迟到/乱序的事件（reload 后尤其会撞上）
    const known = snap.tasks.find((t) => t.id === p.task.id)
    if (known && known.seq >= p.task.seq) return
    publish({
      ...snap,
      tasks: known ? snap.tasks.map((t) => (t.id === p.task.id ? p.task : t)) : [...snap.tasks, p.task],
    })
  })

  return () => {
    off()
    started = false
  }
}

const ACTIVE: TaskStatus[] = ['queued', 'running']
export const isActive = (t: Task): boolean => ACTIVE.includes(t.status)

const getSnapshot = (): { tasks: Task[]; cloud: CloudState; vault: VaultState } => snap

export function useAllTasks(): Task[] {
  return useSyncExternalStore(subscribe, () => getSnapshot().tasks)
}

/** R16：知识库目录还在不在。顶条（VaultLostBar）唯一的数据来源 */
export function useVault(): VaultState {
  return useSyncExternalStore(subscribe, () => getSnapshot().vault)
}

export function useCloud(): CloudState {
  return useSyncExternalStore(subscribe, () => getSnapshot().cloud)
}

/**
 * 取某一类（可再按业务主键过滤）的那条任务。
 * 返回的是 snapshot 里的对象引用——只要那条任务没变过就是同一个引用，
 * 所以不会造成无关组件的重渲染。
 */
export function useTask<K extends Task['kind']>(
  kind: K,
  key?: string
): Extract<Task, { kind: K }> | undefined {
  return useSyncExternalStore(
    subscribe,
    () =>
      getSnapshot().tasks.find((t) => t.kind === kind && (key === undefined || t.key === key)) as
        | Extract<Task, { kind: K }>
        | undefined
  )
}
