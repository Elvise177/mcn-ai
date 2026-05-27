import '@/lib/events/init';

import { requireUserProfile } from '@/lib/auth/server-profile';
import { eventBus, Events } from '@/lib/events/bus';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

type CreateConversationBody = {
  roleId?: string;
};

export async function GET() {
  const auth = await requireUserProfile();
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data || []);
}

export async function POST(req: Request) {
  let body: CreateConversationBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { roleId } = body;
  if (!roleId) {
    return Response.json({ error: 'Missing roleId' }, { status: 400 });
  }

  const auth = await requireUserProfile();
  if ('error' in auth) return auth.error;
  const { user, profile } = auth;

  const supabase = await createClient();
  const { data: role } = await supabase
    .from('ai_roles')
    .select('id')
    .eq('id', roleId)
    .eq('is_active', true)
    .maybeSingle();
  if (!role) {
    return Response.json({ error: 'Role not found' }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('conversations')
    .insert({
      user_id: user.id,
      organization_id: profile?.organization_id ?? null,
      role_id: roleId,
    })
    .select()
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });

  eventBus.emit(Events.CONVERSATION_CREATED, {
    userId: user.id,
    organizationId: profile?.organization_id,
    resourceType: 'conversation',
    resourceId: data.id,
    details: { roleId },
  });

  return Response.json(data);
}
