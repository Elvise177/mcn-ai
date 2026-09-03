/**
 * 瞬态失败的退避重试（N4，参照 REFERENCE-codex §9）。
 *
 * 三条规则，三条都是**踩过才知道要写的**：
 *  1. **指数退避**：200ms × 2ⁿ。第一次失败大概率是一次抖动，等 200ms 再试往往就过了；
 *     固定间隔重试在真故障时等于把请求量翻几倍打在一个已经躺下的服务上。
 *  2. **抖动 0.9–1.1**：不抖的话所有客户端会**同时**在第 200/400/800ms 醒来再打一次，
 *     把一次抖动放大成一次自制的 DDoS。
 *  3. **尊重 `Retry-After`**：服务端明说了要等多久就等多久，我们的公式没有它准。
 *     但要设上限——见过返回几小时的，那不该变成"应用挂死几小时"。
 *
 * 这里全是纯函数：真实的 429/503 在走查里造不出来，不抽出来它就是**没人测**的代码
 * （desktop/CLAUDE.md 铁律）。
 */

/** 第 0 次重试等这么久 */
export const BASE_MS = 200
/** 公式算出来的上限（`Retry-After` 另有上限，见下） */
export const MAX_MS = 30_000
/** `Retry-After` 再长也不等超过这个数——服务端说"一小时后再来"不该等于应用挂死一小时 */
export const RETRY_AFTER_CAP_MS = 60_000

/**
 * 解析 `Retry-After`：秒数（`120`）或 HTTP-date（`Wed, 21 Oct 2026 07:28:00 GMT`）。
 * 认不出来、是负数、或者已经过期 → null（交回给公式）。
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null
  const raw = header.trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000
    return Number.isFinite(ms) ? Math.min(ms, RETRY_AFTER_CAP_MS) : null
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  const ms = at - now
  return ms > 0 ? Math.min(ms, RETRY_AFTER_CAP_MS) : null
}

/**
 * 第 `attempt` 次重试该等多久（attempt 从 0 起）。
 *
 * `rnd` 可注入是为了让断言确定：抖动本身要测，但不能让测试跟着 Math.random 掷骰子。
 */
export function backoffMs(
  attempt: number,
  opts: {
    retryAfter?: string | null
    baseMs?: number
    maxMs?: number
    /** 返回 [0,1)，默认 Math.random */
    rnd?: () => number
    now?: number
  } = {}
): number {
  const fromHeader = parseRetryAfter(opts.retryAfter, opts.now)
  if (fromHeader !== null) return fromHeader
  const base = opts.baseMs ?? BASE_MS
  const max = opts.maxMs ?? MAX_MS
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
  // 先封顶再抖：不封顶的话 2^n 在第 30 次就溢出成 Infinity，抖动乘出来还是 Infinity
  const flat = Math.min(base * 2 ** n, max)
  const jitter = 0.9 + (opts.rnd ?? Math.random)() * 0.2
  return Math.round(flat * jitter)
}

/**
 * 这个失败**值不值得重试**。
 *
 * 判据必须窄：把 4xx 一起重试等于拿一条已经被明确拒绝的请求去反复烦服务端，
 * 而真正该做的是把拒绝原因告诉用户（401 该去重新登录，不是重试 5 次再说密钥无效）。
 * 只认三类：网络层根本没连上、被限流（429）、服务端自己挂了（5xx / 408）。
 */
export function isTransient(x: { status?: number | null; error?: unknown }): boolean {
  const s = x.status
  if (typeof s === 'number') return s === 408 || s === 429 || (s >= 500 && s < 600)
  if (x.error === undefined) return false
  const msg = x.error instanceof Error ? x.error.message : String(x.error)
  return /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|socket hang up|timed? ?out|aborted|Failed to fetch/i.test(
    msg
  )
}

/**
 * 「第 N 次重试」这句话要不要说出来（N4：**首次静默**）。
 *
 * 第一次重试在 200ms 之内就过去了，报出来只会让界面闪一下——用户的注意力比那条提示贵。
 * 从第二次起才说：那时候它已经不是抖动，是"这条线路今天不太好"。
 */
export function shouldAnnounceRetry(attempt: number): boolean {
  return attempt >= 1
}

/** 重试提示的统一文案（TaskDock 条上那一行，**不进对话历史**） */
export function retryNotice(what: string, attempt: number, max: number): string {
  return `${what}没成功，正在重试（第 ${attempt + 1}/${max} 次）`
}
