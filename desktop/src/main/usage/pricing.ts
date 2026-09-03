import { store } from '../store'
import { log } from '../lib/logger'

/**
 * 用量计价（估算口径，不是账单）。
 *
 * 两条约定不变：
 *  1. **单价与汇率是运维配置**：只在设置页的管理员区可见可改，普通用户看到的永远是人民币结果
 *  2. **只有一份真相**：默认值写在这里，`getPricing()` 把它**落进 store**，
 *     `scripts/usage-report.mjs` 直接读 `userData/config.json` 的 `pricing`
 *
 * **2026-08-18 重做（B-2），两处口径都是被真实账单打脸打出来的**：
 *
 * ① **按「线路 × 模型」取价，不按档位语义取。**
 *    档位是用户看得见的东西，但**钱是按线路收的**。对账查实：同一个 `deepseek-v4-pro`，
 *    DeepSeek 官方 ¥4.50/¥13.50，aihubmix $1.69/$3.38 ≈ ¥12.17/¥24.34——**输入贵 2.7 倍**。
 *    （这个倍数一开始写的是 6 倍，那是拿倒推的官方美元价算的；拿到官方账单后修正为 2.7 倍。）
 *    老用户被 `migrateTiers` 搬到中转站后，用量页按「标准档=官方价」显示、账单按中转站价出，
 *    同一批 token 差 2.7 倍而页面上完全看不出来。
 *
 * ② **缓存 token 分开计价，折扣率挂在「模型」上。**
 *    旧实现把 `cache_read_input_tokens` 与 `cache_creation_input_tokens` 一起并进 `input`
 *    按基础价算。实测一轮 10 题问库：产品口径 ¥153.83，真实约 ¥49.79，**高估 3.1 倍**，
 *    而且缓存命中越高的档位高估越狠。
 *
 *    **折扣率不是线路级的，是模型级的**——这一条我判断错过一次，从账单反解才改对：
 *    同一条 aihubmix 线路上，`claude-opus-5` 的缓存读是 **0.1**（21 条样本，中位 0.109），
 *    而 `deepseek-v4-pro` 是 **1.0**（393 条样本，全部精确等于 1）。
 *    我先按线路配、把从 deepseek 行归纳出的 1.0 套到了 opus 上，
 *    结果把增强档的缓存部分高估约 10 倍——而 opus 会话恰恰缓存占比最高
 *    （实测一轮增强档：纯 input 9,341，缓存读 1,097,245）。
 *    **教训：从一个模型的账单行归纳出的结论，不要当成整条线路的性质。**
 *
 * ③ **单价带币种，官方线路直接按人民币配。**（2026-08-18 补，拿到官方账单后）
 *    在此之前 DeepSeek 官方那组是「美元 × 汇率」倒推的估值，两处都错：
 *    真实计费 v4-pro 输入 **¥4.50/1M**（我配 ¥2.016，**低估 2.23 倍**）、输出 **¥13.50/1M**
 *    （我配 ¥7.92，低估 1.70 倍）；缓存读倍率真值 **1/30**（我按 DeepSeek 公开价猜的 0.1，
 *    当时代码里就标着「未验证的假设」——账单一到就被打脸）。
 *    **官方账单原生就是 CNY**，再让它经过一次美元换算，只会让「改汇率」把官方线路的估算
 *    一起改坏。所以线路上加 `currency`：`deepseek` 直接配人民币、不乘汇率。
 *
 *    校验方式：`amount` 表逐行 `price × amount` 汇总，与 `cost` 表逐日逐模型比对，
 *    10/10 条精确相等（误差 < 1e-6）——说明 `price` 列就是真实单价、单位 CNY/token。
 *
 * ⚠️ **DeepSeek 有分时定价，估算天然有 ±1 倍的误差。** 账单里同一天同一模型出现过 2 倍差价
 *    （08-16 的 v4-flash：输入 ¥1.5 与 ¥3、输出 ¥4.5 与 ¥9，缓存倍率都还是 1/30，
 *    说明是同一套价目的两个时段档，不是改价）。
 *    这里配的是 2026-08-17 实际计费的那一档。**没查清哪一档对应高峰**：当天 v4-pro 全天只出现
 *    一个价位（4.5），而已知那天既有北京时间 05:44 的跑批也有 09:00 后的跑批，
 *    横跨了官方公布的错峰窗口（00:30–08:30）却没分档——所以"4.5 是高峰价"只是猜测，没写进结论。
 *    不做分时逻辑是有意的：计价配置是运维项，跟着官方调价手动改一次即可，
 *    在产品里内建一套时段表反而多一处会过期的真相。
 */

