import { requireAdmin, scopeOrgId } from '@/lib/admin/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET() {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  const admin = createAdminClient();
  let query = admin.from('ai_roles').select('*').order('sort_order', {
    ascending: true,
  });

  const orgId = scopeOrgId(ctx);
  if (orgId) query = query.eq('organization_id', orgId);

  const { data: roles, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const enriched = await Promise.all(
    (roles ?? []).map(async (role) => {
      let versionNumber: number | null = null;
      if (role.current_prompt_version_id) {
        const { data: version } = await admin
          .from('prompt_versions')
          .select('version_number, system_prompt')
          .eq('id', role.current_prompt_version_id)
          .maybeSingle();
        versionNumber = version?.version_number ?? null;
      }
      return {
        ...role,
        currentPromptVersion: versionNumber,
      };
    }),
  );

  return Response.json(enriched);
}
