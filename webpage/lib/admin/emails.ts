import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

export async function buildEmailMap(
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;

  const admin = createAdminClient();
  const wanted = new Set(userIds);
  let page = 1;

  while (wanted.size > map.size) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error || !data.users.length) break;

    for (const user of data.users) {
      if (wanted.has(user.id)) {
        map.set(user.id, user.email ?? '');
      }
    }

    if (data.users.length < 200) break;
    page += 1;
    if (page > 50) break;
  }

  return map;
}
