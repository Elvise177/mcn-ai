import '../env-hooks'
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { BrowserWindow } from 'electron'
import Store from 'electron-store'
import { tasks } from '../tasks/registry'
import { clearSyncQueue, getSyncQueue } from '../tasks/persist'
import { SecretVault, type SecretBackend } from '../secrets'

/** Supabase 公开配置（anon key 设计上可公开，RLS 才是安全边界）；从 webpage 同项目取。
    MCNAI_SUPABASE_URL 只给 e2e 用：把它指到黑洞地址才能验"云端不可达"那条登录分支（M-01） */
const SUPABASE_URL = process.env.MCNAI_SUPABASE_URL || 'https://yqozqfrmdddmfrpavrsn.supabase.co'
interface AuthStoreSchema {
  anonKey?: string
  encryptedSession?: string
  /** 密钥指纹与盐（不是秘密，见 secrets.ts） */
  secretSalt?: string
  encryptedSessionFp?: string
}
const SUPABASE_ANON_KEY_STORE = new Store<AuthStoreSchema>({ name: 'auth' })

const DEFAULT_ANON_KEY = 'sb_publishable_7qxnJzHZD5brxiAQplAvcA_xx2_7i7X'

function getAnonKey(): string | null {
  return process.env.MCNAI_SUPABASE_ANON_KEY || SUPABASE_ANON_KEY_STORE.get('anonKey') || DEFAULT_ANON_KEY
}

export function setAnonKey(key: string): void {
  SUPABASE_ANON_KEY_STORE.set('anonKey', key.trim())
}

/**
 * 会话也走保险箱（M-29）：signInWithPassword 成功后 supabase-js 会立刻 setItem 落盘，
 * 而那次 `safeStorage.encryptString` 是进程内第一次触碰 Keychain——同步、能冻主进程几十秒。
 * 以前它就卡在「登录中…」那颗按钮上，体感就是点了登录应用死了。
 * 现在：明文先进内存（getItem 立刻读得到，会话立即可用），落盘转后台任务。
 */
const sessionBackend: SecretBackend = {
  read: (k) => SUPABASE_ANON_KEY_STORE.get(k as 'encryptedSession'),
  write: (k, v) => SUPABASE_ANON_KEY_STORE.set(k, v),
  remove: (k) => SUPABASE_ANON_KEY_STORE.delete(k as 'encryptedSession'),
}
const sessionVault = new SecretVault(sessionBackend, '登录状态')
export const isSessionWritePending = (): boolean => sessionVault.isPending('encryptedSession')

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
        // safeStorage 加密落盘，替代浏览器 localStorage（读写规则见 secrets.ts）
        getItem: (k: string) => (k === 'mcnai-session' ? sessionVault.read('encryptedSession') : null),
        setItem: (k: string, v: string) => {
          // token 刷新时值确实变了（真写一次，热调用毫秒级）；值没变的重复写直接跳过
          if (k === 'mcnai-session') sessionVault.writeLater('encryptedSession', v)
        },
        removeItem: (k: string) => {
          if (k === 'mcnai-session') sessionVault.remove('encryptedSession')
        },
      },
      storageKey: 'mcnai-session',
    },
  })
  return client
}

/**
 * 登录失败的种类（M-01）。渲染层据此给不同文案——
 * Supabase 被暂停或断网时给「密码错」是最坏的一种误导：用户会一遍遍改密码。
 */
export type LoginKind = 'credential' | 'network' | 'timeout' | 'canceled' | 'config'
export interface LoginResult {
  ok: boolean
  kind?: LoginKind
  error?: string
}

/** 登录超时：Supabase 被暂停时域名直接 NXDOMAIN，signInWithPassword 会挂很久 */
const LOGIN_TIMEOUT_MS = 10_000

/** 取信号：`auth:loginCancel` 用它把界面从「登录中…」放出来（底层请求可能仍在跑，但没人等它了） */
let releaseLogin: ((r: LoginResult) => void) | null = null
export function cancelLogin(): void {
  releaseLogin?.({ ok: false, kind: 'canceled' })
}

