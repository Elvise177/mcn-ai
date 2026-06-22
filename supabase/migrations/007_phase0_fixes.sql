-- Phase 0 止血修复：索引、RLS 收紧、原子用量统计
-- 在 Supabase SQL Editor 中执行

-- ==========================================
-- 1. 核心表索引（001 中遗漏）
-- ==========================================
create index if not exists idx_messages_conversation
  on public.messages (conversation_id, created_at);

create index if not exists idx_conversations_user
  on public.conversations (user_id, updated_at desc);

create index if not exists idx_audit_logs_user
  on public.audit_logs (user_id, created_at desc);

create index if not exists idx_audit_logs_org
  on public.audit_logs (organization_id, created_at desc);

create index if not exists idx_usage_stats_org_date
  on public.usage_stats_daily (organization_id, date desc);

create index if not exists idx_prompt_versions_role
  on public.prompt_versions (role_id, version_number desc);

-- ==========================================
-- 2. 收紧 messages RLS
-- 消息写入全部经服务端 service role，客户端不允许直接
-- insert/update（防止伪造 assistant 消息和成本统计字段）
-- ==========================================
drop policy if exists "messages_insert_own" on public.messages;
drop policy if exists "messages_update_own" on public.messages;

-- ==========================================
-- 3. 原子用量统计（替代读-改-写，消除并发竞态）
-- ==========================================
create or replace function public.increment_usage_stats(
  p_user_id uuid,
  p_organization_id uuid,
  p_date date,
  p_tokens int,
  p_cost numeric,
  p_model text,
  p_role_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.usage_stats_daily (
    user_id, organization_id, date,
    message_count, total_tokens, total_cost_usd,
    models_used, roles_used
  )
  values (
    p_user_id, p_organization_id, p_date,
    1, p_tokens, p_cost,
    jsonb_build_object(p_model, 1),
    case when p_role_id is null or p_role_id = ''
      then '{}'::jsonb
      else jsonb_build_object(p_role_id, 1) end
  )
  on conflict (user_id, date) do update set
    message_count = usage_stats_daily.message_count + 1,
    total_tokens = usage_stats_daily.total_tokens + p_tokens,
    total_cost_usd = usage_stats_daily.total_cost_usd + p_cost,
    models_used = usage_stats_daily.models_used
      || jsonb_build_object(
        p_model,
        coalesce((usage_stats_daily.models_used ->> p_model)::int, 0) + 1
      ),
    roles_used = case when p_role_id is null or p_role_id = ''
      then usage_stats_daily.roles_used
      else usage_stats_daily.roles_used
        || jsonb_build_object(
          p_role_id,
          coalesce((usage_stats_daily.roles_used ->> p_role_id)::int, 0) + 1
        ) end,
    updated_at = now();
end;
$$;
