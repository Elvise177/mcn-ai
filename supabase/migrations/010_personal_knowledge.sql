-- 010: 私人数据库 —— 知识库加"个人"维度（三层 RAG：平台 / 组织 / 私人）
-- 在 Supabase SQL Editor 中执行（依赖 008_knowledge_vectors.sql）
-- 桌面版 MVP 与网页版私人数据库共用本迁移

-- ==========================================
-- 1. knowledge_chunks 加所有权与可见性
-- ==========================================
alter table public.knowledge_chunks
  add column if not exists owner_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists visibility text not null default 'org'
    check (visibility in ('platform', 'org', 'private'));

-- 扩展 source_type：个人层新增 我的脚本 / 我的复盘 / 风格档案
alter table public.knowledge_chunks
  drop constraint if exists knowledge_chunks_source_type_check;
alter table public.knowledge_chunks
  add constraint knowledge_chunks_source_type_check
    check (source_type in (
      'hot_script', 'viral_breakdown', 'transcript', 'editing_template',
      'my_script', 'my_review', 'style_profile'
    ));

-- private 数据必须有主人
alter table public.knowledge_chunks
  drop constraint if exists knowledge_chunks_private_owner_check;
alter table public.knowledge_chunks
  add constraint knowledge_chunks_private_owner_check
    check (visibility <> 'private' or owner_user_id is not null);

create index if not exists idx_knowledge_chunks_owner_type
  on public.knowledge_chunks (owner_user_id, source_type)
  where owner_user_id is not null;

-- ==========================================
-- 2. RLS：org/platform 沿用同组织可读；private 仅本人可读
-- ==========================================
drop policy if exists "knowledge_chunks_select_same_org" on public.knowledge_chunks;
create policy "knowledge_chunks_select_same_org"
  on public.knowledge_chunks for select
  to authenticated
  using (
    (
      visibility in ('org', 'platform')
      and organization_id = (
        select organization_id from public.user_profiles where id = auth.uid()
      )
    )
    or (visibility = 'private' and owner_user_id = auth.uid())
  );

-- ==========================================
-- 3. 检索 RPC：同名扩展（新增 p_user_id / p_layers，默认值保证旧调用不变）
--    p_layers 为 null 时行为与 008 完全一致（org 层）
--    传 p_layers = array['platform','org','private'] + p_user_id 即三层检索
--    注意：参数默认值变更需先 drop（Postgres 不允许 replace 改签名）
-- ==========================================
drop function if exists public.match_knowledge_chunks(vector(1536), uuid, text[], int);

create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  p_organization_id uuid,
  p_source_types text[],
  match_count int default 6,
  p_user_id uuid default null,
  p_layers text[] default null
)
returns table (
  id uuid,
  content text,
  source_type text,
  metadata jsonb,
  similarity float,
  visibility text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    kc.id,
    kc.content,
    kc.source_type,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) as similarity,
    kc.visibility
  from public.knowledge_chunks kc
  where kc.embedding is not null
    and (p_source_types is null or kc.source_type = any(p_source_types))
    and (
      case
        -- 兼容模式（p_layers 为 null）：与 008 行为一致，按组织过滤
        when p_layers is null
          then kc.organization_id = p_organization_id
        else (
             ('platform' = any(p_layers) and kc.visibility = 'platform')
          or ('org' = any(p_layers) and kc.visibility = 'org'
              and kc.organization_id = p_organization_id)
          or ('private' = any(p_layers) and kc.visibility = 'private'
              and p_user_id is not null and kc.owner_user_id = p_user_id)
        )
      end
    )
  order by
    (1 - (kc.embedding <=> query_embedding))
      * ln(coalesce((kc.metadata ->> 'like_count')::numeric, 0) + 10)
      -- 私人层轻度加权：用户自己的验证过的内容优先
      * (case when kc.visibility = 'private' then 1.2 else 1.0 end) desc
  limit match_count;
$$;