export interface ModelPrice {
  /** 每百万输入 token 的单价，币种由所属线路的 `currency` 决定 */
  in: number
  /** 每百万输出 token 的单价，币种由所属线路的 `currency` 决定 */
  out: number
  /**
   * 缓存读的价格倍率（相对 `in`）。**挂在模型上，不是挂在线路上**——
   * 2026-08-18 从账单反解：同一条 aihubmix 线路，`claude-opus-5` 的缓存读是 **0.1**（21 条样本），
   * 而 `deepseek-v4-pro` 是 **1.0**（393 条样本，全部精确等于 1）。
   * 我一开始按线路配，把从 deepseek 行归纳的 1.0 套到了 opus 上，
   * 结果把增强档的缓存部分高估约 10 倍——而 opus 会话恰恰缓存占比最高。
   */
  cacheRead?: number
  /** 缓存写的价格倍率（相对 `in`） */
  cacheWrite?: number
}

export interface RoutePrice {
  /** 模型串 → 单价；查不到时用 `default` */
  models: Record<string, ModelPrice>
  default: ModelPrice
  /** 该线路的缺省缓存倍率；模型自己配了就以模型的为准 */
  cacheRead: number
  cacheWrite: number
  /**
   * 这条线路单价的币种，缺省 `USD`（要乘汇率）。
   * **DeepSeek 官方账单原生就是人民币**，配成 `CNY` 后不再过一次美元换算——
   * 否则运维改汇率会把官方线路的估算一起改坏。
   */
  currency?: 'USD' | 'CNY'
}

export interface PricingConfig {
  routes: Record<string, RoutePrice>
  /** 美元 → 人民币汇率，**只作用于 `currency` 为 USD 的线路** */
  usdCny: number
  /** 老版本按档位配的单价，改版时原样留着不丢（只读留档，不参与计算） */
  legacyTierUsd?: Record<string, ModelPrice>
  /**
   * 出厂单价的版本号。**存档里的版本落后于 `PRICING_REV` 时，该线路整组重置为出厂价**。
   *
   * 一般来说「存档优先」是对的（不能把运维改过的价打回去），但出厂价被查实**算错**时，
   * 存档优先反而让修复永远到不了已装的机器——旧 config 里那份错价会一直赢。
   * 2026-08-18 就是这个情况：官方线路的单价低估 2 倍多，不重置的话线上照旧低估。
   * 重置前把整份旧配置抄进 `archived`，改过什么仍然查得到。
   */
  rev?: number
  /** 被版本迁移重置掉的旧配置留档（只读，不参与计算） */
  archived?: { rev: number; at: string; pricing: unknown }[]
}

/**
 * 出厂单价版本。**只在出厂价被查实算错、必须覆盖存档时 +1**；正常调价不用动
 * （运维在管理员区改的价本来就该盖过出厂值）。
 *
 * - `1`：初版，按档位配
 * - `2`：改按线路 × 模型配（B-2）
 * - `3`：2026-08-18 拿到 DeepSeek 官方账单，官方线路改人民币原生计价并修正单价
 */
export const PRICING_REV = 3

/**
 * 出厂单价。**两组都抄自真实后台账单，不是估的**：
 * DeepSeek 官方来自 2026-08-17 的官方账单导出（人民币原生），
 * aihubmix 来自 2026-08-18 的中转站明细（`Input price`/`Output price` 两列，美元）。
 */
