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

/**
 * Cmd+F「在这一屏里找」（F8 + 用户点名的「会话内搜索」）。
 *
 * 快捷键在**主进程菜单**上注册（唯一权威，见 main/index.ts），App 收到之后转给
 * 当前这一页：工作台打开会话内查找条，知识库页聚焦笔记搜索框。
 * 与 `inboxPanel` 同一套形状——**订阅 + pending 两条路都要走通**，
 * 否则"页面还没挂载时按的那一次"会静默丢掉。
 */
const findSubs = new Set<() => void>()
export const findRequest = {
  pending: false,
  request(): void {
    this.pending = true
    findSubs.forEach((fn) => fn())
  },
  consume(): boolean {
    const p = this.pending
    this.pending = false
    return p
  },
  subscribe(fn: () => void): () => void {
    findSubs.add(fn)
    return () => void findSubs.delete(fn)
  },
}
