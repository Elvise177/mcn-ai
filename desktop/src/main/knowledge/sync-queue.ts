import { listConversations } from '../agent/conversations'
import { ingestNote, syncConversation } from './client'
import {
  dropNoteSyncFailure,
  dropSyncFailure,
  dueNoteSyncFailures,
  dueSyncFailures,
  getSyncQueue,
  pendingSyncTotal,
  pushNoteSyncFailure,
  resetNoteSyncQueue,
  resetSyncQueue,
} from '../tasks/persist'
import { notesForRoot } from '../lib/retry-ladder'
import { tasks } from '../tasks/registry'
import { vaultManager } from '../vault'
import { getSession } from '../auth'
import { log } from '../lib/logger'

/**
 * 云端同步的重试器（设计 §3.5，审计 M-03 / Q2）。
 *
 * 一期只做「失败别蒸发」——把失败落进 `tasks.json` 的 `syncQueue` 并把条数暴露到全局条；
 * 二期（这里）才是真的重试：退避 1m / 5m / 30m → 转手动，同会话只排一条，登出清队。
 *
 * **三期（F3，2026-09-03）把笔记也接进来了**：`cloudSync` 失败时的文案原来写着
 * 「已进重试队列」，而这个队列里**只有聊天记录**——那几篇笔记永远不会重传，
 * 云端静默缺篇，而登录态下问库走的是云端语义检索，没上云的在对话里等于不存在。
 *
 * **为什么不做"永远重试"**：离线一整天回来一次性打几百个请求，比失败本身更糟。
 * 超过阶梯就把 `nextRetryAt` 置 0 转手动，出口是 Dock 上那颗「重试」。
 */

/** 扫描间隔。退避阶梯最小是 1 分钟，30 秒一扫足够贴着阶梯走，又不至于空转太勤 */
const TICK_MS = 30_000

let timer: ReturnType<typeof setInterval> | null = null
/** 一轮还没跑完就别开第二轮：同一个 convId 并发 upsert 只会互相打架 */
let running = false

/**
 * 跑一轮到期的重试。
 *
 * 注意 `syncConversation` 每次只插入最后两条消息（它本来就是"增量保存"的语义），
 * 所以重试插的也是那两条。若上次失败发生在第一条插入之后，重试会让那一条重复一遍——
 * 代价可接受（云端那份是副本，本地 electron-store 才是权威），换来的是失败不再蒸发。
 */
async function runDue(): Promise<number> {
  if (running) return 0
  const due = dueSyncFailures()
  const dueNotes = dueNoteSyncFailures()
  if (!due.length && !dueNotes.length) return 0
  // 未登录就先留着：这些记录属于某个账号，等它回来再说（登出走 clearSyncQueue 直接清空）
  if (!(await getSession().catch(() => null))) return 0

  running = true
  let synced = 0
  try {
    const convs = listConversations()
    for (const item of due) {
      const conv = convs.find((c) => c.id === item.convId)
      if (!conv) {
        // 本地都没这条对话了（用户删了），队列里也不该留
        dropSyncFailure(item.convId)
        continue
      }
      await syncConversation(conv)
      if (!getSyncQueue().some((x) => x.convId === item.convId)) synced++
    }
    /**
     * 笔记（F3）。**只重传属于当前库的那些**：`ingestNote` 是按"库根 + 相对路径"读盘的，
     * 换库之后拿新库的根去读旧库的相对路径，读到的要么是别的文件、要么读不到——
     * 前一种是真的会把错内容传上云。不属于当前库的先留着，等他切回去那天。
     */
    const root = vaultManager.currentRoot
    for (const n of notesForRoot(dueNotes, root)) {
      const r = await ingestNote(n.rel)
      if (r.ok) {
        dropNoteSyncFailure(n.root, n.rel)
        synced++
      } else {
        pushNoteSyncFailure(n.root, n.rel, r.error ?? '未知原因')
      }
    }
    log('info', 'sync', `重试 ${due.length + dueNotes.length} 条（对话 ${due.length} / 笔记 ${dueNotes.length}），成功 ${synced} 条，剩 ${pendingSyncTotal()} 条`)
  } catch (e) {
    log('error', 'sync', `重试轮出错：${e}`)
  } finally {
    running = false
    tasks.setCloud({ pendingSync: pendingSyncTotal() })
  }
  return synced
}

/** 启动时挂一次。上次退出时没同步完的，开机就补一轮 */
export function startSyncRetry(): void {
  if (timer) return
  timer = setInterval(() => void runDue(), TICK_MS)
  timer.unref?.()
  void runDue()
}

/** Dock 上那颗「重试」：两条队列 tries 全归零、立刻跑一轮（转手动之后唯一的出口） */
export async function retryAllSyncs(): Promise<{ pending: number; synced: number }> {
  resetSyncQueue()
  resetNoteSyncQueue()
  tasks.setCloud({ pendingSync: pendingSyncTotal() })
  const synced = await runDue()
  return { pending: pendingSyncTotal(), synced }
}
