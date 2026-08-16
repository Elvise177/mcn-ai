import { store, keyVault, type SecretField } from '../store'

/**
 * 模型 provider 层（对话链路的唯一取数口）。
 *
 * 三个 provider 并存，设置页可切：
 *  - `inferera`  中转站（原有默认）。它认 Anthropic 的模型名（claude-*），也认 deepseek-v4-*
 *  - `deepseek`  DeepSeek 官方的 **Anthropic 兼容端点** `https://api.deepseek.com/anthropic`
 *  - `custom`    自填 base URL，给将来的 Kimi / 智谱留口
 *
 * **模型必须显式指定**（2026-08-16 实测）：DeepSeek 官方端点对任何它不认识的模型名——包括
 * Agent SDK 默认发出去的 `claude-sonnet-*`——都会**静默降级成 deepseek-v4-flash**（HTTP 200，
 * 响应体里 model 字段才看得出来），只有 `deepseek-v4-pro` / `deepseek-v4-flash` 会被原样接受，
 * 其余名字返回 400。inferera 那边同样的 claude-* 名字则是真的路由到 Claude。
 * 所以两边都要把主模型钉死，不能靠自动映射。
 */

export type ProviderId = 'inferera' | 'deepseek' | 'custom'

export interface ProviderPreset {
  id: ProviderId
  label: string
  /** 空字符串 = 必须用户自己填（custom） */
  baseUrl: string
  /** 主模型：对话与工具调用走它 */
  model: string
  /** 轻量子任务（SDK 的 small/fast 档：起标题、压缩上下文等） */
  fastModel: string
  /** 这个 provider 用哪把 key */
  keyField: SecretField
  hint: string
}

/** 主模型统一 deepseek-v4-pro（用户拍板），轻量子任务用 flash */
export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  inferera: {
    id: 'inferera',
    label: 'inferera 中转站',
    baseUrl: 'https://api.inferera.com',
    model: 'deepseek-v4-pro',
    fastModel: 'deepseek-v4-flash',
    keyField: 'encryptedApiKey',
    hint: '默认线路，随账号自动下发 key；也可切到 claude-* 模型名',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-pro',
    fastModel: 'deepseek-v4-flash',
    keyField: 'encryptedLlmKey',
    hint: '官方 Anthropic 兼容端点，复用 DeepSeek key；只认 deepseek-v4-pro / flash',
  },
  custom: {
    id: 'custom',
    label: '自定义 base URL',
    baseUrl: '',
    model: 'deepseek-v4-pro',
    fastModel: 'deepseek-v4-flash',
    keyField: 'encryptedCustomKey',
    hint: '为 Kimi / 智谱等其他 Anthropic 兼容端点预留，需自己填地址与模型名',
  },
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

export interface ResolvedProvider extends ProviderPreset {
  /** 已配置 key？零 Keychain 触碰 */
  hasKey: boolean
}

export function currentProviderId(): ProviderId {
  const id = store.get('aiProvider')
  return PROVIDERS[id] ? id : 'inferera'
}

/** 取某个 provider 的最终配置（预设 + 用户覆盖），不解密 key */
export function describeProvider(id: ProviderId = currentProviderId()): ResolvedProvider {
  const preset = PROVIDERS[id]
  const ov = store.get('aiOverrides')[id] ?? {}
  // inferera 的地址历史上一直存在 relayBaseUrl（服务端下发也写它），继续认它做真相源
  const presetBase = id === 'inferera' ? store.get('relayBaseUrl') || preset.baseUrl : preset.baseUrl
  return {
    ...preset,
    baseUrl: (ov.baseUrl || presetBase).replace(/\/$/, ''),
    model: ov.model || preset.model,
    fastModel: ov.fastModel || preset.fastModel,
    hasKey: keyVault.has(preset.keyField),
  }
}

export function listProviders(): ResolvedProvider[] {
  return PROVIDER_IDS.map((id) => describeProvider(id))
}

export function setProvider(id: ProviderId): void {
  if (!PROVIDERS[id]) throw new Error(`未知 provider：${id}`)
  store.set('aiProvider', id)
}

export function setProviderOverrides(
  id: ProviderId,
  ov: { baseUrl?: string; model?: string; fastModel?: string }
): void {
  const all = { ...store.get('aiOverrides') }
  const next = { ...(all[id] ?? {}) }
  for (const k of ['baseUrl', 'model', 'fastModel'] as const) {
    const v = ov[k]?.trim()
    if (v === undefined) continue
    if (v) next[k] = k === 'baseUrl' ? v.replace(/\/$/, '') : v
    else delete next[k] // 清空 = 回到预设值
  }
  all[id] = next
  store.set('aiOverrides', all)
}

/** 发消息时用：拿到地址、模型和明文 key（这一步才可能解密） */
export function resolveForRequest(): ResolvedProvider & { apiKey: string | null } {
  const p = describeProvider()
  return { ...p, apiKey: keyVault.read(p.keyField) ?? process.env.ANTHROPIC_AUTH_TOKEN ?? null }
}

/**
 * Agent SDK 子进程的环境变量。
 * **先把继承来的 ANTHROPIC_* 全部清掉**：开发机上常年挂着自己的 ANTHROPIC_BASE_URL /
 * ANTHROPIC_DEFAULT_SONNET_MODEL 之类，`{...process.env}` 会把它们一起带进子进程，
 * 于是"我明明指定了模型"却被别的变量改掉——冒烟结果也会跟着不可信。
 */
export function agentEnv(p: { baseUrl: string; apiKey: string; model: string; fastModel: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_')) delete env[k]
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: p.apiKey,
    ANTHROPIC_MODEL: p.model,
    ANTHROPIC_SMALL_FAST_MODEL: p.fastModel,
  }
}
