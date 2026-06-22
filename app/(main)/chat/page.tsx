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
  renameConversation,
  streamChat,
} from '@/lib/chat/client';
import { buildImportChatMessage } from '@/lib/import/chat-messages';
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const loadSeqRef = useRef(0);
  const pendingImportActionRef = useRef<{
    action: 'analyze' | 'script';
    aweme_id: string;
  } | null>(null);
  const importActionHandledRef = useRef(false);

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

  const sendMessageDirect = useCallback(
    async (text: string, targetRole: ChatRole) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      let conversationId: string | null = null;
      const existing = conversations.find((c) => c.roleId === targetRole.id);
      if (existing) {
        conversationId = existing.id;
        setActiveConversationId(existing.id);
        setSelectedRole(targetRole);
        if (messagesByConversation[existing.id] === undefined) {
          await loadMessages(existing.id);
        }
      }

      const userMessageId = createId('msg');
      const assistantMessageId = createId('msg');

      setSending(true);
      setInputValue('');

      try {
        if (!conversationId) {
          const conversation = await createConversation(targetRole.id);
          conversationId = conversation.id;
          setActiveConversationId(conversation.id);
          setSelectedRole(targetRole);
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
            { id: userMessageId, role: 'user', content: trimmed },
            {
              id: assistantMessageId,
              role: 'assistant',
              content: '',
              streaming: true,
              thinking: true,
            },
          ],
        }));

        const controller = new AbortController();
        abortRef.current = controller;

        await streamChat(convId, trimmed, targetRole.id, {
          onContent: (assistantContent) => {
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
          },
          onMeta: ({ knowledgeCount }) => {
            setMessagesByConversation((prev) => ({
              ...prev,
              [convId]: (prev[convId] ?? []).map((m) =>
                m.id === assistantMessageId ? { ...m, knowledgeCount } : m,
              ),
            }));
          },
          signal: controller.signal,
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
        // 用户主动点"停止"：保留已生成内容，不算错误
        if (error instanceof DOMException && error.name === 'AbortError') {
          setMessagesByConversation((prev) => ({
            ...prev,
            [conversationId!]: (prev[conversationId!] ?? []).map((m) =>
              m.id === assistantMessageId
                ? { ...m, streaming: false, thinking: false }
                : m,
            ),
          }));
          await refreshConversations();
        } else {
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
        }
      } finally {
        abortRef.current = null;
        setSending(false);
      }
    },
    [
      conversations,
      loadMessages,
      messagesByConversation,
      refreshConversations,
      sending,
    ],
  );

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || sending || !roleForActive) return;
    await sendMessageDirect(text, roleForActive);
  }, [inputValue, roleForActive, sendMessageDirect, sending]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      // 乐观更新
      setConversations((prev) =>
        sortConversations(
          prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
        ),
      );
      try {
        await renameConversation(id, trimmed);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '重命名失败');
        await refreshConversations();
      }
    },
    [refreshConversations],
  );

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const action = searchParams.get('action');
    const aweme_id = searchParams.get('aweme_id');
    if (
      !action ||
      !aweme_id ||
      (action !== 'analyze' && action !== 'script')
    ) {
      return;
    }

    pendingImportActionRef.current = {
      action,
      aweme_id,
    };
    importActionHandledRef.current = false;
    window.history.replaceState({}, '', '/chat');
  }, []);

  useEffect(() => {
    if (pageLoading || importActionHandledRef.current) return;
    const pending = pendingImportActionRef.current;
    if (!pending || roles.length === 0) return;

    importActionHandledRef.current = true;
    pendingImportActionRef.current = null;

    void (async () => {
      try {
        const res = await fetch(`/api/v1/videos/${pending.aweme_id}`);
        if (!res.ok) {
          toast.error('查询导入视频失败，请先在导入页解析视频');
          return;
        }
        const video = await res.json();

        const built = buildImportChatMessage(pending.action, video);
        if (!built) return;

        const targetRole = roles.find((r) => r.name === built.roleName);
        if (!targetRole) {
          toast.error(`未找到角色：${built.roleName}`);
          return;
        }

        await sendMessageDirect(built.message, targetRole);
      } catch (e) {
        console.error('自动触发对话失败', e);
        toast.error('自动发送失败，请重试');
      }
    })();
  }, [pageLoading, roles, sendMessageDirect]);

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
        onRename={handleRenameConversation}
        mobileOpen={mobileSidebarOpen}
        onMobileOpenChange={setMobileSidebarOpen}
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
        onStop={handleStop}
        onOpenSidebar={() => setMobileSidebarOpen(true)}
      />
    </div>
  );
}
