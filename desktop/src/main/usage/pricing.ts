import { store } from '../store'
import type { TierId } from '../ai/tiers'

/**
 * 用量计价（估算口径，不是账单）。
 *
 * 两条约定：
 *  1. **单价与汇率是运维配置**：只在设置页的管理员区可见可改，普通用户看到的永远是
 *     人民币结果。线路加价、官方调价、汇率变动都在这里改，不用发版。
 *  2. **只有一份真相**：默认值写在这里，`getPricing()` 会把它**落进 store**，
 *     于是 `scripts/usage-report.mjs` 直接读 `userData/config.json` 的 `pricing` 就行，
 *     不必在脚本里再抄一份单价（抄了必然两边漂移）。
 *
 * 按**档位**计价而不是按模型名：档位才是用户看得见的东西，模型串是可以被运维换掉的。
 * 入库打标不经档位（tier=null），没有 token 也就没有花费，统一算 0。
 */

export interface TierPrice {
  /** 每百万输入 token 的美元单价 */
  in: number
  /** 每百万输出 token 的美元单价 */
  out: number
}

export interface PricingConfig {
  usd: Record<TierId, TierPrice>
  /** 美元 → 人民币汇率 */
  usdCny: number
}

/** 出厂单价：与线路的计费页核对之后再改（改的是 store，不用发版） */
export const DEFAULT_PRICING: PricingConfig = {
  usd: {
    standard: { in: 0.28, out: 1.1 },
    enhanced: { in: 15, out: 75 },
  },
  usdCny: 7.2,
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback

/** 读配置并**补齐落盘**：脚本侧靠 store 里这份做单一真相源 */
export function getPricing(): PricingConfig {
  const raw = store.get('pricing') as Partial<PricingConfig> | undefined
  const merged: PricingConfig = {
    usd: {
      standard: {
        in: num(raw?.usd?.standard?.in, DEFAULT_PRICING.usd.standard.in),
        out: num(raw?.usd?.standard?.out, DEFAULT_PRICING.usd.standard.out),
      },
      enhanced: {
        in: num(raw?.usd?.enhanced?.in, DEFAULT_PRICING.usd.enhanced.in),
        out: num(raw?.usd?.enhanced?.out, DEFAULT_PRICING.usd.enhanced.out),
      },
    },
    usdCny: num(raw?.usdCny, DEFAULT_PRICING.usdCny),
  }
  if (JSON.stringify(raw) !== JSON.stringify(merged)) store.set('pricing', merged)
  return merged
}

export function setPricing(p: {
  usd?: Partial<Record<TierId, Partial<TierPrice>>>
  usdCny?: number
}): PricingConfig {
  const cur = getPricing()
  const next: PricingConfig = {
    usd: {
      standard: {
        in: num(p.usd?.standard?.in, cur.usd.standard.in),
        out: num(p.usd?.standard?.out, cur.usd.standard.out),
      },
      enhanced: {
        in: num(p.usd?.enhanced?.in, cur.usd.enhanced.in),
        out: num(p.usd?.enhanced?.out, cur.usd.enhanced.out),
      },
    },
    usdCny: num(p.usdCny, cur.usdCny),
  }
  store.set('pricing', next)
  return next
}

/** 一条记录的估算花费（人民币）。不经档位的（入库打标）算 0 */
export function costCny(
  tier: TierId | null,
  input: number,
  output: number,
  cfg: PricingConfig = getPricing()
): number {
  if (!tier) return 0
  const p = cfg.usd[tier] ?? DEFAULT_PRICING.usd.standard
  return ((input / 1e6) * p.in + (output / 1e6) * p.out) * cfg.usdCny
}
