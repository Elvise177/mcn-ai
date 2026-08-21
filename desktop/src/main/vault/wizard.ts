import { promises as fs } from 'fs'
import { join } from 'path'
import { MCN_PRESET } from './taxonomy'

/**
 * 新建库的默认布局。
 *
 * **值本身在 `taxonomy.ts` 的 `MCN_PRESET` 里**，这里只是它的别名——
 * 出厂值全仓库只许有一份定义（批 3 会在这里接上「通用 / MCN / 自定义」三套模板）。
 *
 * `entities` 那段是 `07_sensitive_enrich` 建链的实体清单来源。A-3 的代码级根因
 * 就在这里：07 原来写死扫 `40_带货/产品` 与 `30_课程/课程计划`，而这两个目录在
 * 模板建的库里压根不存在 → 实体扫描恒为 0 条 → 双链从 352 掉到 2。
 * 所以清单路径必须两边读同一份配置，**不许各写一套**。
 */
export const DEFAULT_LAYOUT = MCN_PRESET

/**
 * 配置里**哪些字段是目录**——显式列举，不许再靠"拉平取所有字符串叶子"。
 *
 * 原来的实现是递归收集全部字符串值。配置里只有目录时它是对的；
 * 2026-08-21 加了 `persona` / `categories` 之后立刻就错了——
 * 建库会 mkdir 出「mcn」「美妆带货MCN公司的资料管理员」「bizdata」
 * 「个人生活类」这一堆目录。**结构靠约定、不靠形状。**
 */
const DIR_FIELDS = ['inbox', 'library', 'artifacts', 'talents', 'scripts', 'concepts'] as const

export function layoutDirs(cfg: typeof MCN_PRESET): string[] {
  return [...DIR_FIELDS.map((k) => cfg[k]), ...Object.values(cfg.entities)].filter(Boolean)
}

const WELCOME = `---
doc_type: 指南
tags: [入门]
---

# 欢迎使用 SamePage

这是你的个人知识库——一个普通的 markdown 文件夹，兼容 [[Obsidian]]。

三件事从这里开始：

1. 把文件拖进「${DEFAULT_LAYOUT.inbox}」，系统自动转换、打标、建链
2. 在对话工作台直接问你的库
3. 说"把XX做成 PPT"，产物会出现在「${DEFAULT_LAYOUT.artifacts}」
`

export async function createVault(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  for (const dir of layoutDirs(DEFAULT_LAYOUT)) {
    await fs.mkdir(join(root, dir), { recursive: true })
  }
  await fs.mkdir(join(root, '.mcnai'), { recursive: true })
  await fs.writeFile(join(root, '.mcnai', 'layout.json'), JSON.stringify(DEFAULT_LAYOUT, null, 2))
  await fs.writeFile(join(root, '欢迎.md'), WELCOME)
}
