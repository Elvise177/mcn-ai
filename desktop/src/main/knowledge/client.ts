import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { store } from '../store'
import { getAccessToken, getSupabase, getSession, markCloudReachable, markCloudUnreachable } from '../auth'
import { tasks } from '../tasks/registry'
import { dropSyncFailure, pendingSyncTotal, pushSyncFailure } from '../tasks/persist'
import { backoffMs, isTransient, retryNotice, shouldAnnounceRetry } from '../lib/backoff'
import { vaultManager } from '../vault'

export interface CloudMatch {
  content: string
  similarity: number
  source_type: string
  visibility?: string
  metadata?: Record<string, unknown>
}

function apiBase(): string {
  return store.get('apiBaseUrl')
}

/**
 * 瞬态失败最多重试这么多次（N4）。三次之外不再自作主张——
 * 上云失败已经有 `noteSyncQueue` 兜着，聊天记录失败有 syncQueue 兜着，
 * 这里的重试只负责"抹平一次抖动"，不负责"替用户扛住一次停机"。
 */
const MAX_RETRIES = 3

/**
 * 带退避重试的云端请求（N4）。
 *
 * 重试**只针对瞬态失败**（连不上 / 429 / 5xx）：401、403、422 这些是服务端明确拒了这条数据，
 * 重试三次只是把同一句拒绝听三遍，还把真正的原因往后拖了两秒。
 *
 * 重试过程走 `tasks.setCloud({ retrying })` 落到 TaskDock 那一条上——
 * **不弹 toast、不进对话历史**（Codex §9 的取向：瞬态噪音归状态区，不归历史）。
 */
async function authedFetch(path: string, body: unknown): Promise<Response | null> {
  const token = await getAccessToken()
  if (!token) return null
  const url = `${apiBase()}${path}`
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      markCloudReachable() // 拿到任何响应都说明够得着云端，不必额外发探测
      if (res.ok || attempt === MAX_RETRIES || !isTransient({ status: res.status })) {
        clearRetryNotice()
        return res
      }
      await waitBeforeRetry(attempt, res.headers.get('retry-after'))
      continue
    } catch (e) {
      lastErr = e
      markCloudUnreachable(e)
      if (attempt === MAX_RETRIES || !isTransient({ error: e })) break
      await waitBeforeRetry(attempt, null)
    }
  }
  clearRetryNotice()
  throw lastErr
}

/** 退避 + 把「正在重试」摆到 TaskDock 上（首次静默） */
async function waitBeforeRetry(attempt: number, retryAfter: string | null): Promise<void> {
  if (shouldAnnounceRetry(attempt)) {
    tasks.setCloud({ retrying: retryNotice('云端同步', attempt, MAX_RETRIES) })
  }
  await new Promise((r) => setTimeout(r, backoffMs(attempt, { retryAfter })))
}

const clearRetryNotice = (): void => {
  if (tasks.getCloud().retrying) tasks.setCloud({ retrying: undefined })
}

/**
 * 单篇笔记上云（私人层）：内容哈希去重，未变更服务端直接跳过。
 *
 * **它不抛**（F3 改）：以前网络层失败会从 `authedFetch` 一路抛到 `cloudSync` 的外层 catch，
 * 于是**一篇失败就把整轮上云掐断**，后面几十篇连试都没试过就被记成"这一轮上云出错"。
 * 现在每一篇的失败各自归各自，由调用方决定进不进重试队列。
 */
export async function ingestNote(relPath: string): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const root = vaultManager.currentRoot
  if (!root) return { ok: false, error: 'vault 未打开' }
  let content: string
  try {
    content = await fs.readFile(join(root, relPath), 'utf-8')
  } catch (e) {
    return { ok: false, error: String(e) }
  }
  if (content.trim().length < 20) return { ok: true, skipped: true }

  const contentHash = createHash('sha256').update(content).digest('hex')
  try {
    const res = await authedFetch('/api/v1/knowledge/personal/ingest', {
      content,
      filePath: relPath,
      contentHash,
      sourceType: 'my_script',
    })
    if (!res) return { ok: false, error: '未登录' }
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text().catch(() => '')}` }
    const data = (await res.json()) as { skipped?: boolean }
    return { ok: true, skipped: data.skipped }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 三层云端检索；未登录/失败返回 null（调用方回退本地检索） */
export async function searchCloud(query: string, matchCount = 6): Promise<CloudMatch[] | null> {
  try {
    const res = await authedFetch('/api/v1/knowledge/personal/search', { query, matchCount })
    if (!res || !res.ok) return null
    const data = (await res.json()) as { matches: CloudMatch[] }
    return data.matches
  } catch {
    return null
  }
}

const syncPending = (): void => {
  tasks.setCloud({ pendingSync: pendingSyncTotal() })
}

/**
 * 这个失败是"连不上云端"还是"云端拒了这条数据"？
 * Postgres 的约束/RLS 拒绝一行**不等于**断网——那种情况点亮全局「云端离线」条，
 * 用户会去查网络，而真正的问题在数据里。只有传输层失败才算 Condition 变化。
 */
const looksOffline = (e: unknown): boolean =>
  /fetch failed|network|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo|socket hang up|timed? ?out|Failed to fetch/i.test(
    e instanceof Error ? e.message : String(e)
  )

/**
 * 聊天记录直写 Supabase（RLS=仅本人）。本地 electron-store 仍是权威副本。
 *
 * 失败不再静默蒸发（审计 M-03）：落进 syncQueue（退避 1m/5m/30m→转手动，见设计 §3.5），
 * 条数经 CloudState 暴露到全局条。一期只做入队与计数，真正的重试定时器在二期。
 */
export async function syncConversation(conv: {
  id: string
  title: string
  messages: { role: 'user' | 'assistant'; text: string }[]
}): Promise<void> {
  const sb = getSupabase()
  const session = await getSession().catch(() => null)
  if (!sb || !session) return // 未登录 = 本来就不同步，不是失败
  const id = `sync:${conv.id}`
  tasks.start({
    id,
    kind: 'sync',
    key: conv.id,
    title: '同步聊天记录',
    cancelable: false,
    scope: 'conversation',
    tries: 0,
  })
  try {
    const up = await sb.from('conversations').upsert({
      id: conv.id,
      user_id: session.user.id,
      title: conv.title,
      metadata: { source: 'desktop' },
      updated_at: new Date().toISOString(),
    })
    if (up.error) throw new Error(up.error.message)
    const last = conv.messages.slice(-2)
    for (const m of last) {
      const ins = await sb.from('messages').insert({
        conversation_id: conv.id,
        role: m.role,
        content: m.text,
        metadata: { source: 'desktop' },
      })
      if (ins.error) throw new Error(ins.error.message)
    }
    markCloudReachable()
    dropSyncFailure(conv.id)
    tasks.finish(id, 'succeeded')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const item = pushSyncFailure(conv.id, msg)
    if (looksOffline(e)) markCloudUnreachable(e)
    tasks.patch(id, { tries: item.tries, nextRetryAt: item.nextRetryAt })
    tasks.finish(id, 'failed', msg)
  } finally {
    syncPending()
  }
}
