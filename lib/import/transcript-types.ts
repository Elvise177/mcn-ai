import type { Tables } from '@/types/database';

export type VideoTranscript = Tables<'video_transcripts'>;

/** 导入历史行 + 关联的最新口播稿 */
export type ImportHistoryItem = Tables<'imported_videos'> & {
  latest_transcript?: VideoTranscript | VideoTranscript[] | null;
};

export type TranscriptView = {
  transcript_id: string | null;
  transcript: string | null;
  transcript_status: string;
  transcript_error: string | null;
};

export function flattenTranscriptFields(row: ImportHistoryItem): TranscriptView {
  const raw = row.latest_transcript;
  const t = Array.isArray(raw) ? raw[0] : raw;

  return {
    transcript_id: t?.id ?? null,
    transcript: t?.transcript ?? null,
    transcript_status: t?.status ?? 'none',
    transcript_error: t?.error_message ?? null,
  };
}
