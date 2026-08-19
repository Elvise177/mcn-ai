/**
 * design token 的 JS 读取口——canvas（关系图）这类没法用 class 的地方走这里，
 * 保证颜色只有 styles/theme.css 一个来源，组件里不出现硬编码色值。
 */
const cache = new Map<string, string>()

export function token(name: string): string {
  const hit = cache.get(name)
  if (hit) return hit
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (v) cache.set(name, v)
  return v
}

/** px 类 token 的数值读取（可拖拽栏宽的默认值/上下限走这里，避免组件里写死数字） */
export function tokenPx(name: string, fallback: number): number {
  const n = parseFloat(token(name))
  return Number.isFinite(n) ? n : fallback
}

/**
 * 关系图节点配色：**按角色取色，不按分组哈希**（2026-08-18 重做）。
 * 旧版是 `hash(doc_type) % 7` 取七支暖色——结果是每个节点都在抢颜色，
 * 整图看着就是一锅粥。现在的原则是"多数安静、少数发声"：
 * 普通文档统一暖灰当背景，只有三类实体卡有颜色，枢纽用深炭 + 尺寸表达。
 * 角色由主进程算好（`vault/graph.ts` 的 `kindOf`），渲染层不猜。
 */
export const GRAPH_KIND_TOKEN: Record<string, string> = {
  talent: '--color-graph-talent',
  product: '--color-graph-product',
  partner: '--color-graph-partner',
  hub: '--color-graph-hub',
  doc: '--color-graph-node',
}

/** 图例（画在图谱角落）：顺序即视觉重要性，文案不许让用户猜颜色的含义 */
export const GRAPH_LEGEND: { kind: string; label: string }[] = [
  { kind: 'talent', label: '达人' },
  { kind: 'product', label: '产品' },
  { kind: 'partner', label: '合作方' },
  { kind: 'hub', label: '枢纽' },
  { kind: 'doc', label: '文档' },
]

/** 产物文件类型 → 图标色 token（ppt/docx/xlsx/pdf 各自区分） */
export const FILE_KIND_TOKEN: Record<string, string> = {
  ppt: '--color-file-ppt',
  doc: '--color-file-doc',
  xls: '--color-file-xls',
  pdf: '--color-file-pdf',
  md: '--color-file-md',
  other: '--color-file-other',
}
