-- Auth Log 报错：relation "organizations" does not exist
-- 说明初始建表 SQL 未执行或未完成。请整段在 SQL Editor 执行。

-- ========== 若从零开始，先跑完整结构（推荐）==========
-- 也可打开并执行：supabase/migrations/001_initial_schema.sql
-- 然后再执行本文件末尾的「触发器修复」部分

-- ========== 最小修复：仅补 organizations（应急）==========
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

-- 验证（应返回 1 行）
select id, slug, name from public.organizations where slug = 'main';
