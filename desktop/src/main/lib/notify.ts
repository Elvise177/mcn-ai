import { app, Notification } from 'electron'
import { log } from './logger'
import { hasWindow } from './windows'

/**
 * 系统通知 + Dock 角标（F10）。
 *
 * ## 为什么要有
 *
 * 入库一批资料要几分钟、做一个 PPT 要几十秒——用户**不会盯着看**，他会切去干别的。
 * 没有通知的话，"做完了没有"只能靠他自己想起来切回来看一眼；
 * 而 AI 要改知识库时弹的那张确认卡**60 秒不理就默认拒**，切走了根本不知道它在等人。
 *
 * ## 触发策略（REFERENCE-codex §11 + WorkBuddy）
 *
 * - **完成才通知，失败才响铃**：成功是"你可以回来看了"，静音就够；失败要占用听觉
 * - **需要输入的常驻 Dock 角标**：它不是"通知一下就完了"，是"有件事在等你"，
 *   一条会自己消失的通知配不上它
 * - **界面就在眼前时一条都不发**：他正看着呢，再弹一条系统通知只是打扰
 * - **几秒就完的活儿不通知**：拖一个文件进去、两秒转完，弹一条系统通知比不弹更烦
 */

export type NotifyKind = 'inbox-done' | 'inbox-failed' | 'artifact' | 'confirm'

/** 短于这个时长的"完成"不值得一条系统通知——用户多半还在看着 */
export const NOTIFY_MIN_MS = 20_000

/**
 * 该不该发、要不要响——**纯函数**。
 *
 * 抽出来的理由：这几条判据只有在"用户切走了 + 任务跑够久 + 恰好失败"时才走得到，
 * 真造一遍要等几分钟还得手动切窗口。而判错的代价是实打实的骚扰
 * （每拖一个文件响一声）或失声（等了一分钟的确认卡没人知道）。
 */
export function judgeNotify(p: { focused: boolean; kind: NotifyKind; elapsedMs?: number }): {
  notify: boolean
  silent: boolean
} {
  // 界面就在眼前：他正看着呢
  if (p.focused) return { notify: false, silent: true }
  if (p.kind === 'confirm') return { notify: true, silent: false } // 有件事在等他，必须响
  if (p.kind === 'inbox-failed') return { notify: true, silent: false } // 失败才响铃
  // 完成类：跑得够久才值得打断他
  if ((p.elapsedMs ?? 0) < NOTIFY_MIN_MS) return { notify: false, silent: true }
  return { notify: true, silent: true }
}

/** 当前有没有一扇窗口是聚焦的（= 用户正看着我们） */
const isFocused = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BrowserWindow } = require('electron') as typeof import('electron')
    return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
  } catch {
    return false
  }
}

/**
 * 发一条系统通知。**点它 = 把窗口带回来**——通知说"做完了"，用户的下一个动作
 * 必然是回来看，不给这一下他还得自己去 Dock 找。
 */
export function notify(kind: NotifyKind, title: string, body: string, elapsedMs?: number): boolean {
  const verdict = judgeNotify({ focused: isFocused(), kind, elapsedMs })
  if (!verdict.notify) return false
  if (!Notification.isSupported()) return false
  try {
    const n = new Notification({ title, body, silent: verdict.silent })
    n.on('click', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { BrowserWindow } = require('electron') as typeof import('electron')
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed())
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
      }
    })
    n.show()
    return true
  } catch (e) {
    // 通知发不出去（用户在系统里关了权限）不该影响主流程，记一行就够
    log('warn', 'notify', `系统通知发送失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/**
 * Dock 角标 = **有几件事在等你**（不是"有几件事在跑"）。
 *
 * 只算"需要人做点什么"的：等确认的写入、失败的任务、没同步上去的条数。
 * 把"进行中"也算进去的话，角标会在整个入库过程里一直挂着数字——
 * 那不是提醒，那是噪音。
 */
export function setAttentionBadge(count: number): void {
  if (process.platform !== 'darwin' || !app.dock) return
  try {
    app.dock.setBadge(count > 0 ? String(count) : '')
  } catch {
    /* 角标设不上不影响任何功能 */
  }
}

/** 需要人处理的事情归零了没有——给日志与断言留个读口 */
export const canNotify = (): boolean => Notification.isSupported() && hasWindow()
