import '../env-hooks'
import Store from 'electron-store'
import type { InboxEvent } from './types'
import { BACKOFF_MS, nextRetryAt, pickDue } from '../lib/retry-ladder'

export { BACKOFF_MS }

/**
 * 任务层的落盘（设计见 docs/DESIGN-task-state.md §3.3–3.5）。
 *
 * 判据只有一条：**「进行中」永不落盘，落盘的只有「终态结果」与「待办队列」。**
 * 落了"进行中"，重启后必然出现一个永远不会结束、也没法确认死活的幽灵任务。
 */

/** 已入库表：复合主键 (artifactRel, contentHash) —— 路径做对象键，哈希做值内校验位 */
export interface IngestedEntry {
  contentHash: string
  /** 快速门：mtime+size 与存量一致就直接信任存量哈希，不重算（pptx 动辄几 MB） */
  mtimeMs: number
  size: number
  at: number
  noteRel?: string
}

export interface SyncQueueItem {
  /** `sync:${convId}`，同一会话只排一条，后来的覆盖前面的、tries 累加 */
  id: string
  convId: string
  tries: number
  lastError?: string
  at: number
  /** 0 = 已转手动，不再自动重试 */
  nextRetryAt: number
}

/**
 * 笔记上云失败的重试队列（F3 / 审计 Q2）。
 *
 * **它以前不存在**：`cloudSync` 失败时的文案写着「已进重试队列」，而 `syncQueue`
 * 只服务聊天记录（`sync-queue.ts` 里唯一的动作是 `syncConversation`）。
 * 后果有两层——数据层：那几篇**永远**不会重传，云端静默缺篇；
 * 而问库在登录态下走的是云端语义检索，没上云的在对话里等于不存在。
 * 文案层：界面说了一句假话，用户按它去等，等不到。
 *
 * 队列结构与 `SyncQueueItem` 刻意保持同形（同一套退避阶梯、同一颗「重试」按钮），
 * 多带一个 `root`：笔记是属于某一个库的，换库之后不能拿新库的相对路径去重传旧库的篇。
 */
export interface NoteSyncQueueItem {
  /** `note:${root}:${rel}`，同一篇只排一条 */
  id: string
  /** 这篇笔记所属的库根。换库后不属于当前库的先留着不动 */
  root: string
  /** 库内相对路径 */
  rel: string
  tries: number
  lastError?: string
  at: number
  /** 0 = 已转手动，不再自动重试 */
  nextRetryAt: number
}

interface TaskStoreSchema {
  lastInboxRun?: {
    endedAt: number
    ok: boolean
    /** 用户主动停止的那一轮：状态是 canceled 不是 failed（中性灰，不是红） */
    canceled?: boolean
    files: string[]
    stages: InboxEvent[]
  }
  ingested: Record<string, IngestedEntry>
  syncQueue: SyncQueueItem[]
  noteSyncQueue: NoteSyncQueueItem[]
}

const taskStore = new Store<TaskStoreSchema>({
  name: 'tasks',
  defaults: { ingested: {}, syncQueue: [], noteSyncQueue: [] },
})

// ---- 上一轮投递结果（重启后仍能看到「上次入库 6/6 完成」） ----
export const getLastInboxRun = (): TaskStoreSchema['lastInboxRun'] => taskStore.get('lastInboxRun')
export const setLastInboxRun = (r: TaskStoreSchema['lastInboxRun']): void => {
  if (r) taskStore.set('lastInboxRun', r)
}

// ---- 已入库表 ----
export const getIngested = (): Record<string, IngestedEntry> => taskStore.get('ingested')

export function markIngested(artifactRel: string, e: IngestedEntry): void {
  taskStore.set('ingested', { ...taskStore.get('ingested'), [artifactRel]: e })
}

export const getSyncQueue = (): SyncQueueItem[] => taskStore.get('syncQueue')

/** 到点该重试的条目（nextRetryAt=0 已转手动，不在自动范围内） */
export const dueSyncFailures = (now = Date.now()): SyncQueueItem[] =>
  pickDue(taskStore.get('syncQueue'), now)

