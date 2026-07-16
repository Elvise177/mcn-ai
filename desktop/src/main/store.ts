import './env-hooks'
import Store from 'electron-store'
import { safeStorage } from 'electron'

interface StoreSchema {
  vaultPath?: string
  relayBaseUrl: string
  encryptedApiKey?: string
  /** 投递箱打标模型（DeepSeek 直连或中转站兼容端点） */
  llmBaseUrl: string
  llmModel: string
  /** webpage API 地址（私人层 ingest/search）；生产填 Vercel 域名 */
  apiBaseUrl: string
  /** 用户手动填过 key 则服务端下发不覆盖 */
  manualApiKey?: boolean
  manualLlmKey?: boolean
  encryptedLlmKey?: string
}

export const store = new Store<StoreSchema>({
  defaults: {
    relayBaseUrl: 'https://api.inferera.com',
    llmBaseUrl: 'https://api.deepseek.com',
    llmModel: 'deepseek-v4-flash',
    apiBaseUrl: 'https://www.makeupai.top',
  },
})

function setSecret(field: 'encryptedApiKey' | 'encryptedLlmKey', plainKey: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用（Keychain 未解锁？）')
  }
  store.set(field, safeStorage.encryptString(plainKey).toString('base64'))
}

function getSecret(field: 'encryptedApiKey' | 'encryptedLlmKey'): string | null {
  const enc = store.get(field)
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

export const setApiKey = (k: string): void => setSecret('encryptedApiKey', k)
export const getApiKey = (): string | null => getSecret('encryptedApiKey')
export const setLlmKey = (k: string): void => setSecret('encryptedLlmKey', k)
export const getLlmKey = (): string | null => getSecret('encryptedLlmKey')
