import { IMPORTED_VIDEO_WITH_TRANSCRIPT } from '@/lib/import/import-select';
import { parseVideoFromTikhub } from '@/lib/import/parser';
import { fetchVideoByShareUrl } from '@/lib/tikhub/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { Json, TablesInsert } from '@/types/database';

export const maxDuration = 30;
export const runtime = 'nodejs';

const HISTORY_SELECT = IMPORTED_VIDEO_WITH_TRANSCRIPT;

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(
    50,
    Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10) || 30),
  );

  const { data, error } = await supabase
    .from('imported_videos')
    .select(HISTORY_SELECT)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data ?? []);
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let share_url: string;
  try {
    const body = await req.json();
    share_url = body.share_url;
  } catch {
    return Response.json({ error: '请求体格式错误' }, { status: 400 });
  }

  if (!share_url || typeof share_url !== 'string') {
    return Response.json({ error: '请提供有效的分享链接' }, { status: 400 });
  }

  try {
    const apiResult = await fetchVideoByShareUrl(share_url.trim());
    const parsed = parseVideoFromTikhub(apiResult);

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('organization_id')
      .eq('id', user.id)
      .maybeSingle<{ organization_id: string | null }>();

    const record: TablesInsert<'imported_videos'> = {
      user_id: user.id,
      organization_id: profile?.organization_id ?? null,
      aweme_id: parsed.aweme_id,
      video_desc: parsed.desc,
      duration_seconds: parsed.duration_seconds,
      cover_url: parsed.cover_url,
      play_url: parsed.play_url || null,
      create_time: parsed.create_time,
      author_nickname: parsed.author.nickname,
      author_sec_uid: parsed.author.sec_uid,
      author_aweme_count: parsed.author.aweme_count,
      author_total_favorited: parsed.author.total_favorited,
      like_count: parsed.stats.like,
      comment_count: parsed.stats.comment,
      share_count: parsed.stats.share,
      collect_count: parsed.stats.collect,
      collect_rate: parsed.stats.collect_rate,
      share_rate: parsed.stats.share_rate,
      category_tags: parsed.category_tags,
      is_beauty_content: parsed.is_beauty_content,
      hashtags: parsed.hashtags,
      is_shopping: parsed.is_shopping,
      product_title: parsed.product?.title ?? null,
      product_image: parsed.product?.image ?? null,
      product_category_l1: parsed.product?.category_l1 ?? null,
      product_category_l2: parsed.product?.category_l2 ?? null,
      product_category_l3: parsed.product?.category_l3 ?? null,
      product_sales_total: parsed.product?.sales_total ?? null,
      product_review_count: parsed.product?.review_count ?? null,
      raw_data: (apiResult.data ?? apiResult) as Json,
    };

    const admin = createAdminClient();
    const { data: upserted, error } = await admin
      .from('imported_videos')
      .upsert([record], { onConflict: 'user_id,aweme_id' })
      .select('id')
      .single();

    if (error || !upserted) {
      console.error('[Import] 入库失败', error);
      return Response.json(
        { error: '保存失败：' + (error?.message ?? '未知错误') },
        { status: 500 },
      );
    }

    const { data: imported, error: loadError } = await admin
      .from('imported_videos')
      .select(HISTORY_SELECT)
      .eq('id', upserted.id)
      .single();

    if (loadError || !imported) {
      return Response.json(
        { error: '保存成功但读取失败：' + (loadError?.message ?? '') },
        { status: 500 },
      );
    }

    return Response.json({ success: true, video: imported, parsed });
  } catch (error: unknown) {
    console.error('[Import] 视频解析失败', error);
    const message =
      error instanceof Error && error.message
        ? error.message
        : '解析失败，请稍后重试';
    const status = message.includes('超时') || message.includes('网络') ? 504 : 500;
    return Response.json({ error: message }, { status });
  }
}
