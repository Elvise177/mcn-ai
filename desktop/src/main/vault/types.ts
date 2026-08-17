export interface VaultNote {
  /** vault 内相对路径，作为唯一 id */
  path: string
  /** 文件名（无扩展名），wiki 链接解析用 */
  title: string
  frontmatter: Record<string, unknown>
  /** [[双链]] 目标名列表（未解析） */
  links: string[]
  tags: string[]
  mtimeMs: number
}

export interface VaultTreeNode {
  name: string
  path: string
  children?: VaultTreeNode[]
}

export interface GraphData {
  nodes: { id: string; name: string; group: string; val: number }[]
  links: { source: string; target: string }[]
}

export interface SearchHit {
  path: string
  title: string
  snippet: string
}

/**
 * 检索结果。**必须带总数**：结果被静默截断到 20 条，UI 只显示前 20 条时
 * 用户无从知道"还有更多"（M-13），也分不清「只有这些」和「太多了先给你看一部分」
 */
export interface SearchResult {
  hits: SearchHit[]
  /** 命中总数（未截断前） */
  total: number
}
