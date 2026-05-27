'use client';

import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ChatMain } from '@/components/chat/ChatMain';
import { ConversationList } from '@/components/chat/ConversationList';
import {
  createConversation,
  deleteConversation,
  fetchChatInit,
  fetchConversations,
  fetchMessages,
  streamChat,
} from '@/lib/chat/client';
import type { ChatMessage, ChatRole, Conversation } from '@/types/chat';

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortConversations(list: Conversation[]) {
  return [...list].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
}

export default function ChatPage() {
  const [roles, setRoles] = useState<ChatRole[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [messagesByConversation, setMessagesByConversation] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [selectedRole, setSelectedRole] = useState<ChatRole | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const loadSeqRef = useRef(0);

  const loadMessages = useCallback(async (conversationId: string) => {
    const seq = ++loadSeqRef.current;
    setLoadingMessages(true);
    try {
      const msgs = await fetchMessages(conversationId);
      if (seq !== loadSeqRef.current) return;
      setMessagesByConversation((prev) => ({
        ...prev,
        [conversationId]: msgs,
      }));
    } catch (error) {
      if (seq !== loadSeqRef.current) return;
      toast.error(
        error instanceof Error ? error.message : '加载消息失败',
      );
    } finally {
      if (seq === loadSeqRef.current) setLoadingMessages(false);
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    const list = await fetchConversations();
    setConversations(sortConversations(list));
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const timeoutMs = 15_000;
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('加载超时，请刷新页面重试')),
            timeoutMs,
          ),
        );

        const data = await Promise.race([fetchChatInit(), timeout]);

        if (cancelled) return;

        setUserEmail(data.email);
        setIsAdmin(data.isAdmin);
        setRoles(data.roles);

        const defaultRole = data.roles[0] ?? null;
        setSelectedRole(defaultRole);

        const sorted = sortConversations(data.conversations);
        setConversations(sorted);

        if (sorted.length > 0) {
          const first = sorted[0]!;
          setActiveConversationId(first.id);
          const role = data.roles.find((r) => r.id === first.roleId);
          if (role) setSelectedRole(role);
          void loadMessages(first.id);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof Error ? error.message : '页面加载失败',
          );
        }
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [loadMessages]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId),
    [conversations, activeConversationId],
  );

  const messages = activeConversationId
    ? (messagesByConversation[activeConversationId] ?? [])
    : [];

  const roleForActive = useMemo(() => {
    if (activeConversation?.roleId) {
      const role = roles.find((r) => r.id === activeConversation.roleId);
      if (role) return role;
    }
    return selectedRole ?? roles[0]!;
  }, [activeConversation, roles, selectedRole]);

  const handleNewConversation = useCallback(async () => {
    if (!selectedRole) return;

    try {
      const conversation = await createConversation(selectedRole.id);
      setConversations((prev) =>
        sortConversations([conversation, ...prev]),
      );
      setMessagesByConversation((prev) => ({
        ...prev,
        [conversation.id]: [],
      }));
      setActiveConversationId(conversation.id);
      setInputValue('');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '创建会话失败',
      );
    }
  }, [selectedRole]);

  const handleSelectConversation = useCallback(
    async (id: string) => {
      setActiveConversationId(id);
      const conversation = conversations.find((c) => c.id === id);
      if (conversation?.roleId) {
        const role = roles.find((r) => r.id === conversation.roleId);
        if (role) setSelectedRole(role);
      }
      await loadMessages(id);
    },
    [conversations, roles, loadMessages],
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      try {
        await deleteConversation(id);
        const list = await refreshConversations();

        setMessagesByConversation((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });

        if (activeConversationId === id) {
          const nextActive = list[0]?.id ?? null;
          setActiveConversationId(nextActive);
          if (nextActive) {
            const conv = list.find((c) => c.id === nextActive);
            if (conv?.roleId) {
              const role = roles.find((r) => r.id === conv.roleId);
              if (role) setSelectedRole(role);
            }
            await loadMessages(nextActive);
          } else {
            setSelectedRole(roles[0] ?? null);
          }
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : '删除会话失败',
        );
      }
    },
    [activeConversationId, refreshConversations, roles, loadMessages],
  );

  const handleRoleChange = useCallback(
    async (role: ChatRole) => {
      setSelectedRole(role);
      const existing = conversations.find((c) => c.roleId === role.id);
      if (existing) {
        setActiveConversationId(existing.id);
        if (messagesByConversation[existing.id] === undefined) {
          await loadMessages(existing.id);
        }
      } else {
        setActiveConversationId(null);
      }
      setInputValue('');
    },
    [conversations, messagesByConversation, loadMessages],
  );

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || sending || !roleForActive) return;

    let conversationId = activeConversationId;
    const userMessageId = createId('msg');
    const assistantMessageId = createId('msg');

    setSending(true);
    setInputValue('');

    try {
      if (!conversationId) {
        const conversation = await createConversation(roleForActive.id);
        conversationId = conversation.id;
        setActiveConversationId(conversation.id);
        setConversations((prev) =>
          sortConversations([conversation, ...prev]),
        );
        setMessagesByConversation((prev) => ({
          ...prev,
          [conversation.id]: [],
        }));
      }

      const convId = conversationId;

      setMessagesByConversation((prev) => ({
        ...prev,
        [convId]: [
          ...(prev[convId] ?? []),
          { id: userMessageId, role: 'user', content: text },
          {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            streaming: true,
            thinking: true,
          },
        ],
      }));

      await streamChat(convId, text, roleForActive.id, (assistantContent) => {
        setMessagesByConversation((prev) => ({
          ...prev,
          [convId]: (prev[convId] ?? []).map((m) =>
            m.id === assistantMessageId
              ? {
                  ...m,
                  content: assistantContent,
                  thinking: false,
                  streaming: true,
                }
              : m,
          ),
        }));
      });

      setMessagesByConversation((prev) => ({
        ...prev,
        [convId]: (prev[convId] ?? []).map((m) =>
          m.id === assistantMessageId
            ? { ...m, streaming: false, thinking: false }
            : m,
        ),
      }));

      await refreshConversations();
    } catch (error) {
      setInputValue(text);
      if (conversationId) {
        setMessagesByConversation((prev) => ({
          ...prev,
          [conversationId!]: (prev[conversationId!] ?? []).filter(
            (m) => m.id !== userMessageId && m.id !== assistantMessageId,
          ),
        }));
      }
      toast.error(
        error instanceof Error ? error.message : '发送失败，请重试',
      );
    } finally {
      setSending(false);
    }
  }, [
    activeConversationId,
    inputValue,
    refreshConversations,
    roleForActive,
    sending,
  ]);

  if (pageLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!selectedRole && roles.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        暂无可用角色，请联系管理员配置。
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <ConversationList
        conversations={conversations}
        activeId={activeConversationId}
        userEmail={userEmail}
        isAdmin={isAdmin}
        onSelect={handleSelectConversation}
        onNew={handleNewConversation}
        onDelete={handleDeleteConversation}
      />
      <ChatMain
        roles={roles}
        selectedRole={roleForActive}
        messages={messages}
        inputValue={inputValue}
        sending={sending}
        loadingMessages={loadingMessages}
        onRoleChange={handleRoleChange}
        onInputChange={setInputValue}
        onSend={handleSend}
      />
    </div>
  );
}
