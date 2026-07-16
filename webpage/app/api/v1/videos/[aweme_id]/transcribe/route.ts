import { transcribeFromVideoUrl } from '@/lib/import/transcribe-assembly';
import { ingestKnowledge } from '@/lib/knowledge';
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
    .select(
      'id, aweme_id, play_url, video_desc, product_title, latest_transcript_id, organization_id, author_nickname, like_count, collect_rate, product_category_l2',
    )
    .eq('user_id', user.id)
    .eq('aweme_id', params.aweme_id)
    .maybeSingle<{
      id: string;
      aweme_id: string;
      play_url: string | null;
      video_desc: string | null;
      product_title: string | null;
      latest_transcript_id: string | null;
      organization_id: string | null;
      author_nickname: string | null;
      like_count: number | null;
      collect_rate: number | null;
      product_category_l2: string | null;
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

    // 转写成功后自动入向量知识库（失败不影响转写结果）
    if (row.organization_id) {
      try {
        await ingestKnowledge({
          organizationId: row.organization_id,
          sourceType: 'transcript',
          content: transcript,
          metadata: {
            aweme_id: row.aweme_id,
            video_desc: row.video_desc,
            product_title: row.product_title,
            author_nickname: row.author_nickname,
            like_count: row.like_count,
            collect_rate: row.collect_rate,
            product_category_l2: row.product_category_l2,
          },
        });
      } catch (ingestError) {
        console.error('[Transcribe] 向量入库失败:', ingestError);
      }
    }

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
