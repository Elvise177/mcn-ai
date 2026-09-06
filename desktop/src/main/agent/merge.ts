/**
 * `search_knowledge` 的双通道合并（检索优化第三单，2026-09-05）——**纯函数**，产品与 bench 执行端共用。
 *
 * 为什么单独抽出来：bench 的「摆到模型面前」口径靠**重放**检索词拿命中路径，第三单之前它只重放关键词通道，
 * 语义通道摆出来的条目就不算数——语义题救回来的文件在数字上会被记成"没命中"，尺子在最需要它的地方失真
 * （2026-09-06 两轮 bench 跑完才发现）。两侧各写一份合并逻辑迟早对不上，所以这里只留一份。
 *
 * 两种方式（由 store.semanticMerge 选）：
 *  - channel：关键词前 7 + 语义前 3（去重）。关键词精确命中是最可靠的信号，不让语义噪音与它同台竞争；
 *    语义通道为空时关键词占满 10；关键词为空时语义 top5 顶上（与模糊回退同一档位）
 *  - rrf：倒数排名融合 Σ1/(60+rank)，两路一起排
 */

export type MergeMode = 'channel' | 'rrf'

export interface MergedRow<K> {
  path: string
  /** 关键词通道的原条目；语义独有的条目没有 */
  kw?: K
  /** 语义相似度；只有来自语义通道（且不在关键词前列）的条目带 */
  sem?: number
}

export const noteKey = (p: string): string => p.replace(/\.md$/i, '').toLowerCase()

export const RRF_K = 60
export const CHANNEL_KW_QUOTA = 7
export const CHANNEL_SEM_ONLY_QUOTA = 5

export function mergeSearchRows<K extends { path: string }>(
  kwHits: K[],
  semHits: Array<{ path: string; score: number }>,
  mode: MergeMode,
  limit: number
): MergedRow<K>[] {
  // 同一篇只给一次（索引按笔记建，理论上不重复；守一道，放宽条数后重复更显眼）
  const seen = new Set<string>()
  const unique = kwHits.filter((h) => {
    const k = noteKey(h.path)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const kwKeys = new Set(unique.map((h) => noteKey(h.path)))
  const semOnly = semHits.filter((h) => !kwKeys.has(noteKey(h.path)))

  if (mode === 'rrf' && semOnly.length) {
    const score = new Map<string, { row: MergedRow<K>; s: number }>()
    unique.forEach((h, i) => score.set(noteKey(h.path), { row: { path: h.path, kw: h }, s: 1 / (RRF_K + i + 1) }))
    semHits.forEach((h, i) => {
      const k = noteKey(h.path)
      const cur = score.get(k)
      if (cur) cur.s += 1 / (RRF_K + i + 1)
      else score.set(k, { row: { path: h.path, sem: h.score }, s: 1 / (RRF_K + i + 1) })
    })
    return [...score.values()].sort((a, b) => b.s - a.s).map((x) => x.row).slice(0, limit)
  }
  const kwQuota = unique.length ? (semOnly.length ? CHANNEL_KW_QUOTA : limit) : 0
  const semQuota = unique.length ? limit - Math.min(kwQuota, unique.length) : CHANNEL_SEM_ONLY_QUOTA
  return [
    ...unique.slice(0, kwQuota).map((h) => ({ path: h.path, kw: h })),
    ...semOnly.slice(0, semQuota).map((h) => ({ path: h.path, sem: h.score })),
  ]
}
