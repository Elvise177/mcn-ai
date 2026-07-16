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
  for (const dir of Object.values(DEFAULT_LAYOUT)) {
    await fs.mkdir(join(root, dir), { recursive: true })
  }
  await fs.mkdir(join(root, '.mcnai'), { recursive: true })
  await fs.writeFile(join(root, '.mcnai', 'layout.json'), JSON.stringify(DEFAULT_LAYOUT, null, 2))
  await fs.writeFile(join(root, '欢迎.md'), WELCOME)
}
