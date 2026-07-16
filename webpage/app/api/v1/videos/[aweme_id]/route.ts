import { IMPORTED_VIDEO_WITH_TRANSCRIPT } from '@/lib/import/import-select';
import { createClient } from '@/lib/supabase/server';

export async function GET(
  _req: Request,
  { params }: { params: { aweme_id: string } },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('imported_videos')
    .select(IMPORTED_VIDEO_WITH_TRANSCRIPT)
    .eq('user_id', user.id)
    .eq('aweme_id', params.aweme_id)
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  return Response.json(data);
}
