import '../env-hooks'
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { BrowserWindow, safeStorage } from 'electron'
import Store from 'electron-store'

/** Supabase 公开配置（anon key 设计上可公开，RLS 才是安全边界）；从 webpage 同项目取 */
const SUPABASE_URL = 'https://yqozqfrmdddmfrpavrsn.supabase.co'
const SUPABASE_ANON_KEY_STORE = new Store<{ anonKey?: string; encryptedSession?: string }>({ name: 'auth' })

const DEFAULT_ANON_KEY = 'sb_publishable_7qxnJzHZD5brxiAQplAvcA_xx2_7i7X'

function getAnonKey(): string | null {
  return process.env.MCNAI_SUPABASE_ANON_KEY || SUPABASE_ANON_KEY_STORE.get('anonKey') || DEFAULT_ANON_KEY
}

export function setAnonKey(key: string): void {
  SUPABASE_ANON_KEY_STORE.set('anonKey', key.trim())
}

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient | null {
  if (client) return client
  const anon = getAnonKey()
  if (!anon) return null
  client = createClient(SUPABASE_URL, anon, {
    // Electron 主进程是 Node 20（无原生 WebSocket），realtime 组件需注入 ws 实现
    realtime: { transport: WebSocket as never },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: {
        // safeStorage 加密落盘，替代浏览器 localStorage
        getItem: (k: string) => {
          const enc = SUPABASE_ANON_KEY_STORE.get('encryptedSession')
          if (!enc || k !== 'mcnai-session') return null
          try {
            return safeStorage.decryptString(Buffer.from(enc, 'base64'))
          } catch {
            return null
          }
        },
        setItem: (k: string, v: string) => {
          if (k !== 'mcnai-session') return
          SUPABASE_ANON_KEY_STORE.set('encryptedSession', safeStorage.encryptString(v).toString('base64'))
        },
        removeItem: (k: string) => {
          if (k === 'mcnai-session') SUPABASE_ANON_KEY_STORE.delete('encryptedSession')
        },
      },
      storageKey: 'mcnai-session',
    },
  })
  return client
}

export async function login(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabase()
  if (!sb) return { ok: false, error: '未配置 Supabase anon key（设置页填写）' }
  const { error } = await sb.auth.signInWithPassword({ email, password })
  if (error) return { ok: false, error: error.message }
  void provisionKeys() // 登录即用：服务端下发 AI key（不阻塞登录返回）
  return { ok: true }
}

export type ProvisionResult = { ok: boolean; error?: string }

/** 最近一次下发失败的原因；渲染层挂载晚于启动那次 provision，用它补一次查询 */
let lastProvisionError: string | null = null
export const getProvisionError = (): string | null => lastProvisionError

/** 失败要让用户看得见：设置页里有手填 key 的入口，不通知就等于死路一条 */
function notifyProvisionFailed(msg: string): void {
  lastProvisionError = msg
  for (const w of BrowserWindow.getAllWindows()) {
    const send = (): void => w.webContents.send('auth:provision-failed', msg)
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
    else send()
  }
}

/** 从服务端拉取 AI 配置；用户手动填过的 key 不覆盖 */
export async function provisionKeys(): Promise<ProvisionResult> {
  try {
    const { store, setApiKey, setLlmKey, getApiKey, getLlmKey } = await import('../store')
    const token = await getAccessToken()
    if (!token) return { ok: false, error: '未登录，无法获取服务端配置' }
    const res = await fetch(`${store.get('apiBaseUrl')}/api/v1/client-config`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const msg = `服务端返回 ${res.status}`
      notifyProvisionFailed(msg)
      return { ok: false, error: msg }
    }
    const cfg = (await res.json()) as {
      relayBaseUrl?: string
      relayApiKey?: string | null
      llmBaseUrl?: string
      llmModel?: string
      llmApiKey?: string | null
    }
    if (cfg.relayApiKey && (!store.get('manualApiKey') || !getApiKey())) {
      setApiKey(cfg.relayApiKey)
      if (cfg.relayBaseUrl) store.set('relayBaseUrl', cfg.relayBaseUrl)
    }
    if (cfg.llmApiKey && (!store.get('manualLlmKey') || !getLlmKey())) {
      setLlmKey(cfg.llmApiKey)
      if (cfg.llmBaseUrl) store.set('llmBaseUrl', cfg.llmBaseUrl)
      if (cfg.llmModel) store.set('llmModel', cfg.llmModel)
    }
    if (!getApiKey()) {
      const msg = '服务端未下发 AI Key，请在设置页手动填写'
      notifyProvisionFailed(msg)
      return { ok: false, error: msg }
    }
    lastProvisionError = null
    return { ok: true }
  } catch (e) {
    // 服务端不可达仍然回退用户自填，但不再静默：设置页有手填入口，得让用户知道要用它
    const msg = e instanceof Error ? e.message : String(e)
    notifyProvisionFailed(`服务端不可达（${msg}）`)
    return { ok: false, error: msg }
  }
}

export async function logout(): Promise<void> {
  await getSupabase()?.auth.signOut()
}

export async function getSession(): Promise<Session | null> {
  const sb = getSupabase()
  if (!sb) return null
  const { data } = await sb.auth.getSession()
  return data.session
}

export async function getAccessToken(): Promise<string | null> {
  return (await getSession())?.access_token ?? null
}

export async function authState(): Promise<{ loggedIn: boolean; email?: string }> {
  const s = await getSession()
  return s ? { loggedIn: true, email: s.user.email ?? undefined } : { loggedIn: false }
}
