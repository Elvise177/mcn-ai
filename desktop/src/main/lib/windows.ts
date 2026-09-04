import { BrowserWindow } from 'electron'

/**
 * 下行事件的统一出口（PLAN-v2 批 3，Cmd+N 多窗口）。
 *
 * ## 为什么必须有它
 *
 * 五个管理器（vault / inbox / agent / artifacts / tasks）原来各存一个 `this.win`，
 * 由 `createWindow()` 挨个 `attachWindow(win)`。**单窗口时这没问题，开第二个窗口的那一刻就散了**：
 * 后建的窗口把每个管理器的 `this.win` 覆盖掉，第一个窗口从此收不到任何事件——
 * 投递箱进度不动、AI 的流式正文不出、产物生成了也不刷新。
 * 而这类故障的表现是"界面静静地不动"，最难查。
 *
 * 现在一律广播给所有活着的窗口。渲染层本来就按 `sessionId` / 任务 id 认领事件
 * （`agent:stream` 那条从第一天起就是这么写的），多收几条不属于自己的事件是无害的。
 *
 * **push 尽力而为、snapshot 才是权威**这条约定不变：窗口 reload 期间照样会丢事件，
 * 所以渲染层每次挂载仍要先拉一次快照打底。
 */

/** 还有没有窗口能显示东西（无头冒烟里恒为 false：那时没人能点确认卡） */
export const hasWindow = (): boolean => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())

/** 广播一条下行事件。已销毁的窗口自动跳过 */
export function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    w.webContents.send(channel, payload)
  }
}
