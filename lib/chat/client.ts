import type { ChatMessage, ChatRole, Conversation } from '@/types/chat';

type ApiRole = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string;
  sort_order: number;
};

type ApiConversation = {
  id: string;
  title: string;
  role_id: string | null;
  updated_at: string;
};

type ApiMessage = {
  id: string;
  role: string;
  content: string;
};

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // ignore
  }
  return text || res.statusText || '请求失败';
}

export function mapRole(role: ApiRole): ChatRole {
  return {
    id: role.id,
    name: role.name,
    icon: role.icon || '🤖',
    description: role.description,
    category: role.category,
  };
}

export function mapConversation(conv: ApiConversation): Conversation {
  return {
    id: conv.id,
    title: conv.title,
    roleId: conv.role_id ?? '',
    updatedAt: new Date(conv.updated_at),
  };
}

export function mapMessage(msg: ApiMessage): ChatMessage {
  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  };
}

export async function fetchChatInit(): Promise<{
  email: string;
  role: string;
  isAdmin: boolean;
  roles: ChatRole[];
  conversations: Conversation[];
}> {
  const res = await fetch('/api/v1/chat/init');
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as {
    email: string;
    role: string;
    isAdmin: boolean;
    roles: ApiRole[];
    conversations: ApiConversation[];
  };
  return {
    email: data.email,
    role: data.role,
    isAdmin: data.isAdmin,
    roles: data.roles.map(mapRole),
    conversations: data.conversations.map(mapConversation),
  };
}

export async function fetchRoles(): Promise<ChatRole[]> {
  const res = await fetch('/api/v1/roles');
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as ApiRole[];
  return data.map(mapRole);
}

export async function fetchConversations(): Promise<Conversation[]> {
  const res = await fetch('/api/v1/conversations');
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as ApiConversation[];
  return data.map(mapConversation);
}

export async function fetchMessages(conversationId: string): Promise<ChatMessage[]> {
  const res = await fetch(`/api/v1/conversations/${conversationId}`);
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as ApiMessage[];
  return data
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map(mapMessage);
}

export async function createConversation(roleId: string): Promise<Conversation> {
  const res = await fetch('/api/v1/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roleId }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as ApiConversation;
  return mapConversation(data);
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const res = await fetch(`/api/v1/conversations/${conversationId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function streamChat(
  conversationId: string,
  message: string,
  roleId: string,
  onContent: (content: string) => void,
): Promise<void> {
  const response = await fetch('/api/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, message, roleId }),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let assistantContent = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;

      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data) as { content?: string };
        if (parsed.content) {
          assistantContent += parsed.content;
          onContent(assistantContent);
        }
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }
}
