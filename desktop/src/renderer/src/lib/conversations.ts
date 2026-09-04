/**
 * 会话列表的排序与筛选（F5）——纯函数，`smoke:steps` 零花费验。
 *
 * 抽出来的理由是排序这类东西**错了不会报错，只会"看着不太对"**：
 * 置顶的掉到中间、改完名字跳到列表头、搜「灰太太」搜不到明明在的那条。
 * 这些在走查里要靠人眼盯，在这儿几毫秒就能守住。
 */

export interface ConvLike {
  id: string
  title: string
  updatedAt: number
  /** 置顶时间戳；0/undefined = 没置顶。**用时间戳不用布尔**：多条置顶时才排得出先后 */
  pinned?: number
  messages?: Array<{ role: string; text: string }>
}

/**
 * 侧栏顺序：**置顶的在上（后置顶的更靠前），其余按最近活动**。
 *
 * 为什么置顶之间按"置顶时间"倒序而不是按活动时间：置顶是"我要它一直在手边"，
 * 刚钉上的那条通常正是现在要用的；让它被一条更早钉住、但刚回过一句话的挤下去，
 * 用户会以为置顶没生效。
 */
export function sortConversations<T extends ConvLike>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const pa = a.pinned ?? 0
    const pb = b.pinned ?? 0
    if (pa !== pb) return pb - pa // 置顶的在前；都置顶则后钉的在前
    return b.updatedAt - a.updatedAt
  })
}

/**
 * 命令面板里搜对话。**标题与正文都搜**——用户记得住的往往是聊过的那句话，
 * 而不是自动截出来的前 18 个字当标题。
 *
 * 命中位置也回出去：面板要在第二行摆一小段上下文，只给标题的话
 * 用户看不出"为什么这条被搜出来了"。
 */
export function matchConversations<T extends ConvLike>(
  list: T[],
  q: string,
  limit = 8
): Array<{ conv: T; snippet?: string }> {
  const needle = q.trim().toLowerCase()
  if (!needle) return sortConversations(list).slice(0, limit).map((conv) => ({ conv }))
  const out: Array<{ conv: T; snippet?: string }> = []
  for (const conv of sortConversations(list)) {
    if (out.length >= limit) break
    if (conv.title.toLowerCase().includes(needle)) {
      out.push({ conv })
      continue
    }
    const hit = (conv.messages ?? []).find((m) => m.text?.toLowerCase().includes(needle))
    if (hit) out.push({ conv, snippet: excerpt(hit.text, needle) })
  }
  return out
}

/** 命中处前后各留一点：光给整段正文的话，一行里根本看不到关键词在哪 */
export function excerpt(text: string, needle: string, span = 24): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return text.slice(0, span * 2)
  const from = Math.max(0, i - span)
  const to = Math.min(text.length, i + needle.length + span)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`
}

/**
 * 会话内查找（Cmd+F）：这一条对话里哪几条消息含这个词。
 * 返回下标——渲染层据此滚过去并高亮，不改消息内容本身。
 */
export function findInMessages(messages: Array<{ text: string }>, q: string): number[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const hits: number[] = []
  messages.forEach((m, i) => {
    if (m.text?.toLowerCase().includes(needle)) hits.push(i)
  })
  return hits
}
