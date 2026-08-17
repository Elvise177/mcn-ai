import { listConversations } from '../agent/conversations'
import { syncConversation } from './client'
import { dropSyncFailure, dueSyncFailures, getSyncQueue, resetSyncQueue } from '../tasks/persist'
import { tasks } from '../tasks/registry'
import { getSession } from '../auth'
import { log } from '../lib/logger'

/**
 * 聊天记录同步的重试器（设计 §3.5，审计 M-03）。
 *
 * 一期只做「失败别蒸发」——把失败落进 `tasks.json` 的 `syncQueue` 并把条数暴露到全局条；
 * 二期（这里）才是真的重试：退避 1m / 5m / 30m → 转手动，同会话只排一条，登出清队。
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
  if (!due.length) return 0
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
    log('info', 'sync', `重试 ${due.length} 条，成功 ${synced} 条，剩 ${getSyncQueue().length} 条`)
  } catch (e) {
    log('error', 'sync', `重试轮出错：${e}`)
  } finally {
    running = false
    tasks.setCloud({ pendingSync: getSyncQueue().length })
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

/** Dock 上那颗「重试」：整队 tries 归零、立刻跑一轮（转手动之后唯一的出口） */
export async function retryAllSyncs(): Promise<{ pending: number; synced: number }> {
  resetSyncQueue()
  tasks.setCloud({ pendingSync: getSyncQueue().length })
  const synced = await runDue()
  return { pending: getSyncQueue().length, synced }
}
