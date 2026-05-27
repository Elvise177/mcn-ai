import { requireAdmin } from '@/lib/admin/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET() {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const admin = createAdminClient();
  const { data: logs, error } = await admin
    .from('audit_logs')
    .select('*')
    .eq('user_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json(logs ?? []);
}