/**
 * 「重试」按钮：整队 tries 归零并立刻到期（设计 §3.5）。
 * 不给"永远重试"——离线一整天回来一次性打几百个请求，比失败本身更糟，
 * 所以自动重试有上限，超限后只能由用户在这里手动踢一脚。
 */
export function resetSyncQueue(): SyncQueueItem[] {
  const q = taskStore.get('syncQueue').map((x) => ({ ...x, tries: 0, nextRetryAt: Date.now() }))
  taskStore.set('syncQueue', q)
  return q
}

/** 同一会话只排一条：后来的覆盖前面的，tries 累加 */
export function pushSyncFailure(convId: string, error: string): SyncQueueItem {
  const q = taskStore.get('syncQueue')
  const id = `sync:${convId}`
  const old = q.find((x) => x.id === id)
  const tries = (old?.tries ?? 0) + 1
  const item: SyncQueueItem = {
    id,
    convId,
    tries,
    lastError: error,
    at: old?.at ?? Date.now(),
    // 超过阶梯长度 = 转手动（nextRetryAt=0），由用户在 Dock 上点「重试」
    nextRetryAt: nextRetryAt(tries),
  }
  taskStore.set('syncQueue', [...q.filter((x) => x.id !== id), item])
  return item
}

export function dropSyncFailure(convId: string): void {
  taskStore.set(
    'syncQueue',
    taskStore.get('syncQueue').filter((x) => x.id !== `sync:${convId}`)
  )
}

/** 登出即清队：这些记录属于上一个账号，不能带到下一个账号的 Supabase 里去 */
export function clearSyncQueue(): void {
  taskStore.set('syncQueue', [])
  taskStore.set('noteSyncQueue', [])
}

// ---- 笔记上云的重试队列（F3 / Q2）----
//
// 与聊天记录那条队列**共用同一套退避阶梯与同一颗「重试」按钮**：
// 用户看到的是一个数字「N 条待同步」，没必要在界面上把两种待办分开。

const noteId = (root: string, rel: string): string => `note:${root}:${rel}`

export const getNoteSyncQueue = (): NoteSyncQueueItem[] => taskStore.get('noteSyncQueue')

export const dueNoteSyncFailures = (now = Date.now()): NoteSyncQueueItem[] =>
  pickDue(taskStore.get('noteSyncQueue'), now)

/** 同一篇只排一条：后来的覆盖前面的，tries 累加 */
export function pushNoteSyncFailure(root: string, rel: string, error: string): NoteSyncQueueItem {
  const q = taskStore.get('noteSyncQueue')
  const id = noteId(root, rel)
  const old = q.find((x) => x.id === id)
  const tries = (old?.tries ?? 0) + 1
  const item: NoteSyncQueueItem = {
    id,
    root,
    rel,
    tries,
    lastError: error,
    at: old?.at ?? Date.now(),
    nextRetryAt: nextRetryAt(tries),
  }
  taskStore.set('noteSyncQueue', [...q.filter((x) => x.id !== id), item])
  return item
}

export function dropNoteSyncFailure(root: string, rel: string): void {
  const id = noteId(root, rel)
  taskStore.set(
    'noteSyncQueue',
    taskStore.get('noteSyncQueue').filter((x) => x.id !== id)
  )
}

/** 「重试」按钮：整队 tries 归零并立刻到期（与聊天记录那条同一颗按钮） */
export function resetNoteSyncQueue(): NoteSyncQueueItem[] {
  const q = taskStore.get('noteSyncQueue').map((x) => ({ ...x, tries: 0, nextRetryAt: Date.now() }))
  taskStore.set('noteSyncQueue', q)
  return q
}

/** Dock 上那个数字：两条队列之和——用户看的是"还有多少没同步上去"，不关心分类 */
export const pendingSyncTotal = (): number =>
  taskStore.get('syncQueue').length + taskStore.get('noteSyncQueue').length
