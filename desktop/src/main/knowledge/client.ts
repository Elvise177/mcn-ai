import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { store } from '../store'
import { getAccessToken, getSupabase, getSession } from '../auth'
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

async function authedFetch(path: string, body: unknown): Promise<Response | null> {
  const token = await getAccessToken()
  if (!token) return null
  return fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

/** 单篇笔记上云（私人层）：内容哈希去重，未变更服务端直接跳过 */
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

/** 聊天记录直写 Supabase（RLS=仅本人）；失败静默，本地 electron-store 仍是权威副本 */
export async function syncConversation(conv: {
  id: string
  title: string
  messages: { role: 'user' | 'assistant'; text: string }[]
}): Promise<void> {
  const sb = getSupabase()
  const session = await getSession()
  if (!sb || !session) return
  try {
    await sb.from('conversations').upsert({
      id: conv.id,
      user_id: session.user.id,
      title: conv.title,
      metadata: { source: 'desktop' },
      updated_at: new Date().toISOString(),
    })
    const last = conv.messages.slice(-2)
    for (const m of last) {
      await sb.from('messages').insert({
        conversation_id: conv.id,
        role: m.role,
        content: m.text,
        metadata: { source: 'desktop' },
      })
    }
  } catch {
    /* 离线/网络错误：忽略，云端同步尽力而为 */
  }
}
