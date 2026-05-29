import {
  flattenTranscriptFields,
  type ImportHistoryItem,
} from './transcript-types';

function transcriptSection(video: ImportHistoryItem): string {
  const { transcript_status, transcript } = flattenTranscriptFields(video);
  if (transcript_status === 'done' && transcript?.trim()) {
    return `

【口播转写稿】
${transcript.trim()}`;
  }
  return '';
}

export function buildImportChatMessage(
  action: 'analyze' | 'script',
  video: ImportHistoryItem,
): { roleName: string; message: string } | null {
  const tags = (video.hashtags ?? []).map((h) => `#${h}`).join(' ');
  const categories = (video.category_tags ?? []).join(' / ');

  if (action === 'analyze') {
    return {
      roleName: '爆款视频拆解师',
      message: `请帮我拆解这条爆款带货视频：

【视频信息】
- 标题：${video.video_desc ?? '（无标题）'}
- 时长：${video.duration_seconds ?? 0}秒
- 达人：@${video.author_nickname ?? ''}（${video.author_aweme_count ?? 0}条作品，历史${video.author_total_favorited ?? 0}赞）
- 抖音官方分类：${categories || '无'}

【互动数据】
- 点赞：${video.like_count ?? 0}
- 评论：${video.comment_count ?? 0}
- 分享：${video.share_count ?? 0}（分享率 ${video.share_rate ?? 0}%）
- 收藏：${video.collect_count ?? 0}（收藏率 ${video.collect_rate ?? 0}%）

${
  video.is_shopping
    ? `【带货商品】
- 商品：${video.product_title ?? ''}
- 类目：${video.product_category_l1 ?? ''}/${video.product_category_l2 ?? ''}/${video.product_category_l3 ?? ''}
`
    : ''
}

【话题标签】${tags || '无'}${transcriptSection(video)}

请按你的6维度框架完整拆解这条视频。`,
    };
  }

  if (action === 'script') {
    return {
      roleName: '美妆口播脚本写手',
      message: `我看到一条爆款带货视频，想写一个同类脚本。

【参考视频】
- 标题：${video.video_desc ?? '（无标题）'}
- 时长：${video.duration_seconds ?? 0}秒
- 达人风格：@${video.author_nickname ?? ''}

${
  video.is_shopping
    ? `【带货商品类目】
- ${video.product_category_l1 ?? ''}/${video.product_category_l2 ?? ''}/${video.product_category_l3 ?? ''}
- 参考商品：${video.product_title ?? ''}
`
    : ''
}

【表现数据】点赞${video.like_count ?? 0}，收藏率${video.collect_rate ?? 0}%，分享率${video.share_rate ?? 0}%${transcriptSection(video)}

请按你的脚本框架，给我写一版同类带货脚本。若已提供口播转写稿，请参考其结构、节奏与卖点表达方式。`,
    };
  }

  return null;
}
