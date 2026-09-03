import { BrowserWindow } from 'electron'
import { store, keyVault, type SecretField } from '../store'
import { describeProvider } from './provider'
import { log } from '../lib/logger'

/**
 * 会话级「模型档位」层——对话链路真正的取数口（provider.ts 退化成迁移期的历史配置读口）。
 *
 * 设计要点：
 *  1. **界面只有两档语义，没有供应商名与模型名**。用户看到的是「标准（推荐）／增强」，
 *     悬停说的是能力与消耗差异；线路地址与模型串是运维配置，只在管理员区出现。
 *  2. **线路跟服务端走（2026-09-03 契约 v2）**：客户端**不持任何写死的 base URL**。
 *     每档的地址/模型串来自登录时下发的 `store.tierProvision`，
 *     `store.tierOverrides` 是运维应急覆盖（换模型串 / 临时切线路），优先级更高。
 *     两者都没有 = 这一档「线路未配置」，界面明示，**不做任何静默回落**。
 *  3. **模型必须显式下发**（同 provider.ts 的实测结论）：DeepSeek 官方端点对不认识的
 *     模型名是 HTTP 200 + 静默降级到 flash，所以主/轻量模型串两边都钉死，
 *     再靠 result.modelUsage 与期望值比对做第二道防线（见 agent/index.ts）。
 *  4. **key 与现有线路同一条路**：每档一个 `keyField`，走 secrets.ts 的 safeStorage
 *     存储与 M-29 写前判重，不另起炉灶。每档只认自己那把 key——
 *     此前「增强档回落到中转站那把」的设计已删（key 是中转站的、地址却钉在代码里的老域名，
 *     正是 Jerry 机器上抓到的形态）。
 */

export type TierId = 'standard' | 'enhanced'

/** 服务端下发的一档线路（client-config 契约 v2 的 `tiers.<id>` 去掉 key） */
export interface TierProvision {
  baseUrl: string
  model: string
  fastModel: string
}

export interface TierPreset {
  id: TierId
  /** 界面上出现的唯一名字 */
  label: string
  /** 悬停 tooltip：只讲能力与消耗差异，不提供应商与模型 */
  blurb: string
  /** 模型串的语义兜底（服务端没下发模型串时用；地址没有兜底） */
  model: string
  fastModel: string
  /** 这一档用哪把 key（safeStorage 槽位名） */
  keyField: SecretField
}

/**
 * 档位语义。**这里没有 base URL**——地址只能来自服务端下发或运维覆盖。
 *
 * 模型串留一份语义兜底：标准档 = deepseek-v4-pro/flash，增强档 = claude-opus-5
 * （增强档的轻量串同样钉死 opus：只有它做过真路由验证，写一个没验过的便宜名字，
 * 赌输的形态恰好是静默降级）。服务端下发的模型串优先于这份兜底。
 */
export const TIER_PRESETS: Record<TierId, TierPreset> = {
  standard: {
    id: 'standard',
    label: '标准（推荐）',
    blurb: '日常问答、查库与做课件都够用，响应快、消耗低',
    model: 'deepseek-v4-pro',
    fastModel: 'deepseek-v4-flash',
    keyField: 'encryptedLlmKey',
  },
  enhanced: {
    id: 'enhanced',
    label: '增强',
    blurb: '更强的推理与长文任务能力，消耗约为标准模式的数十倍',
    model: 'claude-opus-5',
    fastModel: 'claude-opus-5',
    keyField: 'encryptedAihubmixKey',
  },
}

export const TIER_IDS = Object.keys(TIER_PRESETS) as TierId[]

/** 「标准（推荐）」→「标准」：错误文案与日志里用短名 */
export const shortLabel = (label: string): string => label.replace(/（.*?）/g, '')

export interface TierOverride {
  baseUrl?: string
  model?: string
  fastModel?: string
  /** 只有迁移会写它：把这一档指到另一把已有的 key 上 */
  keyField?: SecretField
}

