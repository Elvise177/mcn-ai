-- 在 SQL Editor 运行：确认 organizations 是否存在 + 触发器里写的是什么

-- 1. 表是否在 public 下（应有 1 行）
select table_schema, table_name
from information_schema.tables
where table_name = 'organizations';

-- 2. 主组织数据
select * from public.organizations where slug = 'main';

-- 3. 当前 handle_new_user 函数源码（看是否写了 public.organizations）
select pg_get_functiondef(p.oid) as function_definition
from pg_proc p
join pg_namespace n on p.pronamespace = n.oid
where n.nspname = 'public'
  and p.proname = 'handle_new_user';

-- 4. auth.users 上的触发器
select t.tgname, pg_get_triggerdef(t.oid, true) as trigger_definition
from pg_trigger t
join pg_class c on t.tgrelid = c.oid
join pg_namespace ns on c.relnamespace = ns.oid
where ns.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal;
