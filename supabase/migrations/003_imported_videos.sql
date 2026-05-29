-- 导入历史表（desc 为保留字，使用 video_desc）

create table if not exists public.imported_videos (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) not null,
  organization_id uuid references public.organizations(id),

  aweme_id text not null,
  video_desc text,
  duration_seconds int,
  cover_url text,
  play_url text,
  create_time bigint,

  author_nickname text,
  author_sec_uid text,
  author_aweme_count int,
  author_total_favorited bigint,

  like_count int,
  comment_count int,
  share_count int,
  collect_count int,
  collect_rate numeric(5, 2),
  share_rate numeric(5, 2),

  category_tags text[],
  is_beauty_content boolean default false,
  hashtags text[],

  is_shopping boolean default false,
  product_title text,
  product_image text,
  product_category_l1 text,
  product_category_l2 text,
  product_category_l3 text,
  product_sales_total int,
  product_review_count int,

  raw_data jsonb,

  created_at timestamptz default now(),
  unique (user_id, aweme_id)
);

create index if not exists idx_imported_videos_user
  on public.imported_videos (user_id, created_at desc);

create index if not exists idx_imported_videos_org
  on public.imported_videos (organization_id, created_at desc);

alter table public.imported_videos enable row level security;

drop policy if exists "user_view_own_imports" on public.imported_videos;
create policy "user_view_own_imports"
  on public.imported_videos for select
  using (auth.uid() = user_id);

drop policy if exists "user_insert_own_imports" on public.imported_videos;
create policy "user_insert_own_imports"
  on public.imported_videos for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_delete_own_imports" on public.imported_videos;
create policy "user_delete_own_imports"
  on public.imported_videos for delete
  using (auth.uid() = user_id);