export interface ResolvedTier extends TierPreset {
  /** 空串 = 线路未配置（服务端没下发、运维也没填） */
  baseUrl: string
  /** 已配置 key？零 Keychain 触碰（只看这一档自己的槽位） */
  hasKey: boolean
  /** 地址与 key 都齐 = 可以发请求 */
  configured: boolean
  /** 没配齐时给一句人话：界面（置灰说明 / 预检错误）与探测都用它 */
  unavailableReason?: string
  /** 地址/模型来自服务端下发（`false` = 运维覆盖或未配置） */
  provisioned: boolean
  /** 出厂映射被运维改过（管理员区给个提示，别让人以为还是服务端下发的） */
  overridden: boolean
}

export const DEFAULT_TIER: TierId = 'standard'

/** 任何外来的档位值（会话记录、IPC 参数）都过这道，脏值一律回落标准档 */
export function normalizeTier(v: unknown): TierId {
  return v === 'enhanced' ? 'enhanced' : 'standard'
}

function overrides(): Partial<Record<TierId, TierOverride>> {
  return store.get('tierOverrides') ?? {}
}

function provisions(): Partial<Record<TierId, TierProvision>> {
  return store.get('tierProvision') ?? {}
}

/** 「线路未配置」的统一文案：客户看到的是"找管理员"，不是"去设置页填 key" */
export function unconfiguredReason(label: string): string {
  return `${shortLabel(label)}线路未配置，请联系管理员`
}

export function describeTier(id: TierId = DEFAULT_TIER): ResolvedTier {
  const preset = TIER_PRESETS[normalizeTier(id)]
  const ov = overrides()[preset.id] ?? {}
  const pv = provisions()[preset.id]
  const keyField = ov.keyField ?? preset.keyField
  const hasKey = keyVault.has(keyField)
  const baseUrl = (ov.baseUrl || pv?.baseUrl || '').replace(/\/$/, '')
  const configured = !!baseUrl && hasKey
  return {
    ...preset,
    baseUrl,
    model: ov.model || pv?.model || preset.model,
    fastModel: ov.fastModel || pv?.fastModel || preset.fastModel,
    keyField,
    hasKey,
    configured,
    unavailableReason: configured ? undefined : unconfiguredReason(preset.label),
    provisioned: !ov.baseUrl && !!pv?.baseUrl,
    overridden: !!(ov.baseUrl || ov.model || ov.fastModel || ov.keyField),
  }
}

export function listTiers(): ResolvedTier[] {
  return TIER_IDS.map((id) => describeTier(id))
}

export function setTierConfig(id: TierId, cfg: TierOverride): void {
  const tid = normalizeTier(id)
  const all = { ...overrides() }
  const next: TierOverride = { ...(all[tid] ?? {}) }
  const pv = provisions()[tid]
  for (const k of ['baseUrl', 'model', 'fastModel'] as const) {
    const raw = cfg[k]?.trim()
    if (raw === undefined) continue
    const v = k === 'baseUrl' ? raw.replace(/\/$/, '') : raw
    // 清空、或填的就是服务端下发的值 = 不算运维覆盖（否则管理员区会一直标「已被运维改过」）
    if (!v || v === pv?.[k]) delete next[k]
    else next[k] = v
  }
  if (cfg.keyField) next.keyField = cfg.keyField
  all[tid] = next
  store.set('tierOverrides', all)
}

/**
 * 登录 / 启动时把服务端下发的线路落盘（provisionKeys 调）。
 * 整份替换而不是合并：服务端不再下发某一档 = 那一档就是未配置，不能留旧值继续打。
 */
export function setTierProvision(p: Partial<Record<TierId, TierProvision>>): void {
  const clean: Partial<Record<TierId, TierProvision>> = {}
  for (const id of TIER_IDS) {
    const t = p[id]
    if (!t?.baseUrl) continue
    clean[id] = {
      baseUrl: String(t.baseUrl).trim().replace(/\/$/, ''),
      model: String(t.model ?? '').trim() || TIER_PRESETS[id].model,
      fastModel: String(t.fastModel ?? '').trim() || TIER_PRESETS[id].fastModel,
    }
  }
  const before = JSON.stringify(provisions())
  store.set('tierProvision', clean)
  if (JSON.stringify(clean) !== before) {
    log(
      'info',
      'tiers',
      `服务端下发线路：${TIER_IDS.map((id) => `${shortLabel(TIER_PRESETS[id].label)}=${clean[id]?.baseUrl ?? '（未下发）'} / ${clean[id]?.model ?? '-'}`).join('；')}`
    )
  }
}

