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
 *  2. **档位语义写死、映射留运维口**：`TIER_PRESETS` 是出厂映射，
 *     `store.tierOverrides` 是运维应急覆盖（换模型串 / 临时切备用线路如 inferera）。
 *     覆盖只改"这一档走哪条线"，不改"这一档是什么档"。
 *  3. **模型必须显式下发**（同 provider.ts 的实测结论）：DeepSeek 官方端点对不认识的
 *     模型名是 HTTP 200 + 静默降级到 flash，所以主/轻量模型串两边都钉死，
 *     再靠 result.modelUsage 与期望值比对做第二道防线（见 agent/index.ts）。
 *  4. **key 与现有线路同一条路**：每档一个 `keyField`，走 secrets.ts 的 safeStorage
 *     存储与 M-29 写前判重，不另起炉灶。
 */

export type TierId = 'standard' | 'enhanced'

export interface TierPreset {
  id: TierId
  /** 界面上出现的唯一名字 */
  label: string
  /** 悬停 tooltip：只讲能力与消耗差异，不提供应商与模型 */
  blurb: string
  baseUrl: string
  /** 主模型：对话与工具调用走它 */
  model: string
  /** 轻量子任务（SDK 的 small/fast 档：起标题、压缩上下文等） */
  fastModel: string
  /** 这一档用哪把 key（safeStorage 槽位名） */
  keyField: SecretField
}

/**
 * 出厂映射。
 *
 * 增强档的轻量串同样钉死 `claude-opus-5`：aihubmix 上只有它做过真路由验证
 * （响应 model 字段原样返回）。写一个没验过的便宜模型名进来，赌的是"它一定存在"——
 * 赌输的形态恰好是静默降级，正是这一层要防的东西。真要省，走管理员区把轻量串
 * 换成验过的名字，两行字的事。
 */
export const TIER_PRESETS: Record<TierId, TierPreset> = {
  standard: {
    id: 'standard',
    label: '标准（推荐）',
    blurb: '日常问答、查库与做课件都够用，响应快、消耗低',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-pro',
    fastModel: 'deepseek-v4-flash',
    keyField: 'encryptedLlmKey',
  },
  enhanced: {
    id: 'enhanced',
    label: '增强',
    blurb: '更强的推理与长文任务能力，消耗约为标准模式的数十倍',
    baseUrl: 'https://aihubmix.com',
    model: 'claude-opus-5',
    fastModel: 'claude-opus-5',
    keyField: 'encryptedAihubmixKey',
  },
}

export const TIER_IDS = Object.keys(TIER_PRESETS) as TierId[]

export interface TierOverride {
  baseUrl?: string
  model?: string
  fastModel?: string
  /** 只有迁移与"线路自愈"会写它：把这一档指到另一把已有的 key 上 */
  keyField?: SecretField
}

/**
 * 档位自己那把 key 空着时的**回落槽位**。
 *
 * 增强档 → 中转站那把（`encryptedApiKey`）。依据是 2026-08-17 的实测：
 * `api.inferera.com` 是 **aihubmix 的备用域名**（同一套鉴权，`claude-opus-5` 原样返回），
 * 而服务端下发的 `CLIENT_RELAY_API_KEY` 与网页版用的 `AIHUBMIX_API_KEY` **是同一把**。
 * 也就是说：**任何登录过的机器硬盘上早就躺着一把能开增强档的 key**，
 * 再下发第二把纯属多余，还多一处要维护的密钥。
 *
 * **独立槽位优先**：管理员区给增强档单独填了 key（比如将来换成限额子 key），就用填的那把；
 * 空着才回落。回落会打一条 log，不是静默兜底——"钱从哪把 key 上扣的"必须查得到。
 */
const FALLBACK_KEY_FIELD: Partial<Record<TierId, SecretField>> = {
  enhanced: 'encryptedApiKey',
}

