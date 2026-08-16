import '../env-hooks'
import Store from 'electron-store'
import type { InboxEvent } from './types'

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

interface TaskStoreSchema {
  lastInboxRun?: { endedAt: number; ok: boolean; files: string[]; stages: InboxEvent[] }
  ingested: Record<string, IngestedEntry>
  syncQueue: SyncQueueItem[]
}

const taskStore = new Store<TaskStoreSchema>({
  name: 'tasks',
  defaults: { ingested: {}, syncQueue: [] },
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

/**
 * 退避阶梯：1m → 5m → 30m → 转手动（见设计 §3.5）。
 * 不给"永远重试"——离线一整天回来一次性打几百个请求，比失败本身更糟。
 */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000]

export const getSyncQueue = (): SyncQueueItem[] => taskStore.get('syncQueue')

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
    nextRetryAt: tries <= BACKOFF_MS.length ? Date.now() + BACKOFF_MS[tries - 1] : 0,
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
}
