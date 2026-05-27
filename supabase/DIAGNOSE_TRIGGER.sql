-- 在 Supabase SQL Editor 运行，用于排查注册 500

-- 1. 查看 auth.users 上所有自定义触发器（应为 on_auth_user_created）
select
  t.tgname as trigger_name,
  p.proname as function_name,
  pg_get_userbyid(p.proowner) as function_owner
from pg_trigger t
join pg_class c on t.tgrelid = c.oid
join pg_namespace n on c.relnamespace = n.oid
join pg_proc p on t.tgfoid = p.oid
where n.nspname = 'auth'
  and c.relname = 'users'
  and not t.tgisinternal;

-- 2. 主组织是否存在
select id, slug from public.organizations where slug = 'main';

-- 3. 手动测试触发器逻辑（不创建真实用户，只测 INSERT 权限）
-- 若报错，把错误信息记下来
do $$
declare
  test_id uuid := gen_random_uuid();
  main_org_id uuid;
begin
  select id into main_org_id from public.organizations where slug = 'main' limit 1;
  raise notice 'main_org_id = %', main_org_id;

  insert into public.user_profiles (id, organization_id, name, role)
  values (test_id, main_org_id, 'diagnose-test', 'member');

  delete from public.user_profiles where id = test_id;
  raise notice 'INSERT test OK';
end $$;
