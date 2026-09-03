/**
 * 同步失败的退避阶梯（设计 §3.5）——**两条队列共用一份判据**。
 *
 * 聊天记录（`syncQueue`）与笔记上云（`noteSyncQueue`，F3）走的是同一套：
 * 1m → 5m → 30m → 转手动。写两份的下场是它们迟早会漂开，
 * 而用户在界面上看到的是**一个数字**「N 条待同步」，两套阶梯只会让这个数字变得没法解释。
 *
 * **为什么单独一个文件**：`tasks/persist.ts` 一加载就 new 一个 electron-store
 * （要 `app.getPath`），主进程侧的冒烟（`ELECTRON_RUN_AS_NODE`）根本 import 不进去。
 * 判据搬到这里之后，「第 4 次转手动」「换库之后不重传别人家的笔记」这些
 * 只有真失败才走得到的分支就能零花费断言（desktop/CLAUDE.md 铁律）。
 */

/**
 * 退避阶梯：1m → 5m → 30m → 转手动。
 * 不给"永远重试"——离线一整天回来一次性打几百个请求，比失败本身更糟。
 */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000]

/**
 * 第 `tries` 次失败之后，下一次自动重试的时间戳。
 * 超出阶梯长度返回 **0 = 转手动**，此后只能由用户点 Dock 上那颗「重试」。
 */
export function nextRetryAt(tries: number, now = Date.now()): number {
  return tries >= 1 && tries <= BACKOFF_MS.length ? now + BACKOFF_MS[tries - 1] : 0
}

/** 队列条目里跟"该不该现在重试"有关的那部分 */
export interface RetryItem {
  nextRetryAt: number
}

/** 到点该自动重试的（`nextRetryAt=0` 已转手动，不在自动范围内） */
export function pickDue<T extends RetryItem>(items: T[], now = Date.now()): T[] {
  return items.filter((x) => x.nextRetryAt > 0 && x.nextRetryAt <= now)
}

/**
 * 笔记重传的**库归属闸门**（F3）。
 *
 * `ingestNote` 是按"当前库根 + 相对路径"读盘的。换库之后拿新库的根去读旧库的相对路径，
 * 读到的要么是别的文件、要么读不到——**前一种会把错内容真传上云**。
 * 不属于当前库的先留在队列里不动，等他切回去那天。
 */
export function notesForRoot<T extends { root: string }>(items: T[], currentRoot: string | null): T[] {
  return currentRoot ? items.filter((x) => x.root === currentRoot) : []
}
