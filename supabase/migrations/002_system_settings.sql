-- 系统配置表（管理员后台写入，实时生效）
create table if not exists public.system_settings (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id)
);

alter table public.system_settings enable row level security;

-- 普通用户不可读写，仅 service role（admin API）访问
create policy "system_settings_no_public"
  on public.system_settings
  for all
  to authenticated
  using (false)
  with check (false);
