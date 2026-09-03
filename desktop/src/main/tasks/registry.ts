import type { BrowserWindow } from 'electron'
import type { CloudState, Task, TaskEventPayload, TaskStatus } from './types'
import { getSyncQueue } from './persist'

/**
 * 全局任务注册表（设计见 docs/DESIGN-task-state.md §1.5 / §2）。
 *
 * 唯一真相源：主进程。渲染层的 store 只是它的镜像，页面组件是纯投影。
 * **push 尽力而为，snapshot 是权威**——webContents.send 在窗口 reload 期间发出的事件
 * 会静默丢失（现在 inbox:event 就是这么丢的），所以渲染层每次挂载都要先 tasks:list 打底。
 */

/** 终态任务在 recent 里保留多久 */
const RECENT_TTL_MS = 30 * 60_000
const RECENT_MAX = 20
/** 高频字段（agent draft）的推送节流 */
const THROTTLE_MS = 500

/** 分发式 Omit：直接 Omit<Task,...> 在联合类型上只会留下公共字段，各 kind 的专属字段会被吃掉 */
type TaskInit = {
  [K in Task['kind']]: Omit<Extract<Task, { kind: K }>, 'seq' | 'startedAt' | 'status'> & {
    status?: TaskStatus
  }
}[Task['kind']]

class TaskRegistry {
  private win: BrowserWindow | null = null
  /** 未终态 */
  private active = new Map<string, Task>()
  /** 终态，环形 */
  private recent: Task[] = []
  private cloud: CloudState = {
    reachable: null,
    loggedIn: false,
    checkedAt: 0,
    pendingSync: 0,
  }
  private seq = 0
  private throttled = new Map<string, ReturnType<typeof setTimeout>>()

  /** 测试观察口：无头冒烟不经 IPC 直接收事件 */
  tap: ((p: TaskEventPayload) => void) | null = null

  attachWindow(win: BrowserWindow): void {
    this.win = win
    this.cloud = { ...this.cloud, pendingSync: getSyncQueue().length }
  }

  private emit(payload: TaskEventPayload): void {
    this.tap?.(payload)
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('task:event', payload)
  }

  private find(id: string): Task | undefined {
    return this.active.get(id) ?? this.recent.find((t) => t.id === id)
  }

  get(id: string): Task | undefined {
    return this.find(id)
  }

  /** 同一实体重跑复用同一个 id：直接覆盖旧的那条，不累积僵尸条目 */
  start(init: TaskInit): Task {
    const t = {
      ...init,
      status: init.status ?? 'running',
      startedAt: Date.now(),
      seq: ++this.seq,
    } as Task
    this.recent = this.recent.filter((x) => x.id !== t.id)
    this.active.set(t.id, t)
    this.emit({ type: 'upsert', task: t })
    return t
  }

  /**
   * 局部更新。throttle=true 用于 agent draft 这类每 token 都会动的字段——
   * 值立刻写进内存（snapshot 永远是最新的），只是推送合并到 500ms 一次。
   */
  patch(id: string, p: Partial<Task>, throttle = false): Task | undefined {
    const t = this.find(id)
    if (!t) return undefined
    Object.assign(t, p)
    t.seq = ++this.seq
    if (!throttle) {
      this.flush(id)
      return t
    }
    if (!this.throttled.has(id)) {
      this.throttled.set(
        id,
        setTimeout(() => {
          this.throttled.delete(id)
          this.flush(id)
        }, THROTTLE_MS)
      )
    }
    return t
  }

  private flush(id: string): void {
    const pending = this.throttled.get(id)
    if (pending) {
      clearTimeout(pending)
      this.throttled.delete(id)
    }
    const t = this.find(id)
    if (t) this.emit({ type: 'upsert', task: t })
  }

  /**
   * 撤掉一条任务（不进 recent）。用于"这件事其实压根没开始"——比如 AI 发送前的预检
   * 就没过：留一条 failed 只会在 Dock 上挂一句红字，而它并不是一次真的失败。
   */
  drop(id: string): void {
    const pending = this.throttled.get(id)
    if (pending) {
      clearTimeout(pending)
      this.throttled.delete(id)
    }
    this.active.delete(id)
    this.recent = this.recent.filter((t) => t.id !== id)
    this.emit({ type: 'remove', id })
  }

  finish(id: string, status: 'succeeded' | 'failed' | 'canceled', error?: string): void {
    const t = this.active.get(id)
    if (!t) return
    t.status = status
    t.endedAt = Date.now()
    if (error) t.error = error
    t.seq = ++this.seq
    this.active.delete(id)
    this.recent = [t, ...this.recent.filter((x) => x.id !== id)].slice(0, RECENT_MAX)
    this.flush(id)
  }

  /** active 全部 + 未过期的 recent（全局条只看 active，面板要看 recent） */
  snapshot(): { tasks: Task[]; cloud: CloudState } {
    const cutoff = Date.now() - RECENT_TTL_MS
    this.recent = this.recent.filter((t) => (t.endedAt ?? 0) > cutoff)
    return { tasks: [...this.active.values(), ...this.recent], cloud: this.cloud }
  }

  /** 重启后把上一轮的终态结果塞进 recent（面板仍能看到「上次 6/6 完成」） */
  seedRecent(t: Task): void {
    this.recent = [t, ...this.recent.filter((x) => x.id !== t.id)].slice(0, RECENT_MAX)
  }

  getCloud(): CloudState {
    return this.cloud
  }

  setCloud(p: Partial<CloudState>): void {
    const next = { ...this.cloud, ...p, checkedAt: Date.now() }
    // 没有实质变化就不推（探测是高频的，别把渲染层刷疯）
    const same =
      next.reachable === this.cloud.reachable &&
      next.loggedIn === this.cloud.loggedIn &&
      next.email === this.cloud.email &&
      next.lastError === this.cloud.lastError &&
      next.retrying === this.cloud.retrying &&
      next.pendingSync === this.cloud.pendingSync
    this.cloud = next
    if (!same) this.emit({ type: 'cloud', cloud: next })
  }
}

export const tasks = new TaskRegistry()