export const DEFAULT_PRICING: PricingConfig = {
  routes: {
    deepseek: {
      // 人民币原生，别乘汇率。数值取自官方账单 2026-08-17 那一档（见文件头 ③ 与分时说明）
      currency: 'CNY',
      models: {
        'deepseek-v4-pro': { in: 4.5, out: 13.5 },
        'deepseek-v4-flash': { in: 1.5, out: 4.5 },
      },
      default: { in: 4.5, out: 13.5 },
      // 缓存读固定是输入价的 1/30：三个价位档（4.5→0.15、1.5→0.05、3→0.1）全部精确成立
      cacheRead: 1 / 30,
      cacheWrite: 1.0,
    },
    aihubmix: {
      currency: 'USD', // 中转站按美元结算，走汇率换算
      models: {
        // Anthropic 系：缓存读打 0.1（账单反解，21 条样本中位 0.109）
        'claude-opus-5': { in: 5, out: 25, cacheRead: 0.1 },
        'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.1 },
        'claude-haiku-4-5': { in: 1.1, out: 5.5, cacheRead: 0.1 },
        'claude-sonnet-4-5-20250929': { in: 3.3, out: 16.5, cacheRead: 0.1 },
        // DeepSeek 系走中转站：缓存**不打折**（393 条样本全部精确等于 1.0）
        'deepseek-v4-pro': { in: 1.69, out: 3.38, cacheRead: 1.0 },
        'deepseek-v4-flash': { in: 0.142, out: 0.381, cacheRead: 1.0 },
        'text-embedding-3-small': { in: 0.02, out: 0.02 },
      },
      default: { in: 5, out: 25 },
      cacheRead: 1.0, // 线路缺省取保守值：认不出的模型宁可估高，别让人以为很便宜
      cacheWrite: 1.0,
    },
  },
  usdCny: 7.2,
}

/**
 * baseUrl → 线路键。键名 `aihubmix` 是用量 jsonl 里已落盘的 `route` 值，**不改名**（历史账不能断）；
 * 它的语义现在是「中转站」：`api.inferera.com` 与 `aihubmix.com` 同一家、同一套价（§4-17 已查实）
 */
