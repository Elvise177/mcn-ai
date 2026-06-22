import { config } from '@/config';

// 路由 maxDuration=30s，单次 12s + 一次重试必须在函数被杀前完成
const TIKHUB_TIMEOUT_MS = 12_000;

function formatTikhubFetchError(error: unknown): Error {
  if (error instanceof Error) {
    const cause = error.cause as { code?: string; message?: string } | undefined;
    if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new Error(
        '连接 TikHub 超时，请检查网络/代理或稍后重试（api.tikhub.io）',
      );
    }
    if (error.message === 'fetch failed' && cause?.message) {
      return new Error(`TikHub 网络异常：${cause.message}`);
    }
  }
  return error instanceof Error ? error : new Error('TikHub 请求失败');
}

export async function fetchVideoByShareUrl(shareText: string) {
  const url = `${config.tikhub.baseURL}/api/v1/douyin/app/v3/fetch_one_video_by_share_url?share_url=${encodeURIComponent(shareText)}`;

  const request = () =>
    fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.tikhub.apiKey}`,
      },
      signal: AbortSignal.timeout(TIKHUB_TIMEOUT_MS),
    });

  let res: Response;
  try {
    res = await request();
  } catch (first) {
    // 偶发超时再试一次
    try {
      res = await request();
    } catch (second) {
      throw formatTikhubFetchError(second);
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikHub请求失败 ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.code !== 200) {
    throw new Error(`TikHub返回异常: ${data.message || 'unknown error'}`);
  }

  return data;
}
