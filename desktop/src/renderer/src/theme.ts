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

/** 关系图分组配色（按分组名 hash 取色）——暖调谱系，数值在 styles/theme.css */
export const GRAPH_GROUP_TOKENS = [
  '--color-group-1',
  '--color-group-2',
  '--color-group-3',
  '--color-group-4',
  '--color-group-5',
  '--color-group-6',
  '--color-group-7',
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