/**
 * 无头冒烟（smoke-chat / smoke-agent）用环境变量注入 key，那种场景没有窗口。
 *
 * **有窗口时绝不吃继承来的 `ANTHROPIC_AUTH_TOKEN`**：开发机上常年挂着自己的 key，
 * 吃进来的后果是"这一档明明没配密钥"却照样把请求发出去了——走查里那条预检分支
 * 于是永远触发不到（这条是 2026-08-17 实测踩到的：增强档没 key，请求还是发了出去）。
 * 同一个道理 agentEnv 早就在做了（先清空继承来的 ANTHROPIC_*）。
 */
function headlessEnvKey(): string | null {
  try {
    if (BrowserWindow.getAllWindows().length > 0) return null
  } catch {
    /* app 还没 ready：当作无头 */
  }
  return process.env.ANTHROPIC_AUTH_TOKEN ?? null
}

/** 发消息时用：拿到地址、模型和明文 key（这一步才可能解密）。只认这一档自己的 key，没有回落 */
export function resolveTierForRequest(id: TierId): ResolvedTier & { apiKey: string | null } {
  const t = describeTier(id)
  return { ...t, apiKey: keyVault.read(t.keyField) ?? headlessEnvKey() }
}

/**
 * 迁移 v1（2026-08-17，只跑一次）曾把升级前生效的全局线路搬成标准档映射——
 * 那时线路写死在客户端，不搬就会变行为。契约 v2 之后线路跟服务端走，这一步不再需要：
 * 没跑过 v1 的机器直接标记为已迁移，什么都不写。
 */
export function migrateTiers(): void {
  if (!store.get('tierMigrated')) {
    store.set('tierMigrated', true)
    store.set('tierMigrated2', true)
    log('info', 'tiers', '档位线路跟服务端下发走，不再搬旧线路（迁移 v1 跳过）')
    return
  }
  migrateTiersV2()
}

/** v1 迁移会写成这个形态（`describeProvider()` 当时的四个字段）；线路自愈写的是下面那个 */
function looksLikeV1Migration(ov: TierOverride): boolean {
  const p = describeProvider()
  const byMigrate =
    ov.baseUrl === p.baseUrl.replace(/\/$/, '') && ov.model === p.model && ov.fastModel === p.fastModel && ov.keyField === p.keyField
  const relay = (store.get('relayBaseUrl') || '').replace(/\/$/, '')
  const bySelfHeal = ov.baseUrl === relay && ov.keyField === 'encryptedApiKey' && !ov.model && !ov.fastModel
  return byMigrate || bySelfHeal
}

/**
 * 迁移 v2（2026-09-03，只跑一次）：清掉 **v1 迁移写入的那份**标准档覆盖。
 *
 * 不清的话运维覆盖优先于服务端下发，老机器（用户本人 / 大头）重新登录也换不了线路。
 * 只清"长得像 v1 迁移写出来的"那份（四个字段与 `describeProvider()` 逐一相等，或线路自愈的两字段形态）；
 * 管理员手改过的覆盖形态不同，原样保留——大头那台靠它，不能一刀切。
 */
export function migrateTiersV2(): void {
  if (store.get('tierMigrated2')) return
  store.set('tierMigrated2', true)
  const all = { ...overrides() }
  const std = all.standard
  if (!std) return
  if (!looksLikeV1Migration(std)) {
    log('info', 'tiers', `迁移 v2：标准档覆盖不是 v1 迁移写入的形态（${std.baseUrl ?? '-'}），判为运维手改，保留`)
    return
  }
  delete all.standard
  store.set('tierOverrides', all)
  log('warn', 'tiers', `迁移 v2：已清除 v1 迁移写入的标准档覆盖（${std.baseUrl} / ${std.model ?? '-'}），标准档改跟服务端下发走`)
}
