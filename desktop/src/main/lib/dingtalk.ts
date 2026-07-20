import { createHmac } from 'crypto'
import { store } from '../store'
import { log } from './logger'

/**
 * 自动化中心 · 钉钉群机器人推送。
 * 用户在钉钉群「智能群助手」添加自定义机器人（安全设置选"加签"），把 webhook 与密钥填进设置即可。
 */
export async function sendDingtalk(
  title: string,
  markdown: string
): Promise<{ ok: boolean; error?: string }> {
  const webhook = store.get('dingtalkWebhook')
  if (!webhook) return { ok: false, error: '未配置钉钉机器人' }
  let url = webhook
  const secret = store.get('dingtalkSecret')
  if (secret) {
    const ts = Date.now()
    const sign = encodeURIComponent(
      createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64')
    )
    url += `${url.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${sign}`
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text: markdown } }),
    })
    const j = (await r.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
    if (j.errcode === 0) return { ok: true }
    const error = j.errmsg || `HTTP ${r.status}`
    log('warn', 'dingtalk', `推送失败: ${error}`)
    return { ok: false, error }
  } catch (e) {
    log('warn', 'dingtalk', String(e))
    return { ok: false, error: String(e) }
  }
}

/** 事件通知（带开关判断；静默失败不干扰主流程） */
export function notifyDingtalk(kind: 'inbox' | 'artifact', title: string, markdown: string): void {
  if (!store.get('dingtalkWebhook')) return
  if (kind === 'inbox' && !store.get('dingtalkNotifyInbox')) return
  if (kind === 'artifact' && !store.get('dingtalkNotifyArtifact')) return
  void sendDingtalk(title, markdown)
}
