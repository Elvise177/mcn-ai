import { promises as fs } from 'fs'
import { join, normalize } from 'path'
import { store } from '../store'
import { getAccessToken } from '../auth'
import { log } from '../lib/logger'

/**
 * 经营数据自动入库：从服务端拉取钉钉抖音数据聚合笔记，写入 vault。
 * 开库后拉一次，之后每 6 小时刷新；未登录/离线静默跳过。
 * 笔记落位 40_带货/抖音经营数据/，watcher 自动索引，AI 问答即可引用。
 */
let timer: ReturnType<typeof setInterval> | null = null

export async function syncBizNotes(vaultRoot: string): Promise<void> {
  try {
    const token = await getAccessToken()
    if (!token) return
    const base = store.get('apiBaseUrl')
    const r = await fetch(`${base}/api/v1/automation/dingtalk/vault-notes`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) {
      log('warn', 'bizdata', `拉取经营数据失败 HTTP ${r.status}`)
      return
    }
    const j = (await r.json()) as { notes?: Array<{ path: string; content: string }> }
    let written = 0
    for (const n of j.notes ?? []) {
      // 路径安全：只允许写进 vault 内的相对路径
      const rel = normalize(n.path)
      if (rel.startsWith('..') || rel.startsWith('/')) continue
      const abs = join(vaultRoot, rel)
      await fs.mkdir(join(abs, '..'), { recursive: true })
      const old = await fs.readFile(abs, 'utf-8').catch(() => '')
      if (old !== n.content) {
        await fs.writeFile(abs, n.content, 'utf-8')
        written++
      }
    }
    if (written) log('info', 'bizdata', `经营数据笔记更新 ${written} 篇`)
  } catch (e) {
    log('warn', 'bizdata', String(e))
  }
}

export function startBizSync(vaultRoot: string): void {
  void syncBizNotes(vaultRoot)
  if (timer) clearInterval(timer)
  timer = setInterval(() => void syncBizNotes(vaultRoot), 6 * 3600 * 1000)
}