/** 网络层失败 vs 凭据错误：supabase-js 两种都塞在 AuthError 里，只能按形态区分 */
function isNetworkish(e: { name?: string; status?: number; message?: string }): boolean {
  if (e.name === 'AuthRetryableFetchError') return true
  // 凭据错误一定带 4xx；网络层失败 status 是 0/undefined
  if (!e.status) return true
  return /fetch failed|network|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo|socket hang up|timed? ?out/i.test(
    e.message ?? ''
  )
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const sb = getSupabase()
  if (!sb) return { ok: false, kind: 'config', error: '未配置 Supabase anon key（设置页填写）' }

  const attempt = (async (): Promise<LoginResult> => {
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password })
      if (!error) return { ok: true }
      const net = isNetworkish(error)
      if (net) markCloudUnreachable(error)
      return { ok: false, kind: net ? 'network' : 'credential', error: error.message }
    } catch (e) {
      markCloudUnreachable(e)
      return { ok: false, kind: 'network', error: e instanceof Error ? e.message : String(e) }
    }
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const r = await Promise.race<LoginResult>([
    attempt,
    new Promise<LoginResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, kind: 'timeout' }), LOGIN_TIMEOUT_MS)
    }),
    new Promise<LoginResult>((resolve) => {
      releaseLogin = resolve
    }),
  ])
  clearTimeout(timer)
  releaseLogin = null

  if (r.kind === 'timeout') {
    markCloudUnreachable(new Error(`登录超时（${LOGIN_TIMEOUT_MS / 1000}s 无响应）`))
    // 请求本身还挂在那儿：万一它后来成功了，把结果落进会话，用户下次进来就是已登录
    void attempt.then((late) => {
      if (late.ok) void probeCloud()
    })
    return r
  }
  if (!r.ok) return r

  void provisionKeys() // 登录即用：服务端下发 AI key（不阻塞登录返回）
  void probeCloud()
  return { ok: true }
}

export type ProvisionResult = { ok: boolean; error?: string; wrote?: string[] }

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
    const { store, setApiKey, setLlmKey, hasApiKey, hasLlmKey } = await import('../store')
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
    // 写前判重在 setApiKey 内部（指纹比对，零 Keychain 触碰）：老用户每次启动都会走到这里，
    // 值没变就一次都不写——M-29 的"登录/启动冻几十秒"绝大多数就是这条路径重复写同一把 key
    const wrote: string[] = []
    if (cfg.relayApiKey && (!store.get('manualApiKey') || !hasApiKey())) {
      if (setApiKey(cfg.relayApiKey) !== 'unchanged') wrote.push('relayApiKey')
      if (cfg.relayBaseUrl) store.set('relayBaseUrl', cfg.relayBaseUrl)
    }
    if (cfg.llmApiKey && (!store.get('manualLlmKey') || !hasLlmKey())) {
      if (setLlmKey(cfg.llmApiKey) !== 'unchanged') wrote.push('llmApiKey')
      if (cfg.llmBaseUrl) store.set('llmBaseUrl', cfg.llmBaseUrl)
      if (cfg.llmModel) store.set('llmModel', cfg.llmModel)
    }
    if (!hasApiKey()) {
      const msg = '服务端未下发 AI Key，请在设置页手动填写'
      notifyProvisionFailed(msg)
      return { ok: false, error: msg }
    }
    lastProvisionError = null
    return { ok: true, wrote }
  } catch (e) {
    // 服务端不可达仍然回退用户自填，但不再静默：设置页有手填入口，得让用户知道要用它
    const msg = e instanceof Error ? e.message : String(e)
    notifyProvisionFailed(`服务端不可达（${msg}）`)
    return { ok: false, error: msg }
  }
}

export async function logout(): Promise<void> {
  await getSupabase()?.auth.signOut()
  // 队列里的记录属于上一个账号，不能带到下一个账号的 Supabase 里去
  clearSyncQueue()
  tasks.setCloud({ loggedIn: false, email: undefined, pendingSync: 0 })
}

/**
 * 云端状况探测（Condition，不是 Task——它没有终态）。
 * 探测本身要有超时，否则 Supabase 被暂停（域名 NXDOMAIN）时这里会挂很久。
 */
export async function probeCloud(): Promise<void> {
  const { store } = await import('../store')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 6000)
  try {
    // HEAD 根路径就够回答"云端够不够得着"，不依赖任何具体业务端点
    await fetch(store.get('apiBaseUrl'), { method: 'HEAD', signal: ctl.signal })
    markCloudReachable()
  } catch (e) {
    markCloudUnreachable(e)
  } finally {
    clearTimeout(timer)
  }
  const s = await getSession().catch(() => null)
  tasks.setCloud({ loggedIn: !!s, email: s?.user.email ?? undefined, pendingSync: getSyncQueue().length })
}

/** 任何一次真实请求成功都顺带证明云端可达，不必额外发探测请求 */
export function markCloudReachable(): void {
  tasks.setCloud({ reachable: true, lastError: undefined })
}

export function markCloudUnreachable(e: unknown): void {
  tasks.setCloud({ reachable: false, lastError: e instanceof Error ? e.message : String(e) })
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
