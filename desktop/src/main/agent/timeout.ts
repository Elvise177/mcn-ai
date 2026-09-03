/**
 * agent 一轮的墙钟超时判据（PLAN-v2 R3，2026-09-02）。
 *
 * ## 为什么要有它
 *
 * 一轮对话以前只有两道闸：`maxTurns: 40` 与扫描次数 `SCAN_LIMIT`。**没有时间闸**——
 * 模型卡在上游慢响应 / SDK 对 5xx 的重试退避 / 一个永不返回的黑洞地址时，
 * 界面上的光标可以无限期转下去，用户只能自己点停止；无人值守（比如晚上挂着做 PPT）
 * 就是一直烧额度（审计 b2）。
 *
 * ## 形态：软提醒 → 硬中断（借 Codex `handle_task_abort` 的思路）
 *
 * - **80%** 时提醒一次（notice toast「已运行 N 分钟，M 分钟后仍未完成会自动中断」）——
 *   给用户一个介入的机会：真在等一个长任务的可以去管理员区把上限调大。
 * - **100%** 时硬中断：调用方按「先把半截正文落盘 → 再 abort → 最后发 error 事件」的顺序做
 *   （顺序写在 `agent/index.ts`，与 H-09 停止生成同一个理由：反过来渲染层收到 done 就清屏）。
 *
 * ## 为什么是纯函数
 *
 * 真造一次超时要等 15 分钟；抽成纯函数后 `smoke:guards` 毫秒级验完边界（0 关、79/80/100%、
 * 提醒只发一次），走查只负责验「接线对不对」（`MCNAI_E2E_AGENT_TIMEOUT=3000` 造一次 3 秒的）。
 * 判据：这段逻辑要不要花钱/等几十分钟才能触发？要，就抽出来（desktop/CLAUDE.md 铁律）。
 */

/** 出厂上限：15 分钟。管理员区可改（`store.agentTimeoutMin`），0 = 关闭 */
export const DEFAULT_AGENT_TIMEOUT_MIN = 15

/** 软提醒落在上限的这个比例上 */
export const WARN_RATIO = 0.8

export type TimeoutVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; message: string }
  | { kind: 'abort'; message: string }

/** 分钟数的人话：不满 1 分钟按秒说，否则保留一位小数（3.0 → 3） */
export function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  const m = ms / 60_000
  const s = Number.isInteger(m) ? String(m) : m.toFixed(1).replace(/\.0$/, '')
  return `${s} 分钟`
}

/**
 * @param startedAt 这一轮开始的时刻（ms）
 * @param now       当前时刻（ms）
 * @param limitMs   上限（ms）；≤ 0 表示关闭
 * @param warned    软提醒是否已经发过（发过就不再 warn，直接等 abort）
 */
export function judgeTimeout(startedAt: number, now: number, limitMs: number, warned: boolean): TimeoutVerdict {
  if (!Number.isFinite(limitMs) || limitMs <= 0) return { kind: 'ok' }
  const elapsed = Math.max(0, now - startedAt)
  if (elapsed >= limitMs) {
    return {
      kind: 'abort',
      message: `这一轮已运行 ${humanDuration(elapsed)}，超过上限 ${humanDuration(limitMs)}，已自动中断。可以重试，或在设置的运维配置里调整上限。`,
    }
  }
  if (!warned && elapsed >= limitMs * WARN_RATIO) {
    return {
      kind: 'warn',
      message: `这一轮已运行 ${humanDuration(elapsed)}，${humanDuration(limitMs - elapsed)}后仍未完成会自动中断`,
    }
  }
  return { kind: 'ok' }
}

/**
 * 把「分钟数配置 + e2e 覆盖」换算成毫秒。**`MCNAI_E2E_AGENT_TIMEOUT` 只给走查**（判据同 HANDOFF §4-22：
 * 真造一次超时要等 15 分钟，走查里做不到），生产不读别的来源。
 */
export function resolveTimeoutMs(configuredMin: unknown, e2eOverrideMs: string | undefined): number {
  const e2e = Number(e2eOverrideMs)
  if (e2eOverrideMs && Number.isFinite(e2e) && e2e > 0) return e2e
  const min = Number(configuredMin)
  if (!Number.isFinite(min) || min < 0) return DEFAULT_AGENT_TIMEOUT_MIN * 60_000
  return min * 60_000
}
