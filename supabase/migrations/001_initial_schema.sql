-- MCN AI — 初始数据库结构
-- 在 Supabase SQL Editor 中一次性执行（若表已存在请先 drop 或改用新 migration）

-- ==========================================
-- 1. 组织表
-- ==========================================
create table public.organizations (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  slug text unique not null,
  plan_level text default 'internal',
  settings jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

insert into public.organizations (name, slug, plan_level)
values ('美妆带货AI操作台 - 主组织', 'main', 'internal')
on conflict (slug) do nothing;

-- ==========================================
-- 1b. 辅助函数（必须在 organizations 有数据之后）
-- ==========================================
create or replace function public.get_main_organization_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select id from public.organizations where slug = 'main' limit 1;
$$;

-- ==========================================
-- 2. 用户扩展表
-- ==========================================
create table public.user_profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  organization_id uuid references public.organizations(id)
    default public.get_main_organization_id(),
  name text,
  avatar_url text,
  role text default 'member',
  plan_level text default 'internal',
  tags text[] default '{}',
  metadata jsonb default '{}',
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ==========================================
-- 3. AI角色表
-- ==========================================
create table public.ai_roles (
  id uuid default gen_random_uuid() primary key,
  organization_id uuid references public.organizations(id),
  name text not null,
  description text,
  icon text,
  category text default 'general',
  model text not null,
  model_provider text default 'aihubmix',
  temperature float default 0.7,
  max_tokens int default 4000,
  current_prompt_version_id uuid,
  knowledge_base_ids uuid[] default '{}',
  enable_rag boolean default false,
  enabled_tools text[] default '{}',
  required_plan text default 'internal',
  required_tags text[] default '{}',
  is_active boolean default true,
  sort_order int default 0,
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ==========================================
-- 4. Prompt版本表
-- ==========================================
create table public.prompt_versions (
  id uuid default gen_random_uuid() primary key,
  role_id uuid references public.ai_roles(id) on delete cascade,
  version_number int not null,
  system_prompt text not null,
  change_note text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  unique (role_id, version_number)
);

alter table public.ai_roles
  add constraint ai_roles_current_prompt_version_id_fkey
  foreign key (current_prompt_version_id)
  references public.prompt_versions(id);

-- ==========================================
-- 5. 会话表
-- ==========================================
create table public.conversations (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id),
  role_id uuid references public.ai_roles(id),
  prompt_version_id uuid references public.prompt_versions(id),
  title text default '新对话',
  folder_id uuid,
  tags text[] default '{}',
  is_pinned boolean default false,
  is_shared boolean default false,
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ==========================================
-- 6. 消息表
-- ==========================================
create table public.messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references public.conversations(id) on delete cascade,
  role text check (role in ('user', 'assistant', 'system', 'tool')) not null,
  content text not null,
  content_type text default 'text',
  attachments jsonb default '[]',
  tool_calls jsonb default '[]',
  tool_results jsonb default '[]',
  knowledge_refs jsonb default '[]',
  model_used text,
  prompt_tokens int default 0,
  completion_tokens int default 0,
  total_tokens int default 0,
  cost_usd numeric(10, 6) default 0,
  duration_ms int default 0,
  user_rating int,
  user_feedback text,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

-- ==========================================
-- 7-10. V2-V3 预留表
-- ==========================================
create table public.knowledge_bases (
  id uuid default gen_random_uuid() primary key,
  organization_id uuid references public.organizations(id),
  name text not null,
  description text,
  category text,
  is_active boolean default false,
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.knowledge_items (
  id uuid default gen_random_uuid() primary key,
  knowledge_base_id uuid references public.knowledge_bases(id) on delete cascade,
  title text,
  content text not null,
  source_url text,
  tags text[] default '{}',
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.external_api_calls (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id),
  service_name text not null,
  endpoint text,
  request_payload jsonb,
  response_payload jsonb,
  status text,
  cost_usd numeric(10, 6) default 0,
  created_at timestamptz default now()
);

create table public.scheduled_tasks (
  id uuid default gen_random_uuid() primary key,
  organization_id uuid references public.organizations(id),
  task_type text not null,
  schedule_cron text,
  config jsonb default '{}',
  last_run_at timestamptz,
  next_run_at timestamptz,
  is_active boolean default false,
  created_at timestamptz default now()
);

-- ==========================================
-- 11. 审计日志表
-- ==========================================
create table public.audit_logs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id),
  organization_id uuid references public.organizations(id),
  action text not null,
  resource_type text,
  resource_id uuid,
  details jsonb default '{}',
  ip_address text,
  user_agent text,
  created_at timestamptz default now()
);

-- ==========================================
-- 12. 使用统计表（按天聚合）
-- ==========================================
create table public.usage_stats_daily (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id),
  organization_id uuid references public.organizations(id),
  date date not null,
  message_count int default 0,
  conversation_count int default 0,
  total_tokens int default 0,
  total_cost_usd numeric(10, 6) default 0,
  models_used jsonb default '{}',
  roles_used jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, date)
);

