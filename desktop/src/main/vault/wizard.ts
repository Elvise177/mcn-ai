import { promises as fs } from 'fs'
import { join } from 'path'

/** 新建库的默认布局——编号与 pkb-pipeline 默认目录约定对齐，M2 参数化时共用 */
export const DEFAULT_LAYOUT = {
  inbox: '00_投递箱',
  library: '80_资料库',
  artifacts: '90_产物',
  talents: '20_公司管理/25_达人档案',
  scripts: '40_带货/41_脚本库',
  concepts: '30_课程/31_方法论',
  /**
   * 实体卡的落位（A-3）。**新开一个中性的 `30_实体/`**，不复用老库那套
   * （`20_公司管理/25_达人档案` 是 0 号用户自己的语义，对别的客户不成立）；
   * 老库重跑时新卡也落这里，与她现有目录并存、老卡不动。
   *
   * **这一段是 `07_sensitive_enrich` 建链的实体清单来源**。A-3 的代码级根因就在这里：
   * 07 原来写死扫 `40_带货/产品` 与 `30_课程/课程计划`，而这两个目录在模板建的库里
   * 压根不存在（layout 给的是 `41_脚本库` / `31_方法论`）→ 实体扫描恒为 0 条
   * → 双链从 352 掉到 2。所以清单路径必须两边读同一份 layout，不许各写一套。
   */
  entities: {
    talent: '30_实体/达人',
    product: '30_实体/产品',
    partner: '30_实体/合作方',
  },
}

/** 布局里所有需要真建出来的目录（`entities` 是嵌套的，拉平取字符串叶子） */
function layoutDirs(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (v && typeof v === 'object') return Object.values(v).flatMap(layoutDirs)
  return []
}

const WELCOME = `---
doc_type: 指南
tags: [入门]
---

# 欢迎使用 mcn-ai

这是你的个人知识库——一个普通的 markdown 文件夹，兼容 [[Obsidian]]。

三件事从这里开始：

1. 把文件拖进「${DEFAULT_LAYOUT.inbox}」，系统自动转换、打标、建链
2. 在对话工作台直接问你的库
3. 说"把XX做成 PPT"，产物会出现在「${DEFAULT_LAYOUT.artifacts}」
`

export async function createVault(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  // 拉平取叶子：直接 Object.values 的话，嵌套的 entities 会被 mkdir 成「[object Object]」
  for (const dir of layoutDirs(DEFAULT_LAYOUT)) {
    await fs.mkdir(join(root, dir), { recursive: true })
  }
  await fs.mkdir(join(root, '.mcnai'), { recursive: true })
  await fs.writeFile(join(root, '.mcnai', 'layout.json'), JSON.stringify(DEFAULT_LAYOUT, null, 2))
  await fs.writeFile(join(root, '欢迎.md'), WELCOME)
}
