import './env-hooks'
import Store from 'electron-store'
import { SecretVault, type SecretBackend, type WriteOutcome } from './secrets'
import type { ProviderId } from './ai/provider'
import type { TierId, TierOverride } from './ai/tiers'
import type { PricingConfig } from './usage/pricing'

interface StoreSchema {
  vaultPath?: string
  /** inferera 中转站地址（服务端下发会覆盖），= provider `inferera` 的 base URL */
  relayBaseUrl: string
  encryptedApiKey?: string
  /** 投递箱打标模型（DeepSeek 直连的 OpenAI 兼容端点，与对话 provider 无关） */
  llmBaseUrl: string
  llmModel: string
  /** webpage API 地址（私人层 ingest/search）；生产填 Vercel 域名 */
  apiBaseUrl: string
  /** 用户手动填过 key 则服务端下发不覆盖 */
  manualApiKey?: boolean
  manualLlmKey?: boolean
  encryptedLlmKey?: string
  /** 自定义 provider（Kimi/智谱等）的 key */
  encryptedCustomKey?: string
  /** 增强档（aihubmix 线路）的 key，与其他线路同一套 safeStorage + M-29 判重 */
  encryptedAihubmixKey?: string
  /** 对话链路用哪个 provider（模型层解耦，见 ai/provider.ts）。
      档位层上线后它只剩迁移期的历史配置读口，对话链路已改走 ai/tiers.ts */
  aiProvider: ProviderId
  /** 每个 provider 各自的 base URL / 模型覆盖值——覆盖值不能跨 provider 串（各家模型名不通用） */
  aiOverrides: Partial<Record<ProviderId, { baseUrl?: string; model?: string; fastModel?: string }>>
  /** 档位 → 线路映射的运维覆盖（管理员区可改，界面两档语义不变，见 ai/tiers.ts） */
  tierOverrides: Partial<Record<TierId, TierOverride>>
  /** 老用户迁移只跑一次：把升级前生效的全局线路搬成标准档映射 */
  tierMigrated?: boolean
  /** 用量计价（各档美元单价 + 汇率）：运维配置，管理员区可改。
      `usage/pricing.ts` 的 getPricing() 会把默认值补齐落盘，
      scripts/usage-report.mjs 直接读这一份，避免单价两处维护 */
  pricing?: PricingConfig
  /** 自动化中心 · 钉钉群机器人 */
  dingtalkWebhook?: string
  dingtalkSecret?: string
  dingtalkNotifyInbox: boolean
  dingtalkNotifyArtifact: boolean
  /** 经营数据自动入库（钉钉→vault），暂默认关闭 */
  bizSyncEnabled: boolean
  /** AI 产物生成后自动送入投递箱转为知识 */
  artifactAutoIngest: boolean
  /**
   * 敏感资料的处置（A-8 三态开关）。界面收成三档，**存储是两个独立布尔**——
   * 收成一个枚举的话，以后想加「允许打标但不上云」要改数据结构。
   *   仅本地规则打标（默认） = false / false
   *   允许 AI 打标           = true  / false
   *   与普通文件相同          = true  / true
   */
  /**
   * 用量页是否显示金额（2026-08-18 起**默认关闭**）。
   *
   * 现在显示的是**成本价**——把它摆给客户看，等于把我们的进货价摊开；
   * 而商业化定价还没定，页面上先只留「次数 / 档位对比 / token 数」这些量。
   * 计价能力本身完整保留：jsonl 照常记、`usage-report.mjs` 照常出成本表（那是给我们自己看的），
   * 管理员区可以打开这个开关看金额。将来按谈定的客户价出账时再考虑对客户开放。
   */
  showCost: boolean
  sensitiveAllowAi: boolean
  sensitiveAllowCloud: boolean
  /** 密钥指纹用的随机盐（不是秘密，见 secrets.ts） */
  secretSalt?: string
  encryptedApiKeyFp?: string
  encryptedLlmKeyFp?: string
  encryptedCustomKeyFp?: string
  encryptedAihubmixKeyFp?: string
}

export const store = new Store<StoreSchema>({
  defaults: {
    relayBaseUrl: 'https://api.inferera.com',
    llmBaseUrl: 'https://api.deepseek.com',
    llmModel: 'deepseek-v4-flash',
    apiBaseUrl: 'https://www.makeupai.top',
    aiProvider: 'inferera',
    aiOverrides: {},
    tierOverrides: {},
    dingtalkNotifyInbox: true,
    dingtalkNotifyArtifact: true,
    bizSyncEnabled: false,
    artifactAutoIngest: false,
    showCost: false,
    sensitiveAllowAi: false,
    sensitiveAllowCloud: false,
  },
})

const backend: SecretBackend = {
  read: (k) => store.get(k as keyof StoreSchema) as string | undefined,
  write: (k, v) => store.set(k as keyof StoreSchema, v),
  remove: (k) => store.delete(k as keyof StoreSchema),
}

/** AI key 的保险箱：读写规则与「为什么不能同步写」都在 secrets.ts */
export const keyVault = new SecretVault(backend, 'API Key')

export type SecretField =
  | 'encryptedApiKey'
  | 'encryptedLlmKey'
  | 'encryptedCustomKey'
  | 'encryptedAihubmixKey'

// ---- 兼容旧调用点：中转站 key / DeepSeek 打标 key ----
export const getApiKey = (): string | null => keyVault.read('encryptedApiKey')
export const getLlmKey = (): string | null => keyVault.read('encryptedLlmKey')
/** 零 Keychain 触碰的"配没配过"，`settings:get` 这类高频只读路径必须用它 */
export const hasApiKey = (): boolean => keyVault.has('encryptedApiKey')
export const hasLlmKey = (): boolean => keyVault.has('encryptedLlmKey')

/** 界面路径统一走这个：值没变一次 Keychain 都不碰，变了也不阻塞（M-29） */
export const setSecretLater = (field: SecretField, plain: string): WriteOutcome =>
  keyVault.writeLater(field, plain)
export const isSecretPending = (field: SecretField): boolean => keyVault.isPending(field)

export const setApiKey = (k: string): WriteOutcome => setSecretLater('encryptedApiKey', k)
export const setLlmKey = (k: string): WriteOutcome => setSecretLater('encryptedLlmKey', k)
