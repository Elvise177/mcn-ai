-- 若表是早期 003 创建的，可能缺少 play_url（解析时会写入 CDN 播放地址）

alter table public.imported_videos
  add column if not exists play_url text;

comment on column public.imported_videos.play_url is 'TikHub 解析得到的最小码率 MP4 地址（可选，供后续下载/转写）';
