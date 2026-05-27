import '@/lib/events/init';

import { requireUserProfile } from '@/lib/auth/server-profile';
import { eventBus, Events } from '@/lib/events/bus';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

type PatchConversationBody = {
  title?: string;
};

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!conversation) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const { data: messages, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(messages || []);
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const auth = await requireUserProfile();
  if ('error' in auth) return auth.error;
  const { user, profile } = auth;

  const supabase = await createClient();
  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  eventBus.emit(Events.CONVERSATION_DELETED, {
    userId: user.id,
    organizationId: profile?.organization_id,
    resourceType: 'conversation',
    resourceId: id,
  });

  return Response.json({ success: true });
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  let body: PatchConversationBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { title } = body;
  if (!title?.trim()) {
    return Response.json({ error: 'Missing title' }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!existing) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('conversations')
    .update({
      title: title.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}
