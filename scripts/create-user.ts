import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env.local' });

import { createScriptAdminClient } from './lib/supabase-admin';

async function main() {
  const [email, password, role = 'member'] = process.argv.slice(2);
  if (!email || !password) {
    console.log('Usage: npm run create-user <email> <password> [role]');
    process.exit(1);
  }

  const admin = createScriptAdminClient();

  const { data: mainOrg, error: orgError } = await admin
    .from('organizations')
    .select('id')
    .eq('slug', 'main')
    .single();

  if (orgError || !mainOrg) {
    console.error('Main organization not found (slug=main)');
    process.exit(1);
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    console.error('Failed:', error?.message ?? 'Unknown error');
    process.exit(1);
  }

  const { error: profileError } = await admin.from('user_profiles').upsert(
    {
      id: data.user.id,
      organization_id: mainOrg.id,
      name: email.split('@')[0],
      role,
      is_active: true,
    },
    { onConflict: 'id' },
  );

  if (profileError) {
    await admin.auth.admin.deleteUser(data.user.id);
    console.error('Failed to create profile:', profileError.message);
    process.exit(1);
  }

  console.log('Created user:', email, 'with role:', role);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