-- ==========================================
-- 13. 注册时自动创建 user_profiles（推荐）
-- ==========================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ==========================================
-- 14. 启用 RLS
-- ==========================================
alter table public.organizations enable row level security;
alter table public.user_profiles enable row level security;
alter table public.ai_roles enable row level security;
alter table public.prompt_versions enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.knowledge_bases enable row level security;
alter table public.knowledge_items enable row level security;
alter table public.external_api_calls enable row level security;
alter table public.scheduled_tasks enable row level security;
alter table public.audit_logs enable row level security;
alter table public.usage_stats_daily enable row level security;

-- ==========================================
-- 15. RLS 策略
-- ==========================================
create or replace function public.current_user_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.user_profiles where id = auth.uid();
$$;

-- organizations：同组织可读
create policy "org_select_same_org"
  on public.organizations for select
  to authenticated
  using (id = public.current_user_organization_id());

-- user_profiles：仅本人
create policy "profiles_select_own"
  on public.user_profiles for select
  to authenticated
  using (id = auth.uid());

create policy "profiles_update_own"
  on public.user_profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ai_roles：同组织可读
create policy "ai_roles_select_same_org"
  on public.ai_roles for select
  to authenticated
  using (organization_id = public.current_user_organization_id());

-- prompt_versions：通过 role 归属组织
create policy "prompt_versions_select_same_org"
  on public.prompt_versions for select
  to authenticated
  using (
    exists (
      select 1 from public.ai_roles r
      where r.id = prompt_versions.role_id
        and r.organization_id = public.current_user_organization_id()
    )
  );

-- conversations：仅本人
create policy "conversations_select_own"
  on public.conversations for select
  to authenticated
  using (user_id = auth.uid());

create policy "conversations_insert_own"
  on public.conversations for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "conversations_update_own"
  on public.conversations for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "conversations_delete_own"
  on public.conversations for delete
  to authenticated
  using (user_id = auth.uid());

-- messages：仅本人会话
create policy "messages_select_own"
  on public.messages for select
  to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "messages_insert_own"
  on public.messages for insert
  to authenticated
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "messages_update_own"
  on public.messages for update
  to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

create policy "messages_delete_own"
  on public.messages for delete
  to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- knowledge_bases：同组织可读
create policy "knowledge_bases_select_same_org"
  on public.knowledge_bases for select
  to authenticated
  using (organization_id = public.current_user_organization_id());

-- knowledge_items：通过 knowledge_base 归属
create policy "knowledge_items_select_same_org"
  on public.knowledge_items for select
  to authenticated
  using (
    exists (
      select 1 from public.knowledge_bases kb
      where kb.id = knowledge_items.knowledge_base_id
        and kb.organization_id = public.current_user_organization_id()
    )
  );

-- external_api_calls：仅本人
create policy "external_api_calls_select_own"
  on public.external_api_calls for select
  to authenticated
  using (user_id = auth.uid());

create policy "external_api_calls_insert_own"
  on public.external_api_calls for insert
  to authenticated
  with check (user_id = auth.uid());

-- scheduled_tasks：同组织可读
create policy "scheduled_tasks_select_same_org"
  on public.scheduled_tasks for select
  to authenticated
  using (organization_id = public.current_user_organization_id());

-- audit_logs：仅本人可读；可插入自己的日志
create policy "audit_logs_select_own"
  on public.audit_logs for select
  to authenticated
  using (user_id = auth.uid());

create policy "audit_logs_insert_own"
  on public.audit_logs for insert
  to authenticated
  with check (user_id = auth.uid());

-- usage_stats_daily：仅本人
create policy "usage_stats_select_own"
  on public.usage_stats_daily for select
  to authenticated
  using (user_id = auth.uid());

create policy "usage_stats_insert_own"
  on public.usage_stats_daily for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "usage_stats_update_own"
  on public.usage_stats_daily for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
