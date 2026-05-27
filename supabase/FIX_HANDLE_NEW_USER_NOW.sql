-- 根因：函数里写了 organizations / user_profiles（无 public. 前缀）
-- 且没有 set search_path = public → Auth 报 relation "organizations" does not exist
-- 在 SQL Editor 整段执行即可（保留触发器 on_auth_user_created）

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
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

alter function public.handle_new_user() owner to postgres;

grant usage on schema public to postgres, supabase_auth_admin, service_role;
grant all on table public.user_profiles to postgres, service_role;
grant select, insert, update on table public.user_profiles to supabase_auth_admin;
grant select on table public.organizations to supabase_auth_admin, service_role;

revoke all on function public.handle_new_user() from public;
grant execute on function public.handle_new_user() to postgres, service_role, supabase_auth_admin;

drop policy if exists "Allow auth admin insert on user_profiles" on public.user_profiles;

create policy "Allow auth admin insert on user_profiles"
  on public.user_profiles
  for insert
  to supabase_auth_admin
  with check (true);

-- 验证：下面应出现 public.organizations / public.user_profiles
select pg_get_functiondef(p.oid)
from pg_proc p
join pg_namespace n on p.pronamespace = n.oid
where n.nspname = 'public' and p.proname = 'handle_new_user';
