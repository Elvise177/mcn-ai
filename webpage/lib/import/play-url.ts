/** 从 TikHub 响应中递归提取最小码率播放 URL */

export function looksLikeAweme(obj: unknown): obj is Record<string, unknown> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'aweme_id' in obj &&
    typeof (obj as Record<string, unknown>).video === 'object' &&
    (obj as Record<string, unknown>).video !== null
  );
}

export function findFirstAweme(response: unknown): Record<string, unknown> | null {
  if (looksLikeAweme(response)) return response;
  if (typeof response === 'object' && response !== null) {
    if (Array.isArray(response)) {
      for (const item of response) {
        const found = findFirstAweme(item);
        if (found) return found;
      }
    } else {
      for (const value of Object.values(response)) {
        const found = findFirstAweme(value);
        if (found) return found;
      }
    }
  }
  return null;
}

export function pickSmallestPlayUrl(video: Record<string, unknown>): string | null {
  const bitRates = (video.bit_rate as Record<string, unknown>[] | undefined) || [];
  const candidates: { size: number; url: string }[] = [];

  for (const br of bitRates) {
    const pa = (br.play_addr as Record<string, unknown> | undefined) || {};
    const urls = (pa.url_list as string[] | undefined) || [];
    const size = Number(pa.data_size ?? Number.POSITIVE_INFINITY);
    if (urls[0]) candidates.push({ size, url: urls[0] });
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.size - b.size);
    return candidates[0]!.url;
  }

  for (const key of ['play_addr', 'play_addr_h264'] as const) {
    const pa = (video[key] as { url_list?: string[] } | undefined) || {};
    if (pa.url_list?.[0]) return pa.url_list[0];
  }

  return null;
}

export function findPlayUrlFromResponse(response: unknown): string | null {
  const aweme = findFirstAweme(response);
  if (!aweme) return null;
  const video = (aweme.video as Record<string, unknown> | undefined) || {};
  return pickSmallestPlayUrl(video);
}
