import { requireUserProfile } from '@/lib/auth/server-profile';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type CreateJobBody = {
  awemeId?: string;
  instruction?: string;
  templateId?: string;
};

/** 创建剪辑任务（需要该视频已完成口播转写），由国内 worker 轮询执行 */
export async function POST(req: Request) {
  const auth = await requireUserProfile();
  if ('error' in auth) return auth.error;
  const { user, profile } = auth;

  let body: CreateJobBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.awemeId) {
    return Response.json({ error: '缺少 awemeId' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: video } = await admin
    .from('imported_videos')
    .select('id, latest_transcript_id, play_url')
    .eq('user_id', user.id)
    .eq('aweme_id', body.awemeId)
    .maybeSingle<{
      id: string;
      latest_transcript_id: string | null;
      play_url: string | null;
    }>();

  if (!video) {
    return Response.json({ error: '视频不存在，请先导入' }, { status: 404 });
  }
  if (!video.latest_transcript_id) {
    return Response.json(
      { error: '请先完成口播转写，再创建剪辑任务' },
      { status: 400 },
    );
  }

  // 同一视频存在进行中的任务则不重复创建
  const { data: existing } = await admin
    .from('edit_jobs')
    .select('id, status')
    .eq('user_id', user.id)
    .eq('imported_video_id', video.id)
    .in('status', ['pending', 'claimed', 'analyzing', 'drafting'])
    .maybeSingle();

  if (existing) {
    return Response.json({ success: true, job: existing, existed: true });
  }

  const { data: job, error } = await admin
    .from('edit_jobs')
    .insert({
      user_id: user.id,
      organization_id: profile.organization_id,
      imported_video_id: video.id,
      transcript_id: video.latest_transcript_id,
      template_id: body.templateId ?? null,
      instruction: body.instruction?.trim() || null,
      status: 'pending',
    })
    .select()
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ success: true, job });
}

/** 查询自己的剪辑任务列表 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const limit = Math.min(
    50,
    Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20),
  );

  const { data, error } = await supabase
    .from('edit_jobs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data ?? []);
}
