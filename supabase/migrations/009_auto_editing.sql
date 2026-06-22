-- Phase 3: 自动剪辑（剪映草稿路线）
-- editing_templates：剪辑模板；edit_jobs：剪辑任务队列（国内服务器 worker 轮询认领）

-- ==========================================
-- 1. 剪辑模板表
-- 模板描述会同步 embedding 进 knowledge_chunks（source_type='editing_template'），
-- 剪辑前向量检索最匹配的模板
-- ==========================================
create table if not exists public.editing_templates (
  id uuid default gen_random_uuid() primary key,
  organization_id uuid references public.organizations(id),
  name text not null,
  description text,
  category text,
  -- 结构化模板：节奏型、字幕样式、转场规则、BGM 偏好等，worker 解释执行
  template jsonb default '{}',
  is_active boolean default true,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_editing_templates_org
  on public.editing_templates (organization_id, is_active);

alter table public.editing_templates enable row level security;

drop policy if exists "editing_templates_select_same_org" on public.editing_templates;
create policy "editing_templates_select_same_org"
  on public.editing_templates for select
  to authenticated
  using (
    organization_id = (
      select organization_id from public.user_profiles where id = auth.uid()
    )
  );

-- ==========================================
-- 2. 剪辑任务表（状态机：pending → claimed → analyzing → drafting → done/failed）
-- ==========================================
create table if not exists public.edit_jobs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id),
  imported_video_id uuid references public.imported_videos(id) on delete set null,
  transcript_id uuid references public.video_transcripts(id) on delete set null,
  template_id uuid references public.editing_templates(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'analyzing', 'drafting', 'done', 'failed')),
  -- 用户的剪辑要求（自然语言）
  instruction text,
  -- LLM 产出的剪辑决策 JSON（cut list / 字幕 / 节奏标注）
  cut_plan jsonb,
  -- 产物：剪映草稿下载地址或 worker 上的存放路径
  draft_url text,
  error_message text,
  worker_id text,
  claimed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_edit_jobs_user
  on public.edit_jobs (user_id, created_at desc);

create index if not exists idx_edit_jobs_pending
  on public.edit_jobs (status, created_at)
  where status = 'pending';

alter table public.edit_jobs enable row level security;

drop policy if exists "edit_jobs_select_own" on public.edit_jobs;
create policy "edit_jobs_select_own"
  on public.edit_jobs for select
  to authenticated
  using (user_id = auth.uid());

-- 创建经服务端 API；worker 用 service role 读写，无需额外策略

-- ==========================================
-- 3. worker 原子认领任务（SKIP LOCKED 防止多 worker 抢同一任务）
-- ==========================================
create or replace function public.claim_next_edit_job(p_worker_id text)
returns setof public.edit_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  select id into v_job_id
  from public.edit_jobs
  where status = 'pending'
  order by created_at
  limit 1
  for update skip locked;

  if v_job_id is null then
    return;
  end if;

  return query
  update public.edit_jobs
  set status = 'claimed',
      worker_id = p_worker_id,
      claimed_at = now(),
      updated_at = now()
  where id = v_job_id
  returning *;
end;
$$;
