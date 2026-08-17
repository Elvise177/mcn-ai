import { describeTier, resolveTierForRequest, normalizeTier, type TierId } from './tiers'
import { log } from '../lib/logger'

/**
 * 档位线路的可用性探测。
 *
 * 为什么要有：增强档走的是外部中转线路，它挂掉的时候用户看到的是"发出去没反应"，
 * 而真正该发生的是**选择器里那一档直接置灰**，根本不让人踩进去。
 *
 * 三条约束：
 *  1. **不得每次发送都探**——结果缓存 5 分钟，选择器挂载/展开时问的都是缓存；
 *     真正的失败仍由发送链路自己的错误路径兜住（那条路径带「切换到标准模式重试」引导）。
 *  2. **探测必须便宜**：`max_tokens: 1` 的一次 messages 请求，几乎不产生输出 token，
 *     但能同时验到「地址通不通 / key 认不认 / 模型名收不收」三件事——
 *     只 ping 根路径的话，key 过期这种最常见的失效形态压根测不出来。
 *  3. **没 key 不发请求**：直接判不可用，省一次往返（绝大多数机器的增强档就是这个状态）。
 */

export interface TierHealth {
  tier: TierId
  ok: boolean
  /** 不可用时给一句人话，界面拿它做 tooltip */
  reason?: string
  checkedAt: number
  /** 这次是不是直接吃的缓存（走查用它断言"没有每次都探"） */
  cached: boolean
}

const CACHE_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 8000

const cache = new Map<TierId, TierHealth>()
/** 同一档的并发探测合并成一次（选择器挂载与展开可能同一帧发起两次） */
const inflight = new Map<TierId, Promise<TierHealth>>()

/**
 * 走查专用开关（生产不读，判据同 HANDOFF §4-22）：造"线路探测失败"需要真的把
 * aihubmix 打挂或断网，走查里做不到。`down` = 强制不可用，`up` = 强制可用（跳过真实请求）。
 */
function e2eOverride(): 'up' | 'down' | null {
  const v = process.env.MCNAI_E2E_TIER_HEALTH
  return v === 'up' || v === 'down' ? v : null
}

async function probe(tier: TierId): Promise<TierHealth> {
  const now = Date.now()
  const forced = e2eOverride()
  if (forced) {
    return {
      tier,
      ok: forced === 'up',
      reason: forced === 'down' ? '线路暂时连不上（e2e 模拟）' : undefined,
      checkedAt: now,
      cached: false,
    }
  }

  const t = describeTier(tier)
  if (!t.baseUrl) return { tier, ok: false, reason: '未配置线路地址', checkedAt: now, cached: false }
  if (!t.hasKey) return { tier, ok: false, reason: '这条线路还没配置密钥', checkedAt: now, cached: false }

  const { apiKey, baseUrl, model } = resolveTierForRequest(tier)
  if (!apiKey) return { tier, ok: false, reason: '这条线路还没配置密钥', checkedAt: now, cached: false }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        // 两种鉴权头都带上：Anthropic 原生认 x-api-key，多数中转站认 Bearer
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    })
    if (res.ok) return { tier, ok: true, checkedAt: Date.now(), cached: false }
    const reason =
      res.status === 401 || res.status === 403
        ? '密钥无效或已过期'
        : res.status === 429
          ? '线路繁忙，请稍后再试'
          : `线路返回 ${res.status}`
    log('warn', 'ai-health', `${tier} 探测失败：${reason}`)
    return { tier, ok: false, reason, checkedAt: Date.now(), cached: false }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const reason = ctl.signal.aborted ? '线路响应超时' : '连不上这条线路'
    log('warn', 'ai-health', `${tier} 探测失败：${reason}（${msg}）`)
    return { tier, ok: false, reason, checkedAt: Date.now(), cached: false }
  } finally {
    clearTimeout(timer)
  }
}

/** 取某一档的可用性。默认吃 5 分钟缓存；`force` 只给管理员区的「重新检测」用 */
export async function tierHealth(id: TierId, force = false): Promise<TierHealth> {
  const tier = normalizeTier(id)
  // 标准档是兜底线路，不做主动探测：它挂了也没有"另一档"可退，
  // 探测只会在每次开应用时多一次请求，换不来任何一个能点的按钮
  if (tier === 'standard') {
    const t = describeTier(tier)
    return {
      tier,
      ok: t.hasKey && !!t.baseUrl,
      reason: t.hasKey ? undefined : '这条线路还没配置密钥',
      checkedAt: Date.now(),
      cached: false,
    }
  }

  const hit = cache.get(tier)
  if (!force && hit && Date.now() - hit.checkedAt < CACHE_MS) return { ...hit, cached: true }

  const running = inflight.get(tier)
  if (running) return running

  const p = probe(tier)
    .then((r) => {
      cache.set(tier, r)
      return r
    })
    .finally(() => inflight.delete(tier))
  inflight.set(tier, p)
  return p
}

/** 配置一变（改了地址/模型/key）缓存立刻作废，否则用户改完还要等 5 分钟才看到效果 */
export function invalidateTierHealth(id?: TierId): void {
  if (id) cache.delete(normalizeTier(id))
  else cache.clear()
}
