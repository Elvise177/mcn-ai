-- 口播转写（AssemblyAI），与 imported_videos 一对一

create table if not exists public.video_transcripts (
  id uuid default gen_random_uuid() primary key,
  imported_video_id uuid not null references public.imported_videos(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  aweme_id text not null,
  transcript text,
  status text not null default 'none',
  error_message text,
  play_url text,
  provider text default 'assemblyai',
  model text,
  language text default 'zh',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (imported_video_id)
);

create index if not exists idx_video_transcripts_user
  on public.video_transcripts (user_id, created_at desc);

create index if not exists idx_video_transcripts_aweme
  on public.video_transcripts (user_id, aweme_id);

alter table public.imported_videos
  add column if not exists latest_transcript_id uuid references public.video_transcripts(id) on delete set null;

alter table public.video_transcripts enable row level security;

drop policy if exists "video_transcripts_select_own" on public.video_transcripts;
create policy "video_transcripts_select_own"
  on public.video_transcripts for select
  using (auth.uid() = user_id);

drop policy if exists "video_transcripts_insert_own" on public.video_transcripts;
create policy "video_transcripts_insert_own"
  on public.video_transcripts for insert
  with check (auth.uid() = user_id);

drop policy if exists "video_transcripts_update_own" on public.video_transcripts;
create policy "video_transcripts_update_own"
  on public.video_transcripts for update
  using (auth.uid() = user_id);

drop policy if exists "video_transcripts_delete_own" on public.video_transcripts;
create policy "video_transcripts_delete_own"
  on public.video_transcripts for delete
  using (auth.uid() = user_id);
