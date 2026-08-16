import './env-hooks'
import Store from 'electron-store'
import { SecretVault, type SecretBackend, type WriteOutcome } from './secrets'
import type { ProviderId } from './ai/provider'

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
  /** 对话链路用哪个 provider（模型层解耦，见 ai/provider.ts） */
  aiProvider: ProviderId
  /** 每个 provider 各自的 base URL / 模型覆盖值——覆盖值不能跨 provider 串（各家模型名不通用） */
  aiOverrides: Partial<Record<ProviderId, { baseUrl?: string; model?: string; fastModel?: string }>>
  /** 自动化中心 · 钉钉群机器人 */
  dingtalkWebhook?: string
  dingtalkSecret?: string
  dingtalkNotifyInbox: boolean
  dingtalkNotifyArtifact: boolean
  /** 经营数据自动入库（钉钉→vault），暂默认关闭 */
  bizSyncEnabled: boolean
  /** AI 产物生成后自动送入投递箱转为知识 */
  artifactAutoIngest: boolean
  /** 密钥指纹用的随机盐（不是秘密，见 secrets.ts） */
  secretSalt?: string
  encryptedApiKeyFp?: string
  encryptedLlmKeyFp?: string
  encryptedCustomKeyFp?: string
}

export const store = new Store<StoreSchema>({
  defaults: {
    relayBaseUrl: 'https://api.inferera.com',
    llmBaseUrl: 'https://api.deepseek.com',
    llmModel: 'deepseek-v4-flash',
    apiBaseUrl: 'https://www.makeupai.top',
    aiProvider: 'inferera',
    aiOverrides: {},
    dingtalkNotifyInbox: true,
    dingtalkNotifyArtifact: true,
    bizSyncEnabled: false,
    artifactAutoIngest: false,
  },
})

const backend: SecretBackend = {
  read: (k) => store.get(k as keyof StoreSchema) as string | undefined,
  write: (k, v) => store.set(k as keyof StoreSchema, v),
  remove: (k) => store.delete(k as keyof StoreSchema),
}

/** AI key 的保险箱：读写规则与「为什么不能同步写」都在 secrets.ts */
export const keyVault = new SecretVault(backend, 'API Key')

export type SecretField = 'encryptedApiKey' | 'encryptedLlmKey' | 'encryptedCustomKey'

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
