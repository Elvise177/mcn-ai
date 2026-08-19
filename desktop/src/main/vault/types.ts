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

/**
 * 图谱节点的角色（品牌二期配色的唯一依据）。渲染层只按它取色，不再按 doc_type 哈希——
 * 哈希取色的结果是"每个节点都在抢颜色"，373 个节点铺开就是一锅五彩粥。
 *   talent/product/partner  三类实体卡：各有一支颜色，色相互相拉开
 *   hub                     枢纽（MOC / 主题索引 / 合同）：深炭 + 尺寸稍大，用重量区分不用颜色
 *   doc                     普通文档（占 80%+）：统一暖灰，安静地当背景组织
 */
export type GraphNodeKind = 'talent' | 'product' | 'partner' | 'hub' | 'doc'

export interface GraphData {
  nodes: { id: string; name: string; group: string; kind: GraphNodeKind; val: number }[]
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
  /**
   * 这批结果来自**模糊那一遍**（AND 空了才跑的 OR + 覆盖率闸门，见 search-worker 的 runSearch）。
   * UI 要把它说出来——「精确没找到，这些是相近的」和「精确命中」是两件事
   */
  fuzzy?: boolean
}
