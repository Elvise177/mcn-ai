-- 012: 修复检索排序——互动加权淹没语义相关性
--
-- 问题（M4 验收实测）：ln(like_count+10) 直接乘相关度，爆款转写（like≈9千）吃 ×9.15，
-- 用户自己 like=0 的笔记只有 ×2.3×1.2——即使语义相关度是别人的 2.5 倍（0.728 vs 0.293）
-- 也被挤到第 6 名。问库永远优先返回爆款转写 = 三层 RAG 的"个人层优先"卖点失效。
--
-- 修法：相关性主导，互动量改为有界小幅加成：
--   加成 = 1 + 0.03 × ln(like+10)   （like=0 → ×1.07；like=1万 → ×1.28，上限温和）
--   私人层 ×1.2 保持
-- 实测修正后：暗号笔记 0.728×1.07×1.2=0.93 排第一；爆款 0.293×1.28=0.37 次之 ✓

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
      * (1 + 0.03 * ln(coalesce((kc.metadata ->> 'like_count')::numeric, 0) + 10))
      * (case when kc.visibility = 'private' then 1.2 else 1.0 end) desc
  limit match_count;
$$;
