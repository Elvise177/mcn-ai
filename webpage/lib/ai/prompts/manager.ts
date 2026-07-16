import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { Tables } from '@/types/database';

export class PromptManager {
  /** 获取角色当前激活的 prompt（服务端使用 admin 客户端，避免 RLS 边界问题） */
  static async getCurrentPrompt(roleId: string) {
    const supabase = createAdminClient();
    const { data: role } = await supabase
      .from('ai_roles')
      .select('current_prompt_version_id')
      .eq('id', roleId)
      .single<{ current_prompt_version_id: string | null }>();

    if (!role?.current_prompt_version_id) {
      throw new Error(`No active prompt for role ${roleId}`);
    }

    const { data: version } = await supabase
      .from('prompt_versions')
      .select('*')
      .eq('id', role.current_prompt_version_id)
      .single<Tables<'prompt_versions'>>();

    if (!version) throw new Error('Prompt version not found');

    return {
      promptId: version.id,
      versionNumber: version.version_number,
      systemPrompt: version.system_prompt,
    };
  }

  /** 创建新版本（不覆盖旧的） */
  static async createNewVersion(
    roleId: string,
    prompt: string,
    note: string,
    createdBy: string,
  ) {
    const supabase = createAdminClient();

    const { data: latest } = await supabase
      .from('prompt_versions')
      .select('version_number')
      .eq('role_id', roleId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle<{ version_number: number }>();

    const newVersionNumber = (latest?.version_number || 0) + 1;

    const { data: newVersion, error } = await supabase
      .from('prompt_versions')
      .insert({
        role_id: roleId,
        version_number: newVersionNumber,
        system_prompt: prompt,
        change_note: note,
        created_by: createdBy,
      })
      .select()
      .single<Tables<'prompt_versions'>>();

    if (error) throw error;

    await supabase
      .from('ai_roles')
      .update({ current_prompt_version_id: newVersion.id })
      .eq('id', roleId);

    return newVersion;
  }

  /** 回滚到某个版本 */
  static async rollbackToVersion(roleId: string, versionNumber: number) {
    const supabase = createAdminClient();
    const { data: version } = await supabase
      .from('prompt_versions')
      .select('id')
      .eq('role_id', roleId)
      .eq('version_number', versionNumber)
      .single<{ id: string }>();

    if (!version) throw new Error('Version not found');

    await supabase
      .from('ai_roles')
      .update({ current_prompt_version_id: version.id })
      .eq('id', roleId);
  }

  /** 列出某角色的所有版本 */
  static async listVersions(roleId: string) {
    const supabase = await createClient();
    const { data } = await supabase
      .from('prompt_versions')
      .select('*')
      .eq('role_id', roleId)
      .order('version_number', { ascending: false });

    return data || [];
  }
}
