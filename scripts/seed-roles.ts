import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env.local' });

import { createScriptAdminClient } from './lib/supabase-admin';

const ROLES = [
  {
    name: '美妆口播脚本写手',
    description: '专业的60-90秒带货口播脚本生成',
    icon: '📝',
    category: 'script',
    temperature: 0.8,
    sort_order: 1,
    prompt: `你是OMG美妆MCN的资深口播脚本写手...（粘贴Word文档附录1的完整prompt）`,
  },
  {
    name: '爆款视频拆解师',
    description: '6维度拆解任何美妆爆款视频',
    icon: '🔍',
    category: 'analysis',
    temperature: 0.3,
    sort_order: 2,
    prompt: `你是OMG美妆MCN的资深视频拆解师...（粘贴Word文档附录2的完整prompt）`,
  },
  {
    name: '选品分析师',
    description: '8维度评估产品带货潜力',
    icon: '💎',
    category: 'analysis',
    temperature: 0.3,
    sort_order: 3,
    prompt: `你是OMG美妆MCN的选品分析师...（粘贴附录3）`,
  },
  {
    name: '评论区话术专家',
    description: '设计高转化评论区话术',
    icon: '💬',
    category: 'operation',
    temperature: 0.7,
    sort_order: 4,
    prompt: `你是OMG美妆MCN的评论区运营专家...（粘贴附录4）`,
  },
  {
    name: '标题钩子生成器',
    description: '一次产出10个不同钩子',
    icon: '🪝',
    category: 'script',
    temperature: 0.8,
    sort_order: 5,
    prompt: `你是OMG美妆MCN的钩子专家...（粘贴附录5）`,
  },
];

async function resolveOrganizationId(
  admin: ReturnType<typeof createScriptAdminClient>,
) {
  for (const slug of ['main', 'omg']) {
    const { data } = await admin
      .from('organizations')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (data) return data.id;
  }
  return null;
}

async function main() {
  const admin = createScriptAdminClient();

  const orgId = await resolveOrganizationId(admin);
  if (!orgId) {
    console.error(
      '未找到组织（organizations.slug = main 或 omg）。请先在 Supabase 执行 supabase/RUN_THIS_IN_SUPABASE.sql',
    );
    process.exit(1);
  }

  for (const roleData of ROLES) {
    const { data: existing } = await admin
      .from('ai_roles')
      .select('id')
      .eq('organization_id', orgId)
      .eq('name', roleData.name)
      .maybeSingle();

    if (existing) {
      console.log(`跳过（已存在）: ${roleData.icon} ${roleData.name}`);
      continue;
    }

    const { data: role, error: roleError } = await admin
      .from('ai_roles')
      .insert({
        organization_id: orgId,
        name: roleData.name,
        description: roleData.description,
        icon: roleData.icon,
        category: roleData.category,
        model: 'claude-sonnet-4-6',
        model_provider: 'aihubmix',
        temperature: roleData.temperature,
        sort_order: roleData.sort_order,
        is_active: true,
      })
      .select()
      .single();

    if (roleError) {
      console.error(`角色"${roleData.name}"创建失败:`, roleError.message);
      continue;
    }

    const { data: version, error: versionError } = await admin
      .from('prompt_versions')
      .insert({
        role_id: role.id,
        version_number: 1,
        system_prompt: roleData.prompt,
        change_note: 'V1.0初始版本',
      })
      .select()
      .single();

    if (versionError) {
      console.error('Prompt版本创建失败:', versionError.message);
      continue;
    }

    await admin
      .from('ai_roles')
      .update({ current_prompt_version_id: version.id })
      .eq('id', role.id);

    console.log(`✓ 已创建角色: ${roleData.icon} ${roleData.name}`);
  }

  console.log('\n所有角色已创建完成！');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