export interface ResolvedTier extends TierPreset {
  /** 已配置 key？零 Keychain 触碰（含回落槽位） */
  hasKey: boolean
  /** 用的是回落来的共享 key，不是这一档自己的（管理员区要标出来） */
  usingSharedKey: boolean
  /** 出厂映射被运维改过（管理员区给个提示，别让人以为还是原厂设置） */
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

export function describeTier(id: TierId = DEFAULT_TIER): ResolvedTier {
  const preset = TIER_PRESETS[normalizeTier(id)]
  const ov = overrides()[preset.id] ?? {}
  // `keyField` 始终是**这一档自己的槽位**：管理员区那颗「保存」写的是它，
  // 不能因为正在回落就把 key 写到别人的槽位上去（那会把中转站那把覆盖掉）
  const keyField = ov.keyField ?? preset.keyField
  const ownHasKey = keyVault.has(keyField)
  const fb = FALLBACK_KEY_FIELD[preset.id]
  const usingSharedKey = !ownHasKey && !!fb && fb !== keyField && keyVault.has(fb)
  return {
    ...preset,
    baseUrl: (ov.baseUrl || preset.baseUrl).replace(/\/$/, ''),
    model: ov.model || preset.model,
    fastModel: ov.fastModel || preset.fastModel,
    keyField,
    hasKey: ownHasKey || usingSharedKey,
    usingSharedKey,
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
  for (const k of ['baseUrl', 'model', 'fastModel'] as const) {
    const v = cfg[k]?.trim()
    if (v === undefined) continue
    if (v) next[k] = k === 'baseUrl' ? v.replace(/\/$/, '') : v
    else delete next[k] // 清空 = 回到出厂映射
  }
  if (cfg.keyField) next.keyField = cfg.keyField
  all[tid] = next
  store.set('tierOverrides', all)
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

/** 回落日志一个进程只打一次：它挂在发消息与线路探测这两条高频路径上 */
const loggedFallback = new Set<string>()

/** 发消息时用：拿到地址、模型和明文 key（这一步才可能解密） */
export function resolveTierForRequest(id: TierId): ResolvedTier & { apiKey: string | null } {
  const t = describeTier(id)
  const own = keyVault.read(t.keyField)
  if (own) return { ...t, apiKey: own }

  // 自己的槽位空着 → 回落（见 FALLBACK_KEY_FIELD 的注释）
  const fb = FALLBACK_KEY_FIELD[t.id]
  if (fb && fb !== t.keyField) {
    const shared = keyVault.read(fb)
    if (shared) {
      if (!loggedFallback.has(t.id)) {
        loggedFallback.add(t.id)
        log('info', 'tiers', `「${t.label}」未配独立密钥，回落到共享密钥 ${fb}（${t.baseUrl}）`)
      }
      return { ...t, apiKey: shared }
    }
  }
  return { ...t, apiKey: headlessEnvKey() }
}

/**
 * 老用户迁移（只跑一次）。
 *
 * 现有机器（大头那台是主要对象）已经在设置页配好了全局线路，升级之后**行为不能变**：
 * 把当时生效的 base URL / 模型串 / key 槽位原样搬成"标准档"的映射。
 * 全新安装（store 里什么都没有）不写覆盖，标准档就是出厂映射。
 */
export function migrateTiers(): void {
  if (store.get('tierMigrated')) return
  store.set('tierMigrated', true)

  // "这台机器以前用过" 的判据：配过库、或任意一把 key 落过盘
  const existing =
    !!store.get('vaultPath') ||
    keyVault.has('encryptedApiKey') ||
    keyVault.has('encryptedLlmKey') ||
    keyVault.has('encryptedCustomKey')
  if (!existing) {
    log('info', 'tiers', '全新安装：档位映射用出厂值')
    return
  }

  const p = describeProvider()
  setTierConfig('standard', {
    baseUrl: p.baseUrl,
    model: p.model,
    fastModel: p.fastModel,
    keyField: p.keyField,
  })
  log(
    'info',
    'tiers',
    `老用户迁移：标准档沿用原线路 ${p.label}（${p.baseUrl} / ${p.model}）`
  )
}

/**
 * 线路自愈：标准档一把 key 都没有、而中转站那把还在，就把标准档指过去。
 *
 * 触发场景是"全新安装但服务端只下发了中转站 key"——不救的话首次对话直接撞
 * 「请先配置密钥」，而机器上其实是有可用 key 的。标准档的语义是**模型**
 * （deepseek-v4-pro），换线路不改语义，所以这一步是安全的；但它会打一条日志，
 * 不做静默兜底。
 */
export function ensureStandardUsable(): void {
  const t = describeTier('standard')
  if (t.hasKey) return
  if (!keyVault.has('encryptedApiKey')) return
  setTierConfig('standard', {
    baseUrl: store.get('relayBaseUrl'),
    keyField: 'encryptedApiKey',
  })
  log('warn', 'tiers', `标准档没有可用密钥，已自动指向中转站线路（${store.get('relayBaseUrl')}）`)
}
