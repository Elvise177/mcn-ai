import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('ai_roles')
    .select('id, name, description, icon, category, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data || []);
}
