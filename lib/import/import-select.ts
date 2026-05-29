/** 导入历史查询：关联最新口播稿 */
export const IMPORTED_VIDEO_WITH_TRANSCRIPT = `
  *,
  latest_transcript:video_transcripts!imported_videos_latest_transcript_id_fkey (
    id, transcript, status, error_message, play_url, provider, model, created_at, updated_at
  )
`;