export function routeOf(baseUrl: string | undefined | null): string {
  const h = String(baseUrl ?? '').toLowerCase()
  if (h.includes('api.deepseek.com')) return 'deepseek'
  if (h.includes('aihubmix.com') || h.includes('inferera.com')) return 'aihubmix'
  return 'custom'
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback

function mergeRoute(raw: Partial<RoutePrice> | undefined, def: RoutePrice): RoutePrice {
  const models: Record<string, ModelPrice> = { ...def.models }
  for (const [m, p] of Object.entries(raw?.models ?? {})) {
    models[m] = {
      in: num(p?.in, def.models[m]?.in ?? def.default.in),
      out: num(p?.out, def.models[m]?.out ?? def.default.out),
      ...(p?.cacheRead != null || def.models[m]?.cacheRead != null
        ? { cacheRead: num(p?.cacheRead, def.models[m]?.cacheRead ?? def.cacheRead) }
        : {}),
    }
  }
  return {
    models,
    default: { in: num(raw?.default?.in, def.default.in), out: num(raw?.default?.out, def.default.out) },
    cacheRead: num(raw?.cacheRead, def.cacheRead),
    cacheWrite: num(raw?.cacheWrite, def.cacheWrite),
    // 币种是线路的固有属性，不开放给管理员区改：改它等于把单价整体缩放 7 倍，
    // 而单价本身就能直接改，没必要多留一个能把账算错一个数量级的旋钮
    currency: def.currency ?? 'USD',
  }
}

/**
 * 读配置并**补齐落盘**。
 *
 * 合并而不是覆盖：老用户在管理员区改过的单价不能被打回默认。
 * 结构从「按档位」换成「按线路」时，老那份 `usd.standard/enhanced` **原样搬进
 * `legacyTierUsd` 留档**并打一条 log——直接丢掉的话，用户改过什么就再也查不到了。
 */
export function getPricing(): PricingConfig {
  const stored = store.get('pricing') as
    | (Partial<PricingConfig> & { usd?: Record<string, ModelPrice> })
    | undefined

  // 出厂价被查实算错时（PRICING_REV 前进），存档不能再赢——出厂线路整组回出厂价，旧的抄进 archived
  const stale = stored != null && (stored.rev ?? 1) < PRICING_REV
  const archived = [...(stored?.archived ?? [])]
  if (stale) {
    // 抄留档时剥掉 archived 本身，否则每次迁移都把上一份整个套进去，越滚越大
    const { archived: _drop, ...snapshot } = stored
    archived.push({ rev: stored.rev ?? 1, at: new Date().toISOString(), pricing: snapshot })
    log(
      'info',
      'usage',
      `计价配置版本 ${stored.rev ?? 1} → ${PRICING_REV}，出厂线路单价已重置（旧配置留档到 archived）`
    )
  }
  // 重置只针对出厂线路——错价出在出厂值上。用户自建线路的价是他自己填的，任何时候都原样留着
  const raw = stale ? undefined : stored

  const routes: Record<string, RoutePrice> = {}
  for (const [k, def] of Object.entries(DEFAULT_PRICING.routes)) {
    routes[k] = mergeRoute(raw?.routes?.[k], def)
  }
  for (const [k, v] of Object.entries(stored?.routes ?? {})) {
    if (!routes[k]) routes[k] = mergeRoute(v, DEFAULT_PRICING.routes.aihubmix)
  }

  const merged: PricingConfig = {
    routes,
    // 汇率不参与重置：算错的是线路单价，运维调过的汇率没理由被打回去
    usdCny: num(stored?.usdCny, DEFAULT_PRICING.usdCny),
    rev: PRICING_REV,
    // 留档字段同理，跨重置保留
    ...(stored?.legacyTierUsd || stored?.usd
      ? { legacyTierUsd: stored.legacyTierUsd ?? stored.usd }
      : {}),
    ...(archived.length ? { archived } : {}),
  }
  if (stored?.usd && !stored.legacyTierUsd) {
    log('info', 'usage', `计价配置从「按档位」升级为「按线路」，原档位单价已留档到 legacyTierUsd：${JSON.stringify(stored.usd)}`)
  }
  if (JSON.stringify(stored) !== JSON.stringify(merged)) store.set('pricing', merged)
  return merged
}

export function setPricing(p: Partial<PricingConfig>): PricingConfig {
  const cur = getPricing()
  const routes = { ...cur.routes }
  for (const [k, v] of Object.entries(p.routes ?? {})) {
    routes[k] = mergeRoute(v, cur.routes[k] ?? DEFAULT_PRICING.routes.aihubmix)
  }
  const next: PricingConfig = { ...cur, routes, usdCny: num(p.usdCny, cur.usdCny) }
  store.set('pricing', next)
  return next
}

export interface TokenCounts {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/**
 * 一条记录的估算花费（人民币）。
 * `route` 取不到时按 `custom` 处理（用 aihubmix 那套兜底——宁可估高，别让人以为很便宜）。
 */
export function costCny(
  route: string | null | undefined,
  model: string | null | undefined,
  t: TokenCounts,
  cfg: PricingConfig = getPricing()
): number {
  const r = cfg.routes[route ?? ''] ?? cfg.routes.aihubmix ?? DEFAULT_PRICING.routes.aihubmix
  const p = (model && r.models[model]) || r.default
  // 模型自己配了倍率就用它，没配才落到线路缺省（见 ModelPrice.cacheRead 的注释）
  const cr = p.cacheRead ?? r.cacheRead
  const cw = p.cacheWrite ?? r.cacheWrite
  const raw = (t.input * p.in + t.cacheRead * p.in * cr + t.cacheWrite * p.in * cw + t.output * p.out) / 1e6
  // 人民币原生的线路（DeepSeek 官方）不过汇率，见 RoutePrice.currency
  return r.currency === 'CNY' ? raw : raw * cfg.usdCny
}
