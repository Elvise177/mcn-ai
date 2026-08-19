import '../env-hooks'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { log } from '../lib/logger'
import { TIER_PRESETS, type TierId } from '../ai/tiers'
import { costCny, getPricing, routeOf, type TokenCounts } from './pricing'

/**
 * 用量记录（按月分文件的 JSONL）。
 *
 * 三条刻意的设计：
 *  1. **不挑字段、原样存**：inferera / DeepSeek 官方 / aihubmix 三条线的 usage 口径都不一样
 *     （snake_case vs camelCase、有没有 cache_* 分项、有没有 modelUsage）。在写入侧做归一化，
 *     等于把"当时以为对的口径"腌进历史数据里，以后想换算法只能重跑——所以归一化全放汇总侧。
 *  2. **写失败静默降级**：记账挡不住主流程。磁盘满/权限问题最多让统计缺一条，
 *     不能让用户的对话因此报错。
 *  3. **按月分文件**：单文件无限追加最后会大到读不动；YYYY-MM.jsonl 天然是"本月"的边界，
 *     汇总侧读一两个文件就够，开发者脚本才需要读全部。
 */

export type UsageTaskType = 'chat' | 'make-ppt' | 'make-docx' | 'ingest-tag'

export const TASK_TYPE_LABEL: Record<UsageTaskType, string> = {
  chat: '对话',
  'make-ppt': '做 PPT',
  'make-docx': '做文档',
  'ingest-tag': '入库打标',
}

export interface UsageRecord {
  ts: number
  sessionId: string
  taskType: UsageTaskType
  /** 入库打标不经档位层，记 null */
  tier: TierId | null
  /**
   * 这一轮真正打到哪条线路（`api.deepseek.com` / `aihubmix.com` …）。
   * **计价按它取单价，不按档位**——同一个 deepseek-v4-pro 在官方与中转站差 6 倍（B-2）
   */
  route?: string | null
  /** 期望模型（档位钉死的那个） */
  expected_model: string | null
  /** 服务端实际用的模型（result.modelUsage 的第一个 key），拿不到记 null */
  resolved_model: string | null
  /** 实际用到的全部模型（主 + 轻量） */
  models?: string[]
  /** 实际模型与期望不符 = 线路做了静默降级（第二道防线，见 agent/index.ts） */
  degraded?: boolean
  durationMs: number
  /** 原样存储的完整 usage 对象；拿不到就是 null */
  usage: unknown
  costUsd?: number | null
  /** 拿不到 usage 的链路（pipeline 打标）只记次数 */
  calls?: number
}

function usageDir(): string {
  return join(app.getPath('userData'), 'usage')
}

/** 本地时区的 YYYY-MM / YYYY-MM-DD（用 UTC 切月会让月初月末的记录落错文件） */
function ymd(ts: number): { month: string; day: string } {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return { month: day.slice(0, 7), day }
}

export function currentMonth(): string {
  return ymd(Date.now()).month
}

/** 追加一条。**任何异常都吞掉**——记账不能挡主流程 */
export function appendUsage(rec: UsageRecord): void {
  try {
    const dir = usageDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${ymd(rec.ts).month}.jsonl`), JSON.stringify(rec) + '\n', 'utf-8')
  } catch (e) {
    log('warn', 'usage', `用量记录写入失败（已忽略）：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 读某个月；文件不存在或某行坏了都不算错（坏行跳过，别让一条脏数据废掉整月） */
export function readMonth(month: string): UsageRecord[] {
  const f = join(usageDir(), `${month}.jsonl`)
  if (!existsSync(f)) return []
  const out: UsageRecord[] = []
  try {
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s) as UsageRecord)
      } catch {
        /* 半行/坏行：跳过 */
      }
    }
  } catch (e) {
    log('warn', 'usage', `用量文件读取失败：${e instanceof Error ? e.message : String(e)}`)
  }
  return out
}

export function listMonths(): string[] {
  try {
    return readdirSync(usageDir())
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 7))
      .sort()
  } catch {
    return []
  }
}

// ---- 归一化（只在汇总侧发生） ----

// B-2：缓存 token **必须分开**。旧实现把 cache_read/cache_creation 一起并进 input 按基础价算，
// 实测一轮 10 题问库高估 3.1 倍（¥153.83 vs 真实约 ¥49.79），缓存命中越高的档位高估越狠
const INPUT_KEYS = /^(input_tokens|inputTokens|prompt_tokens|promptTokens)$/
const CACHE_READ_KEYS = /^(cache_read_input_tokens|cacheReadInputTokens)$/
const CACHE_WRITE_KEYS = /^(cache_creation_input_tokens|cacheCreationInputTokens)$/
const OUTPUT_KEYS = /^(output_tokens|outputTokens|completion_tokens|completionTokens)$/

/**
 * 从任意形状的 usage 对象里抠出输入/输出 token。
 *
 * 关键一步是**先选子树**：我们把 `{ usage, modelUsage }` 整个存了下来，两边说的是同一批
 * token，直接递归求和会翻倍。modelUsage 更细（能看出轻量模型被用了多少），优先用它。
 */
