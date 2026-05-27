-- 保留触发器 + 修复注册 500（按 Supabase 官方推荐）
-- SQL Editor 整段执行 → 删除失败用户 → 再注册

-- 1. 主组织（必须先建表！仅 INSERT 会报 relation "organizations" does not exist）
create table if not exists public.organizations (
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

-- 1b. user_profiles（若尚未建表，触发器也会失败）
create table if not exists public.user_profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  organization_id uuid references public.organizations(id),
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

-- 2. 触发器函数
-- 必须：security definer + owner postgres + 表名一律写 public.xxx
-- （否则会报 relation "organizations" does not exist，即使表已建）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  main_org_id uuid;
  assigned_role text;
begin
  select o.id into strict main_org_id
  from public.organizations as o
  where o.slug = 'main';

  if exists (
    select 1 from public.user_profiles as up where up.role = 'super_admin'
  ) then
    assigned_role := 'member';
  else
    assigned_role := 'super_admin';
  end if;

  insert into public.user_profiles (
    id,
    organization_id,
    name,
    avatar_url,
    role
  )
  values (
    new.id,
    main_org_id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'name'), ''),
      split_part(coalesce(new.email, ''), '@', 1),
      '用户'
    ),
    nullif(trim(new.raw_user_meta_data->>'avatar_url'), ''),
    assigned_role
  );

  return new;
end;
$$;

alter function public.handle_new_user() owner to postgres;

-- 3. 权限（auth 后台角色必须能写 user_profiles）
grant usage on schema public to postgres, supabase_auth_admin, service_role;

grant all on table public.user_profiles to postgres, service_role;
grant select, insert, update on table public.user_profiles to supabase_auth_admin;
grant select on table public.organizations to supabase_auth_admin, service_role;

revoke all on function public.handle_new_user() from public;
grant execute on function public.handle_new_user() to postgres, service_role, supabase_auth_admin;

-- 4. RLS：允许 supabase_auth_admin 插入（触发器双保险）
drop policy if exists "Allow auth admin insert on user_profiles" on public.user_profiles;

create policy "Allow auth admin insert on user_profiles"
  on public.user_profiles
  for insert
  to supabase_auth_admin
  with check (true);

-- 5. 绑定触发器（保留，不删除）
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- 6. 应用 bootstrap 备用策略
drop policy if exists "Users insert own profile" on public.user_profiles;

create policy "Users insert own profile"
  on public.user_profiles
  for insert
  to authenticated
  with check (auth.uid() = id);
