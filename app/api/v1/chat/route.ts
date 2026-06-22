import '@/lib/events/init';

import { getSystemSettings } from '@/lib/admin/system-settings';
import { requireUserProfile } from '@/lib/auth/server-profile';
import { getProvider } from '@/lib/ai';
import { PromptManager } from '@/lib/ai/prompts/manager';
import { eventBus, Events } from '@/lib/events/bus';
import {
  searchKnowledge,
  formatMatchesForPrompt,
  type KnowledgeMatch,
} from '@/lib/knowledge';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { UsageTracker } from '@/lib/usage/tracker';
import type { TokenUsage } from '@/lib/ai/types';
import type { Json, Tables } from '@/types/database';

type ChatRequestBody = {
  conversationId?: string;
  message?: string;
  roleId?: string;
};

export async function POST(req: Request) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { conversationId, message, roleId } = body;

  if (!conversationId || !message?.trim() || !roleId) {
    return new Response('Missing conversationId, message, or roleId', {
      status: 400,
    });
  }

  const supabase = await createClient();
  const auth = await requireUserProfile();
  if ('error' in auth) return auth.error;
  const { user, profile } = auth;

  const runtimeSettings = await getSystemSettings();
  const trimmedMessage = message.trim();

  // 消息长度限制（中文场景下字符数 ≈ token 数，按字符近似）
  if (trimmedMessage.length > runtimeSettings.limits.maxTokensPerMessage) {
    return Response.json(
      {
        error: `消息过长，最多 ${runtimeSettings.limits.maxTokensPerMessage} 字`,
      },
      { status: 400 },
    );
  }

  // 每日消息限额
  const todayCount = await UsageTracker.getTodayMessageCount(user.id);
  if (todayCount >= runtimeSettings.limits.maxDailyMessagesPerUser) {
    return Response.json(
      {
        error: `已达今日消息上限（${runtimeSettings.limits.maxDailyMessagesPerUser} 条），请明天再试`,
      },
      { status: 429 },
    );
  }

  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!conversation) {
    return new Response('Conversation not found', { status: 404 });
  }

  const admin = createAdminClient();

  // 单会话消息上限
  const { count: existingCount } = await admin
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId);
  if (
    existingCount !== null &&
    existingCount >= runtimeSettings.limits.maxMessagesPerConversation
  ) {
    return Response.json(
      { error: '该会话消息数已达上限，请新建会话' },
      { status: 429 },
    );
  }

  const { data: role } = await supabase
    .from('ai_roles')
    .select('*')
    .eq('id', roleId)
    .eq('is_active', true)
    .maybeSingle<Tables<'ai_roles'>>();
  if (!role) return new Response('Role not found', { status: 404 });

  let promptInfo: { systemPrompt: string };
  try {
    promptInfo = await PromptManager.getCurrentPrompt(roleId);
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : 'Prompt not configured';
    return new Response(msg, { status: 404 });
  }

  // RAG：检索同组织知识库（热门脚本/爆款拆解/口播转写），注入 system prompt
  let knowledgeMatches: KnowledgeMatch[] = [];
  let systemPrompt = promptInfo.systemPrompt;
  if (role.enable_rag && profile.organization_id) {
    try {
      knowledgeMatches = await searchKnowledge(
        trimmedMessage,
        profile.organization_id,
        { matchCount: 6 },
      );
      systemPrompt += formatMatchesForPrompt(knowledgeMatches);
    } catch (error) {
      // 检索失败降级为普通生成，不阻塞对话
      console.error('[Chat] RAG search failed:', error);
    }
  }

  // 取最近 N 条历史（降序取再反转，确保拿到的是最新上下文）
  const { data: recentHistory } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(runtimeSettings.limits.maxHistoryMessages)
    .returns<{ role: 'user' | 'assistant'; content: string }[]>();
  const history = (recentHistory || []).reverse();

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: trimmedMessage },
  ];

  await admin.from('messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: trimmedMessage,
  });

  // serverless 下事件必须在响应结束前 await，否则函数冻结导致写库丢失
  const pendingEvents: Promise<void>[] = [
    eventBus.emitAsync(Events.USER_MESSAGE_SENT, {
      userId: user.id,
      organizationId: profile.organization_id,
      resourceType: 'conversation',
      resourceId: conversationId,
      details: { conversationId, roleId },
    }),
  ];

  let provider;
  try {
    provider = getProvider(role.model_provider);
  } catch {
    return new Response(`Unknown AI provider: ${role.model_provider}`, {
      status: 400,
    });
  }

  let stream: ReadableStream<{ type: string; content?: string; usage?: TokenUsage }>;
  try {
    stream = await provider.chatStream({
      messages,
      model: role.model,
      temperature: role.temperature,
      max_tokens: role.max_tokens,
      signal: req.signal,
    });
  } catch (error) {
    await eventBus.emitAsync(Events.ERROR_OCCURRED, {
      userId: user.id,
      organizationId: profile.organization_id,
      details: {
        conversationId,
        roleId,
        error: error instanceof Error ? error.message : 'AI stream failed',
      },
    });
    return new Response('Failed to start AI stream', { status: 502 });
  }

  let fullContent = '';
  let usage: TokenUsage | null = null;
  const startTime = Date.now();

  const knowledgeRefs = knowledgeMatches.map((m) => ({
    chunk_id: m.id,
    source_type: m.source_type,
    similarity: m.similarity,
  }));

  // 收尾落库：正常结束和客户端中断都要保存已生成内容（防重入）
  let persisted = false;
  const persistAssistantMessage = async () => {
    if (persisted) return;
    persisted = true;
    const cost = provider.calculateCost(
      role.model,
      usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    );
    const duration = Date.now() - startTime;

    if (fullContent) {
      await admin.from('messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: fullContent,
        model_used: role.model,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0,
        cost_usd: cost,
        duration_ms: duration,
        knowledge_refs: knowledgeRefs as Json,
      });
    }

    const updates: { updated_at: string; title?: string } = {
      updated_at: new Date().toISOString(),
    };
    if (existingCount !== null && existingCount === 0) {
      updates.title = trimmedMessage.slice(0, 30);
    }
    await admin.from('conversations').update(updates).eq('id', conversationId);

    pendingEvents.push(
      eventBus.emitAsync(Events.AI_RESPONSE_GENERATED, {
        userId: user.id,
        organizationId: profile.organization_id,
        modelUsed: role.model,
        totalTokens: usage?.total_tokens ?? 0,
        costUsd: cost,
        roleId,
      }),
    );
    await Promise.allSettled(pendingEvents);
  };

  const encoder = new TextEncoder();
  const sseStream = new ReadableStream({
    async start(controller) {
      // 先告知前端本次 RAG 命中数，用于展示"参考了 N 条爆款"
      if (knowledgeMatches.length > 0) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ knowledgeCount: knowledgeMatches.length })}\n\n`,
          ),
        );
      }
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.type === 'content' && value.content) {
            fullContent += value.content;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ content: value.content })}\n\n`,
              ),
            );
          } else if (value.type === 'done' && value.usage) {
            usage = value.usage;
          }
        }

        await persistAssistantMessage();

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        // 客户端断开（abort）时保存已生成部分，不算错误
        if (req.signal.aborted) {
          await persistAssistantMessage();
          try {
            controller.close();
          } catch {
            // 流可能已被取消
          }
          return;
        }

        await eventBus.emitAsync(Events.ERROR_OCCURRED, {
          userId: user.id,
          organizationId: profile.organization_id,
          details: {
            conversationId,
            roleId,
            error: error instanceof Error ? error.message : 'Stream error',
          },
        });
        controller.error(error);
      }
    },
    async cancel() {
      // 浏览器取消读取（关页/停止）：保存已生成部分
      await persistAssistantMessage();
    },
  });

  return new Response(sseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