export function tokensOf(raw: unknown): TokenCounts {
  let node: unknown = raw
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const o = node as Record<string, unknown>
    if (o.modelUsage && typeof o.modelUsage === 'object') node = o.modelUsage
    else if (o.usage && typeof o.usage === 'object') node = o.usage
  }
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 4) return
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'number') {
        if (INPUT_KEYS.test(k)) input += val
        else if (CACHE_READ_KEYS.test(k)) cacheRead += val
        else if (CACHE_WRITE_KEYS.test(k)) cacheWrite += val
        else if (OUTPUT_KEYS.test(k)) output += val
      } else walk(val, depth + 1)
    }
  }
  walk(node, 0)
  return { input, cacheRead, cacheWrite, output }
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

export interface UsageSummary {
  month: string
  /** 本月对话次数（taskType=chat） */
  chatCount: number
  /** 本月产物数（make-ppt + make-docx） */
  artifactCount: number
  /** 本月估算花费（人民币）。单价与汇率是运维配置，见 usage/pricing.ts */
  costCny: number
  totalCount: number
  empty: boolean
  /**
   * 最近 14 天（含今天），按天使用次数 —— **按档位分段**（页面画成同柱堆叠）。
   * 分段的意义不在好看：一天 20 次全是标准档、和 20 次里有 5 次增强档，
   * 花的钱差一个数量级，只画总次数看不出这件事。
   * 老记录没有 `tier` 字段（档位层是 2026-08-17 才上的）→ 计入 standard，
   * 那时候只有一条线路，归到标准档是符合事实的。
   */
  daily: Array<{ date: string; count: number; standard: number; enhanced: number }>
  /** 按档位的花费对比（成本透明化核心：次数 / tokens / ¥花费 三列并排） */
  byTier: Array<{
    tier: TierId
    label: string
    count: number
    input: number
    /** 缓存读（按线路的折扣率计价，不再当成全价输入）*/
    cacheRead: number
    output: number
    total: number
    costCny: number
  }>
  /** 按任务类型细分 */
  byType: Array<{
    type: UsageTaskType
    label: string
    count: number
    tokens: number
    costCny: number
    medianMs: number
  }>
}

/** 最近 N 天可能跨月，把涉及到的月文件都读进来 */
function readRecentDays(days: number): UsageRecord[] {
  const months = new Set<string>()
  for (let i = 0; i < days; i++) months.add(ymd(Date.now() - i * 86_400_000).month)
  return [...months].flatMap((m) => readMonth(m))
}

export function summarize(month = currentMonth()): UsageSummary {
  const recs = readMonth(month)
  // 单价/汇率读一次就够（getPricing 顺带把默认值补齐落盘，脚本侧靠这一份）
  const pricing = getPricing()
  /** 一条记录的花费：按它自己的档位算，不同档位单价差几十倍，不能混一个均价 */
  const recCost = (r: UsageRecord): number =>
    costCny(r.route, r.resolved_model ?? r.expected_model, tokensOf(r.usage), pricing)

  const byTier = (['standard', 'enhanced'] as TierId[]).map((tier) => {
    const rs = recs.filter((r) => r.tier === tier)
    const sum: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    for (const r of rs) {
      const t = tokensOf(r.usage)
      sum.input += t.input
      sum.cacheRead += t.cacheRead
      sum.cacheWrite += t.cacheWrite
      sum.output += t.output
    }
    return {
      tier,
      label: TIER_PRESETS[tier].label,
      count: rs.length,
      input: sum.input,
      cacheRead: sum.cacheRead,
      output: sum.output,
      total: sum.input + sum.cacheRead + sum.cacheWrite + sum.output,
      // 逐条算再相加：同一档位里可能混着不同线路（老用户迁移期），一把均价会算错
      costCny: rs.reduce((n, r) => n + recCost(r), 0),
    }
  })

  const byType = (Object.keys(TASK_TYPE_LABEL) as UsageTaskType[])
    .map((type) => {
      const rs = recs.filter((r) => r.taskType === type)
      const tokens = rs.reduce((n, r) => {
        const t = tokensOf(r.usage)
        return n + t.input + t.cacheRead + t.cacheWrite + t.output
      }, 0)
      return {
        type,
        label: TASK_TYPE_LABEL[type],
        count: rs.reduce((n, r) => n + (r.calls ?? 1), 0),
        tokens,
        costCny: rs.reduce((n, r) => n + recCost(r), 0),
        medianMs: median(rs.map((r) => r.durationMs).filter((n) => n > 0)),
      }
    })
    .filter((r) => r.count > 0)

  // 最近 14 天：日期轴要连续（没记录的那天也得有一根 0 高的柱子，否则时间被压缩看不出趋势）
  const recent = readRecentDays(14)
  const daily: UsageSummary['daily'] = []
  for (let i = 13; i >= 0; i--) {
    const date = ymd(Date.now() - i * 86_400_000).day
    const day = recent.filter((r) => ymd(r.ts).day === date)
    const enhanced = day.filter((r) => r.tier === 'enhanced').length
    daily.push({ date, count: day.length, standard: day.length - enhanced, enhanced })
  }

  return {
    month,
    chatCount: recs.filter((r) => r.taskType === 'chat').length,
    artifactCount: recs.filter((r) => r.taskType === 'make-ppt' || r.taskType === 'make-docx').length,
    costCny: recs.reduce((n, r) => n + recCost(r), 0),
    totalCount: recs.length,
    empty: recs.length === 0,
    daily,
    byTier,
    byType,
  }
}
