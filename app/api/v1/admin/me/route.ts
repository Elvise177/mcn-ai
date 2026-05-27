import { requireAdmin } from '@/lib/admin/auth';

export async function GET() {
  const ctx = await requireAdmin();
  if (ctx instanceof Response) return ctx;

  return Response.json({
    userId: ctx.userId,
    email: ctx.email,
    name: ctx.name,
    role: ctx.role,
    organizationId: ctx.organizationId,
    isSuperAdmin: ctx.isSuperAdmin,
  });
}
