import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import { homedir } from 'os'
import { MCN_PRESET, PRESETS, type PresetId, type VaultConfig } from './taxonomy'

/**
 * 建库/选库的路径护栏（PLAN-v2 N6，借 Claude Desktop 的文件夹护栏）。
 *
 * 把**家目录 / 磁盘根 / 外接卷根 / iCloud 根**整个当知识库会发生什么：首次索引扫几十万个文件、
 * 三个 chokidar watcher 盯住整块盘、投递箱建在 `~/00_投递箱`、AI 写入确认卡对着 `~/Documents/...`
 * 问你要不要改——每一样都不是用户想要的，而且没有一样能在事后轻松撤销。
 * 所以在 `vault:pickExisting` / `vault:createNew` 就拦，理由直接回给向导 toast。
 *
 * **只拦「根」本身，不拦其下的子目录**：`~/Documents/我的知识库` 完全合法。
 */
export function isSafeVaultRoot(path: string): { ok: true } | { ok: false; reason: string } {
  const p = resolve(path).replace(/[\\/]+$/, '') || '/' // 去尾斜杠；`/` 去完是空串，要补回来
  const home = resolve(homedir())
  const bad: Array<[string, string]> = [
    ['/', '磁盘根目录'],
    [home, '家目录'],
    [join(home, 'Library', 'Mobile Documents'), 'iCloud 云盘根目录'],
    [join(home, 'Library'), '系统资料库目录'],
  ]
  for (const [root, label] of bad) {
    if (p === root) return { ok: false, reason: `不能把${label}整个当作知识库，请选一个专门的文件夹（比如「文稿」下新建一个）` }
  }
  // 外接卷 / 网络卷的根：/Volumes/<名字>
  const m = p.match(/^\/Volumes\/[^/]+$/)
  if (m) return { ok: false, reason: '不能把整块磁盘当作知识库，请在磁盘里选一个专门的文件夹' }
  // /Volumes 自己、/Users 这类系统目录
  if (p === '/Volumes' || p === '/Users' || p === '/System' || p === '/Applications') {
    return { ok: false, reason: '这是系统目录，不能当作知识库' }
  }
  void sep
  return { ok: true }
}

/**
 * 新建库的默认布局。
 *
 * **值本身在 `taxonomy.ts` 的 `MCN_PRESET` 里**，这里只是它的别名——
 * 出厂值全仓库只许有一份定义。
 *
 * `entities` 那段是 `07_sensitive_enrich` 建链的实体清单来源。A-3 的代码级根因
 * 就在这里：07 原来写死扫 `40_带货/产品` 与 `30_课程/课程计划`，而这两个目录在
 * 模板建的库里压根不存在 → 实体扫描恒为 0 条 → 双链从 352 掉到 2。
 * 所以清单路径必须两边读同一份配置，**不许各写一套**。
 */
export const DEFAULT_LAYOUT = MCN_PRESET

/**
 * 建库时**真建出来**的目录——只有这两个。
 *
 * 0.2.0 批 3 之前，建库会把配置里所有目录字段都 mkdir 一遍，于是每个新客户
 * 打开软件第一眼看到的是 `20_公司管理` `30_课程` `40_带货`——**一家美妆 MCN 的
 * 组织架构**。管理咨询客户的库里，这三个目录到交付那天还是空的。
 *
 * 现在只建用户马上要用的两个，其余**按需**：
 *
 * | 目录 | 谁在什么时候建 |
 * | --- | --- |
 * | `90_产物` | 第一个产物落盘时（`ArtifactsWatcher` 惰性监听） |
 * | `30_实体/*` | 建第一张实体卡时（`entity-cards.ts` 写卡前 mkdir） |
 * | `concepts` | 生成第一个概念页时（`06_concepts.py`） |
 * | `talents` | 拆出第一张达人卡时（`08_table_to_cards.py`） |
 * | `scripts` | 没有自动写入方，用户自己建 |
 *
 * **去掉预建的代价是"按需"那一侧必须真的会建**——`08_table_to_cards` 原来
 * 直接往目录里写卡、不 mkdir，靠的就是建库时已经建好。那种依赖一旦断了
 * 只有真跑到那一步才炸，所以改这里必须同时把写入方逐个补齐（本批已补）。
 */
const ALWAYS_CREATE = ['inbox', 'library'] as const

const welcome = (cfg: VaultConfig): string => `---
doc_type: 指南
tags: [入门]
---

# 欢迎使用 SamePage

这是你的个人知识库——一个普通的 markdown 文件夹，兼容 [[Obsidian]]。

三件事从这里开始：

1. 把文件拖进「${cfg.inbox}」，系统自动转换、打标、建链
2. 在对话工作台直接问你的库
3. 说"把XX做成 PPT"，产物会出现在「${cfg.artifacts}」
`

/**
 * 建一个新库。
 *
 * @param preset 模板：`general` 通用（默认）｜`mcn` 美妆带货 MCN｜`custom` 自定义
 *   （自定义先按通用起步，建完在设置里改——不是第三份预设）
 */
export async function createVault(root: string, preset: PresetId = 'general'): Promise<void> {
  const cfg = PRESETS[preset] ?? PRESETS.general
  await fs.mkdir(root, { recursive: true })
  for (const key of ALWAYS_CREATE) {
    await fs.mkdir(join(root, cfg[key]), { recursive: true })
  }
  await fs.mkdir(join(root, '.mcnai'), { recursive: true })
  await fs.writeFile(join(root, '.mcnai', 'layout.json'), JSON.stringify(cfg, null, 2))
  await fs.writeFile(join(root, '欢迎.md'), welcome(cfg))
}
