import '../env-hooks'
import Store from 'electron-store'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** 这条是错误提示气泡（渲染层 M-11 用它挂「重试」）。会话恢复失败重建上下文时要跳过它们 */
  error?: boolean
  /** B-6 / Q8：这条回答里没有依据的引用；渲染成角标，不进正文（重建上下文时也不会喂回模型） */
  unverified?: string[]
}

export interface Conversation {
  id: string
  title: string
  sdkSessionId?: string
  messages: ChatMessage[]
  updatedAt: number
  /** 会话级模型档位（标准/增强）。按会话记忆，所以它跟着对话一起落盘 */
  tier?: 'standard' | 'enhanced'
  /**
   * 置顶时间戳（F5）；0/undefined = 没置顶。
   * **用时间戳不用布尔**：多条置顶时才排得出先后（刚钉上的那条通常正是现在要用的）。
   */
  pinned?: number
}

/** M3 本地持久化（electron-store）；M4 切 Supabase 直写 */
const convStore = new Store<{ conversations: Conversation[] }>({
  name: 'conversations',
  defaults: { conversations: [] },
})

export function listConversations(): Conversation[] {
  return [...convStore.get('conversations')].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 取某个会话的本地历史。**会话恢复失败时靠它重建上下文**——本地这份始终是权威副本，
 * SDK 侧的 session 掉了不代表内容没了。
 *
 * 调用时机很关键：渲染层是「先 `chat:send` 再 `chat:save`」，所以必须在 `send()` 的
 * **第一个同步 tick** 就读，晚一步会把本轮提问也读进来（本轮 prompt 是单独传的，会重复一遍）。
 */
export function conversationMessages(id: string): ChatMessage[] {
  return convStore.get('conversations').find((c) => c.id === id)?.messages ?? []
}

export function saveConversation(conv: Conversation): void {
  const all = convStore.get('conversations').filter((c) => c.id !== conv.id)
  all.push({ ...conv, updatedAt: Date.now() })
  convStore.set('conversations', all.slice(-100))
}

export function deleteConversation(id: string): void {
  convStore.set('conversations', convStore.get('conversations').filter((c) => c.id !== id))
}
