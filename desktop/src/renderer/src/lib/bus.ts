/** 极简跨页通信：对话里点引用 → 切到知识库页并打开对应笔记 */
export const pendingNote: { path: string | null } = { path: null }

/**
 * 任务浮窗唤回：Dock 上点一条投递任务 → 知识库页把投递箱面板重新展开。
 *
 * 用户把浮窗 ✕ 掉之后，Dock 那条迷你指示是**唯一**还能看见这个任务的地方，
 * 但它原来只 `setPage('vault')`——人已经在知识库页时就是「点了没反应」。
 *
 * 两条路都要走通：目标页**已挂载**（订阅者收到通知）与**还没挂载**（挂载时读 pending）。
 * 只做前者的话，从工作台点过去会因为「请求发生在订阅之前」而丢掉。
 */
const panelSubs = new Set<() => void>()
export const inboxPanel = {
  pending: false,
  /** Dock 点击时调用 */
  request(): void {
    this.pending = true
    panelSubs.forEach((fn) => fn())
  },
  /** 目标页处理完置回 false，避免下次挂载又弹一次 */
  consume(): boolean {
    const p = this.pending
    this.pending = false
    return p
  },
  subscribe(fn: () => void): () => void {
    panelSubs.add(fn)
    return () => void panelSubs.delete(fn)
  },
}
