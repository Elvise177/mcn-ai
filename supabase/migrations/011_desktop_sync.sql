-- 011: 桌面端本地 markdown 库同步支持
-- 现有去重只认 metadata.aweme_id（抖音视频语义），本地文件需要 路径+内容哈希 的更新语义：
-- 同 owner + file_path 先删后插（文件改动即全量重灌该文件切片，600 字切片成本可忽略）

alter table knowledge_chunks add column if not exists file_path text;
alter table knowledge_chunks add column if not exists content_hash text;

create index if not exists idx_knowledge_chunks_owner_file
  on knowledge_chunks (owner_user_id, file_path)
  where file_path is not null;
