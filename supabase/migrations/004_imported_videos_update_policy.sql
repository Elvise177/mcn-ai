-- upsert 需要 UPDATE 策略
drop policy if exists "user_update_own_imports" on public.imported_videos;
create policy "user_update_own_imports"
  on public.imported_videos for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
