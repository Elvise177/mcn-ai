import { tokensOf } from '../usage'

/**
 * 一轮 agent 的 `result` 消息该怎么判（PLAN-v2 批 5 R9）。
 *
 * ## 为什么非抽出来不可
 *
 * 这里的每一条分支都**只有真实调用才走得到**：要上游真的返回 401、真的把模型换掉、
 * 真的在 `subtype:'success'` 里塞 `is_error:true`。desktop/CLAUDE.md 的铁律
 * （「这段逻辑要不要花钱/等几十分钟才能触发？要，就抽出来」）点名的正是这一类。
 *
 * 而它同时是**四件事的交汇点**，四件事的容错方向还各不相同——散在 `runOnce` 的
 * 三百行里，改任何一条都可能悄悄碰坏另外三条：
 *
 *  1. **显示**：这一轮算成功还是出错（出错走 zhError 中文映射 + 气泡里给「重试」）
 *  2. **降级检测**：服务端有没有把模型换掉（Q15 的档位角标靠它）
 *  3. **记账**：这一轮该不该进用量 jsonl
 *  4. **会话续接**：`session_id` 能不能留给下一轮 resume
 *
 * ## 三条判据是分开的，别图省事合并
 *
 * · 显示只认 `is_error`，**不认 `api_error_status`** —— 后者在记账那边的语义是
 *   "存疑就别计费"（宁可少记一条，代价为零），搬到显示上却会把一条**真回答**
 *   判成错误、连正文一起丢掉。两边的容错方向正好相反。
 * · 记账**还要求真的产生过 token**：中转站余额耗尽那轮，8 个失败请求全是
 *   `subtype:'success'` + token 全 0，不加这一条就会被记进 jsonl（B-2 实测）。
 * · 会话续接认 `is_error || api_error_status` —— 失败那一轮给的 `session_id`
 *   很可能压根没在 CLI 侧落过盘，留着它会让这个对话此后**每次**发送都报
 *   「No conversation found」，一个失败轮次废掉整个对话。
 */

/** SDK 的 result 消息里我们真正会读的那些字段（结构按 `@anthropic-ai/claude-agent-sdk`） */
export interface SdkResultLike {
  subtype?: string
  /** `subtype !== 'success'` 时的错误清单 */
  errors?: string[]
  is_error?: boolean
  api_error_status?: number | null
  /** 正文（`is_error` 时装的是英文原文，只进日志） */
  result?: string
  /** 模型 → 用量。key 的顺序由服务端给，**不许当成"主模型在前"** */
  modelUsage?: Record<string, unknown>
  usage?: unknown
  session_id?: string
}

/** 四件事共用的那部分（不分成败都成立） */
interface VerdictBase {
  /** 这一轮实际用到的全部模型（主 + 轻量） */
  models: string[]
  /** 实际模型里没有期望的那个 = 线路做了静默降级 */
  degraded: boolean
  /** 记进用量的"实际模型"，见下面的注释 */
  resolvedModel: string | null
  /** 这一轮该不该记账 */
  billable: boolean
  /** `session_id` 能不能留给下一轮 resume */
  sessionUsable: boolean
}

/**
 * **写成可辨识联合而不是 `error?: string`**：调用方在 `kind === 'error'` 分支里
 * 直接就能拿到一个确定是 `string` 的 `error`，不用再 `?? ''` 兜一次——
 * 那种兜底会把"判成错误却没有错误文本"这种自相矛盾的状态悄悄变成一句空话。
 */
export type ResultVerdict =
  | (VerdictBase & {
      kind: 'error'
      /** 原始文本。**英文原文只进日志**，界面走 zhError 映射 */
      error: string
      billable: false
    })
  | (VerdictBase & { kind: 'ok' })

export function judgeResult(msg: SdkResultLike, expectedModel: string): ResultVerdict {
  const modelUsage = msg.modelUsage ?? {}
  const models = Object.keys(modelUsage)
  const degraded = models.length > 0 && !models.includes(expectedModel)
  /**
   * 「这一轮实际是谁服务的」= **主模型在不在里面**。
   *
   * 不能直接取 `models[0]`：一轮里往往同时出现主模型与轻量模型（起标题、压上下文），
   * key 的顺序是服务端给的。实测标准档那一轮排在前面的是 `deepseek-v4-flash`——
   * 记成 flash 就等于报告"我要 pro，实际用了 flash"，看着像被降级，
   * 其实 pro 就在同一个 modelUsage 里（2026-08-17 真实调用对账时抓到）。
   * 被真降级时 models 里没有主模型，这里自然落到实际那个。
   */
  const resolvedModel = models.includes(expectedModel) ? expectedModel : (models[0] ?? null)
  const isError = msg.is_error === true
  const sessionUsable = !isError && !msg.api_error_status
  const base = { models, degraded, resolvedModel, sessionUsable }

  if (msg.subtype !== 'success') {
    const errs = (msg.errors ?? []).map((e) => e.trim()).filter(Boolean)
    return { ...base, kind: 'error', billable: false, error: errs.join('; ') || `出错：${msg.subtype}` }
  }
  if (isError) {
    // T-02：`subtype:'success'` 但 `is_error:true` —— 上游 401/403/额度不足长的就是这样，
    // `result` 里装的是英文原文（`Failed to authenticate. API Error: 401 …`）
    return {
      ...base,
      kind: 'error',
      billable: false,
      error: (msg.result ?? '').trim() || '出错：上游返回了一个错误结果',
    }
  }

  const hasTokens = tokensOf({ usage: msg.usage, modelUsage }).output > 0
  return { ...base, kind: 'ok', billable: !msg.api_error_status && hasTokens }
}
