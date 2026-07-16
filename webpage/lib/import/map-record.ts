import type { ParsedVideo } from '@/lib/import/parser';
import type { Tables } from '@/types/database';

export {
  flattenTranscriptFields,
  type ImportHistoryItem,
} from './transcript-types';

/** 将 imported_videos 表记录转为导入页展示用的 ParsedVideo */
export function importedVideoToParsed(row: Tables<'imported_videos'>): ParsedVideo {
  const hasProduct =
    row.is_shopping &&
    Boolean(row.product_title || row.product_category_l1);

  return {
    aweme_id: row.aweme_id,
    desc: row.video_desc?.trim() || '（无标题）',
    duration_seconds: row.duration_seconds ?? 0,
    cover_url: row.cover_url ?? '',
    play_url: '',
    create_time: row.create_time ?? 0,

    author: {
      nickname: row.author_nickname ?? '',
      sec_uid: row.author_sec_uid ?? '',
      signature: '',
      aweme_count: row.author_aweme_count ?? 0,
      total_favorited: Number(row.author_total_favorited ?? 0),
      is_verified: false,
    },

    stats: {
      like: row.like_count ?? 0,
      comment: row.comment_count ?? 0,
      share: row.share_count ?? 0,
      collect: row.collect_count ?? 0,
      collect_rate: Number(row.collect_rate ?? 0),
      share_rate: Number(row.share_rate ?? 0),
      comment_rate: 0,
    },

    category_tags: row.category_tags ?? [],
    is_beauty_content: row.is_beauty_content ?? false,
    hashtags: row.hashtags ?? [],

    is_shopping: row.is_shopping ?? false,
    product: hasProduct
      ? {
          product_id: '',
          promotion_id: '',
          title: row.product_title ?? '',
          elastic_title: '',
          image: row.product_image ?? '',
          category_l1: row.product_category_l1 ?? '',
          category_l2: row.product_category_l2 ?? '',
          category_l3: row.product_category_l3 ?? '',
          sales_total: row.product_sales_total ?? 0,
          review_count: row.product_review_count ?? 0,
          source: '',
        }
      : null,
  };
}
