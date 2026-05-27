import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env.local' });

import { createScriptAdminClient } from './lib/supabase-admin';

const VALID_ROLES = [
  'member',
  'org_editor',
  'org_admin',
  'super_admin',
] as const;

async function findUserByEmail(email: string) {
  const admin = createScriptAdminClient();
  const target = email.toLowerCase();
  let page = 1;

  while (page <= 50) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw error;
    if (!data.users.length) break;

    const user = data.users.find(
      (u) => u.email?.toLowerCase() === target,
    );
    if (user) return user;

    if (data.users.length < 200) break;
    page += 1;
  }

  return null;
}

async function main() {
  const [email, role = 'super_admin'] = process.argv.slice(2);

  if (!email) {
    console.log('Usage: npm run promote-user <email> [role]');
    console.log('Roles:', VALID_ROLES.join(', '));
    process.exit(1);
  }

  if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    console.error('Invalid role. Use one of:', VALID_ROLES.join(', '));
    process.exit(1);
  }

  const admin = createScriptAdminClient();
  const user = await findUserByEmail(email);

  if (!user) {
    console.error('User not found:', email);
    process.exit(1);
  }

  const { data: profile, error: profileError } = await admin
    .from('user_profiles')
    .select('id, role, name, organization_id')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    console.error(
      'Profile not found. Ask the user to log in once, or run bootstrap SQL.',
    );
    process.exit(1);
  }

  const patch: {
    role: string;
    updated_at: string;
    organization_id?: string;
  } = {
    role,
    updated_at: new Date().toISOString(),
  };

  if (!profile.organization_id) {
    const { data: mainOrg } = await admin
      .from('organizations')
      .select('id')
      .eq('slug', 'main')
      .single();
    if (mainOrg?.id) patch.organization_id = mainOrg.id;
  }

  const { error: updateError } = await admin
    .from('user_profiles')
    .update(patch)
    .eq('id', user.id);

  if (updateError) {
    console.error('Failed to update role:', updateError.message);
    process.exit(1);
  }

  console.log(
    `Updated ${email}: ${profile.role} → ${role}`,
    profile.name ? `(${profile.name})` : '',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
