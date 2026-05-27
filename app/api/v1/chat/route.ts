import '@/lib/events/init';

import { getSystemSettings } from '@/lib/admin/system-settings';
import { requireUserProfile } from '@/lib/auth/server-profile';
import { getProvider } from '@/lib/ai';
import { PromptManager } from '@/lib/ai/prompts/manager';
import { eventBus, Events } from '@/lib/events/bus';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { TokenUsage } from '@/lib/ai/types';
import type { Tables } from '@/types/database';

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

  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!conversation) {
    return new Response('Conversation not found', { status: 404 });
  }

  const { data: role } = await supabase
    .from('ai_roles')
    .select('*')
    .eq('id', roleId)
    .single<Tables<'ai_roles'>>();
  if (!role) return new Response('Role not found', { status: 404 });

  let promptInfo: { systemPrompt: string };
  try {
    promptInfo = await PromptManager.getCurrentPrompt(roleId);
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : 'Prompt not configured';
    return new Response(msg, { status: 404 });
  }

  const runtimeSettings = await getSystemSettings();

  const { data: history } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true })
    .limit(runtimeSettings.limits.maxHistoryMessages)
    .returns<{ role: 'user' | 'assistant'; content: string }[]>();

  const messages = [
    { role: 'system' as const, content: promptInfo.systemPrompt },
    ...(history || []).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'user' as const, content: message.trim() },
  ];

  const admin = createAdminClient();
  await admin.from('messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: message.trim(),
  });

  eventBus.emit(Events.USER_MESSAGE_SENT, {
    userId: user.id,
    organizationId: profile.organization_id,
    resourceType: 'conversation',
    resourceId: conversationId,
    details: { conversationId, roleId },
  });

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
    });
  } catch (error) {
    eventBus.emit(Events.ERROR_OCCURRED, {
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

  const encoder = new TextEncoder();
  const sseStream = new ReadableStream({
    async start(controller) {
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

        const cost = provider.calculateCost(
          role.model,
          usage ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        );
        const duration = Date.now() - startTime;

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
        });

        const { count } = await admin
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', conversationId);

        const updates: { updated_at: string; title?: string } = {
          updated_at: new Date().toISOString(),
        };
        if (count !== null && count <= 2) {
          updates.title = message.trim().slice(0, 30);
        }
        await admin
          .from('conversations')
          .update(updates)
          .eq('id', conversationId);

        eventBus.emit(Events.AI_RESPONSE_GENERATED, {
          userId: user.id,
          organizationId: profile.organization_id,
          modelUsed: role.model,
          totalTokens: usage?.total_tokens ?? 0,
          costUsd: cost,
          roleId,
        });

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        eventBus.emit(Events.ERROR_OCCURRED, {
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
  });

  return new Response(sseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
