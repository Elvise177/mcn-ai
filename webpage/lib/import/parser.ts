export interface ParsedVideo {
  aweme_id: string;
  desc: string;
  duration_seconds: number;
  cover_url: string;
  play_url: string;
  create_time: number;

  author: {
    nickname: string;
    sec_uid: string;
    signature: string;
    aweme_count: number;
    total_favorited: number;
    is_verified: boolean;
  };

  stats: {
    like: number;
    comment: number;
    share: number;
    collect: number;
    collect_rate: number;
    share_rate: number;
    comment_rate: number;
  };

  category_tags: string[];
  is_beauty_content: boolean;
  hashtags: string[];

  is_shopping: boolean;
  product: {
    product_id: string;
    promotion_id: string;
    title: string;
    elastic_title: string;
    image: string;
    category_l1: string;
    category_l2: string;
    category_l3: string;
    sales_total: number;
    review_count: number;
    source: string;
  } | null;
}

import { pickSmallestPlayUrl } from './play-url';

const BEAUTY_KEYWORDS = [
  '美妆',
  '彩妆',
  '护肤',
  '眼妆',
  '底妆',
  '唇部',
  '香水',
  '美甲',
  '美容',
];

export function parseVideoFromTikhub(response: {
  data?: { aweme_detail?: Record<string, unknown> };
}): ParsedVideo {
  const ad = response?.data?.aweme_detail;
  if (!ad) throw new Error('TikHub返回数据格式异常：找不到 aweme_detail');

  const aweme_id = String(ad.aweme_id ?? '');
  const desc = String(ad.desc || '（无标题）');

  const like = Number(
    (ad.statistics as Record<string, number> | undefined)?.digg_count || 0,
  );
  const comment = Number(
    (ad.statistics as Record<string, number> | undefined)?.comment_count || 0,
  );
  const share = Number(
    (ad.statistics as Record<string, number> | undefined)?.share_count || 0,
  );
  const collect = Number(
    (ad.statistics as Record<string, number> | undefined)?.collect_count || 0,
  );
  const rate = (n: number) =>
    like > 0 ? Math.round((n / like) * 1000) / 10 : 0;

  const category_tags: string[] = (
    (ad.video_tag as { tag_name?: string }[] | undefined) || []
  )
    .map((t) => t.tag_name)
    .filter((name): name is string => Boolean(name));

  const is_beauty_content = category_tags.some((tag) =>
    BEAUTY_KEYWORDS.some((kw) => tag.includes(kw)),
  );

  let product: ParsedVideo['product'] = null;
  const status = ad.status as { with_goods?: boolean } | undefined;
  const is_shopping = status?.with_goods === true;

  if (is_shopping && (ad.anchor_info as { extra?: unknown } | undefined)?.extra) {
    try {
      const extraStr = (ad.anchor_info as { extra: unknown }).extra;
      const extra =
        typeof extraStr === 'string' ? JSON.parse(extraStr) : extraStr;
      const p = (Array.isArray(extra) ? extra[0] : extra) as Record<
        string,
        unknown
      > | null;

      if (p) {
        const category = p.category as Record<string, string> | undefined;
        const elasticImages = p.elastic_images as
          | { url_list?: string[] }[]
          | undefined;
        product = {
          product_id: String(p.product_id || ''),
          promotion_id: String(p.promotion_id || ''),
          title: String(p.title || ''),
          elastic_title: String(p.elastic_title || ''),
          image: elasticImages?.[0]?.url_list?.[0] || '',
          category_l1: category?.FirstCName || '',
          category_l2: category?.SecondCName || '',
          category_l3: category?.ThirdCName || '',
          sales_total: Number(p.sales || 0),
          review_count: Number(p.comment_count || 0),
          source: String(p.goods_source || ''),
        };
      }
    } catch (e) {
      console.error('[Parser] 解析商品信息失败', e);
    }
  }

  const author = ad.author as Record<string, unknown> | undefined;
  const video = ad.video as Record<string, unknown> | undefined;
  const cover = video?.cover as { url_list?: string[] } | undefined;
  return {
    aweme_id,
    desc,
    duration_seconds: Math.round(Number(ad.duration || 0) / 1000),
    cover_url: cover?.url_list?.[0] || '',
    play_url: pickSmallestPlayUrl(video || {}) || '',
    create_time: Number(ad.create_time || 0),

    author: {
      nickname: String(author?.nickname || ''),
      sec_uid: String(author?.sec_uid || ''),
      signature: String(author?.signature || ''),
      aweme_count: Number(author?.aweme_count || 0),
      total_favorited: Number(author?.total_favorited || 0),
      is_verified: author?.is_verified === true,
    },

    stats: {
      like,
      comment,
      share,
      collect,
      collect_rate: rate(collect),
      share_rate: rate(share),
      comment_rate: rate(comment),
    },

    category_tags,
    is_beauty_content,
    hashtags: (
      (ad.text_extra as { hashtag_name?: string }[] | undefined) || []
    )
      .map((t) => t.hashtag_name)
      .filter((name): name is string => Boolean(name)),

    is_shopping,
    product,
  };
}
