-- 修复注册报错：Database error saving new user
-- 在 Supabase SQL Editor 中执行（可重复执行）

-- 1. 确保主组织存在
insert into public.organizations (name, slug, plan_level)
values ('美妆带货AI操作台 - 主组织', 'main', 'internal')
on conflict (slug) do nothing;

-- 2. 重写触发器：显式写入 organization_id，首个用户为 super_admin
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  main_org_id uuid;
  assigned_role text;
begin
  select id into main_org_id
  from public.organizations
  where slug = 'main'
  limit 1;

  if main_org_id is null then
    raise exception 'main organization not found (slug=main)';
  end if;

  if exists (select 1 from public.user_profiles where role = 'super_admin') then
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
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url',
    assigned_role
  );

  return new;
end;
$$;

-- 3. 授权给 Auth 服务（关键：否则触发器插入会被 RLS/权限拦住）
grant usage on schema public to supabase_auth_admin;

grant insert, select, update on table public.user_profiles to supabase_auth_admin;
grant select on table public.organizations to supabase_auth_admin;

grant execute on function public.handle_new_user() to service_role;
grant execute on function public.handle_new_user() to supabase_auth_admin;

-- 4. 允许 auth admin 在 RLS 下插入 profile
drop policy if exists "Allow auth admin insert on user_profiles" on public.user_profiles;

create policy "Allow auth admin insert on user_profiles"
  on public.user_profiles
  for insert
  to supabase_auth_admin
  with check (true);
