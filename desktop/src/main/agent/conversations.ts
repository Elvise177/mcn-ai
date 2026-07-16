import '../env-hooks'
import Store from 'electron-store'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface Conversation {
  id: string
  title: string
  sdkSessionId?: string
  messages: ChatMessage[]
  updatedAt: number
}

/** M3 本地持久化（electron-store）；M4 切 Supabase 直写 */
const convStore = new Store<{ conversations: Conversation[] }>({
  name: 'conversations',
  defaults: { conversations: [] },
})

export function listConversations(): Conversation[] {
  return [...convStore.get('conversations')].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveConversation(conv: Conversation): void {
  const all = convStore.get('conversations').filter((c) => c.id !== conv.id)
  all.push({ ...conv, updatedAt: Date.now() })
  convStore.set('conversations', all.slice(-100))
}

export function deleteConversation(id: string): void {
  convStore.set('conversations', convStore.get('conversations').filter((c) => c.id !== id))
}
