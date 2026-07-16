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
