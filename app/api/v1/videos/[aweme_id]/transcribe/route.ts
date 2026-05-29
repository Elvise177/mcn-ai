import { transcribeFromVideoUrl } from '@/lib/import/transcribe-assembly';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { TablesInsert } from '@/types/database';

export const maxDuration = 300;
export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: { aweme_id: string } },
) {
  if (!process.env.ASSEMBLYAI_API_KEY?.trim()) {
    return Response.json(
      { error: '未配置 ASSEMBLYAI_API_KEY，无法转写口播' },
      { status: 503 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminClient();
  const { data: row, error: fetchError } = await admin
    .from('imported_videos')
    .select('id, aweme_id, play_url, video_desc, product_title, latest_transcript_id')
    .eq('user_id', user.id)
    .eq('aweme_id', params.aweme_id)
    .maybeSingle<{
      id: string;
      aweme_id: string;
      play_url: string | null;
      video_desc: string | null;
      product_title: string | null;
      latest_transcript_id: string | null;
    }>();

  if (fetchError || !row) {
    return Response.json({ error: '导入记录不存在' }, { status: 404 });
  }

  if (!row.play_url?.trim()) {
    return Response.json(
      { error: '缺少视频播放地址，请重新解析该链接' },
      { status: 400 },
    );
  }

  if (row.latest_transcript_id) {
    const { data: existing } = await admin
      .from('video_transcripts')
      .select('id, transcript, status')
      .eq('id', row.latest_transcript_id)
      .maybeSingle();

    if (existing?.status === 'done' && existing.transcript) {
      return Response.json({
        success: true,
        transcript_id: existing.id,
        transcript: existing.transcript,
        cached: true,
      });
    }
  }

  const transcriptInsert: TablesInsert<'video_transcripts'> = {
    imported_video_id: row.id,
    user_id: user.id,
    aweme_id: params.aweme_id,
    status: 'processing',
    error_message: null,
    play_url: row.play_url,
    provider: 'assemblyai',
    model: 'universal-2',
    language: 'zh',
  };

  const { data: transcriptRow, error: upsertError } = await admin
    .from('video_transcripts')
    .upsert(transcriptInsert, { onConflict: 'imported_video_id' })
    .select('id')
    .single();

  if (upsertError || !transcriptRow) {
    return Response.json(
      { error: upsertError?.message ?? '创建转写记录失败' },
      { status: 500 },
    );
  }

  await admin
    .from('imported_videos')
    .update({ latest_transcript_id: transcriptRow.id })
    .eq('id', row.id);

  try {
    const { transcript } = await transcribeFromVideoUrl(row.play_url);

    const { error: updateError } = await admin
      .from('video_transcripts')
      .update({
        transcript,
        status: 'done',
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', transcriptRow.id);

    if (updateError) throw updateError;

    return Response.json({
      success: true,
      transcript_id: transcriptRow.id,
      transcript,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '转写失败';
    await admin
      .from('video_transcripts')
      .update({
        status: 'failed',
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', transcriptRow.id);

    console.error('[Transcribe/AssemblyAI]', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
