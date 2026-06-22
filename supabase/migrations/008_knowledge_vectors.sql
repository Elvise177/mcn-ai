-- Phase 2: pgvector 知识库（热门脚本 / 爆款拆解 / 口播转写 / 剪辑模板）
-- 在 Supabase SQL Editor 中执行

create extension if not exists vector;

-- ==========================================
-- 1. 知识切片表（embedding: text-embedding-3-small, 1536 维）
-- ==========================================
create table if not exists public.knowledge_chunks (
  id uuid default gen_random_uuid() primary key,
  knowledge_item_id uuid references public.knowledge_items(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  source_type text not null
    check (source_type in ('hot_script', 'viral_breakdown', 'transcript', 'editing_template')),
  content text not null,
  embedding vector(1536),
  -- 类目、aweme_id、点赞/收藏率、模板 id 等
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create index if not exists idx_knowledge_chunks_embedding
  on public.knowledge_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists idx_knowledge_chunks_org_type
  on public.knowledge_chunks (organization_id, source_type);

alter table public.knowledge_chunks enable row level security;

-- 写入仅经服务端 service role；同组织可读
-- 内联组织归属查询，不依赖 current_user_organization_id() 辅助函数
-- （精简版建库脚本未创建该函数）
drop policy if exists "knowledge_chunks_select_same_org" on public.knowledge_chunks;
create policy "knowledge_chunks_select_same_org"
  on public.knowledge_chunks for select
  to authenticated
  using (
    organization_id = (
      select organization_id from public.user_profiles where id = auth.uid()
    )
  );

-- ==========================================
-- 2. 相似度检索 RPC
-- 排序：余弦相似度 × 互动加权（log(点赞+10)，让"既相关又爆"的内容靠前）
-- ==========================================
create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  p_organization_id uuid,
  p_source_types text[],
  match_count int default 6
)
returns table (
  id uuid,
  content text,
  source_type text,
  metadata jsonb,
  similarity float
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
    1 - (kc.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks kc
  where kc.organization_id = p_organization_id
    and kc.embedding is not null
    and (p_source_types is null or kc.source_type = any(p_source_types))
  order by
    (1 - (kc.embedding <=> query_embedding))
      * ln(coalesce((kc.metadata ->> 'like_count')::numeric, 0) + 10) desc
  limit match_count;
$$;
