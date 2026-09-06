import { promises as fs } from 'fs'
import { join, relative, dirname } from 'path'
import fg from 'fast-glob'
import matter from 'gray-matter'
import { IGNORE } from './reader'
import { log } from '../lib/logger'
import { readVaultConfig } from './taxonomy'
import { AUTO_END, AUTO_START, CONFLICT_HEAD, sha1, userPart } from './entity-cards'

/**
 * wiki 主题页生成器（检索优化第二单，2026-09-05，方案 `docs/PLAN-retrieval-wiki.md`）。
 *
 * 干什么：给每个**目录主题**（资料库下的子目录名）和**标签主题**（≥ MIN_TAG 篇笔记共用的 tag）
 * 各生成一页，自动区里放「摘要区」——每篇关联文档一行：标题 + frontmatter `summary` + 类型，
 * 末尾一行是这些文档 tags 的并集。**零 LLM**：摘要与标签都是 `03_tag_llm` / `03b` 已经写好的。
 *
 * 为什么能解检索基线里的三种失败形状：
 *  - 泛标题正文无词（《总结.md》正文没有"星母计划"）：主题页《星母培训计划》的摘要行里有它的标题 + 摘要
 *  - AND 匹配失败（「孵化 培训 项目」）：主题页一页里同时含这些词，全 AND 直接命中主题页，模型顺链接读原文
 *  - 排名靠后：主题页标题就是主题名、正文全是关键词密集的摘要行，天然排最前，替代"翻到第 15 位"
 *
 * **敏感继承与建卡器同一套**（用户拍板，2026-09-05）：
 *  - 只由敏感文档支撑的主题 → 页 `sensitive: true`（不上云、规则打标），可以列全链接与摘要
 *  - 同时有非敏感文档的 → 普通页（会上云），**敏感文档只报数，不写文件名、不写摘要、不建链**——
 *    文件名本身就可能是敏感内容（`绩效考核评估档案-<真名>`），摘要更是。R-03 那类泄漏面不在 wiki 页上重演
 *
 * 自动区 / 冲突 / 幂等：与实体卡同一套标记（AUTO_START/AUTO_END）、同一套「用户改过自动区就不覆盖，
 * 新内容进待合并」、同一个 `auto_hash` 指纹。落位固定在实体目录旁的 `主题/`（`dirname(entities.talent)/主题`），
 * 不加 layout.json 字段——那要连 pkb-pipeline 的 taxonomy.py 一起改（TS↔Py 契约有 smoke 守着），本单不跨仓。
 */

/**
 * **默认关闭**（2026-09-05 第二单试跑结论）：45 题 bench 上主题页进了 25 题的前 10，模型只 Read 了 4 次，
 * 反而挤掉原文位次（跨文档读到率 −10pp、验证集全命中 0%）。开关留给下一步"让模型认得主题页"的实验：
 * 环境变量 `MCNAI_WIKI_PAGES=1`（入库 run-end 与 bench 执行端都看它）。代码与 smoke 断言保留。
 */
export const WIKI_PAGES_ENABLED = process.env.MCNAI_WIKI_PAGES === '1'

/** 标签主题的门槛：少于这么多篇共用的 tag 不成页（一两篇共用的 tag 是噪音，页会爆炸） */
export const MIN_TAG = 3
/** 目录主题的门槛：至少两篇；超过这个数的目录（如资料库一级分类）太泛，页会长到没法读，也不成页 */
export const MIN_DIR = 2
export const MAX_DIR = 60
/** 摘要区最多列多少篇：再多就不是"摘要"了，模型也读不完 */
export const MAX_ROWS = 60

/** 不成主题的 tag：实体卡与索引页自己打的标签，以及 03b 规则打标塞进 tags 的表头/数字噪音 */
const TAG_STOP = new Set(['实体', '达人', '产品', '合作方', 'moc', 'library', '主题', '数据表', 'SOP', '其他', '复盘', '课件', '会议纪要', '方法论'])
const looksLikeNoiseTag = (t: string): boolean => /^[\d.%－\-\/]+$/.test(t) || t.length < 2 || t.length > 12

export interface WikiSource {
  rel: string
  title: string
  summary: string
  docType: string
  tags: string[]
  sensitive: boolean
  /** 资料库内目录段（不含库根与文件名） */
  dirs: string[]
}

export interface WikiTopic {
  /** 页名（文件名）。目录主题与同名标签主题合并成一页 */
  name: string
  kind: 'dir' | 'tag' | 'mixed'
  sources: WikiSource[]
}

export interface WikiStats {
  scanned: number
  topics: number
  created: number
  updated: number
  unchanged: number
  conflicted: number
  sensitivePages: number
  /** 相对库根，主进程据此把敏感页排除在上云之外 */
  sensitivePaths: string[]
  dir: string
}

/** 扫资料库，读每篇笔记成页所需的几个字段。**只读 frontmatter，不读正文** */
export async function collectSources(root: string, libName: string): Promise<WikiSource[]> {
  const libDir = join(root, libName)
  const files = await fg('**/*.md', { cwd: libDir, ignore: IGNORE, absolute: true, dot: false })
  const out: WikiSource[] = []
  for (const abs of files) {
    const title = abs.split('/').pop()!.replace(/\.md$/, '')
    if (title.startsWith('_')) continue // MOC / 主题索引 / 质检抽样：本身就是索引页
    let fm: Record<string, unknown> = {}
    try {
      fm = matter(await fs.readFile(abs, 'utf-8')).data ?? {}
    } catch {
      /* frontmatter 坏了：当成没有摘要的普通文档，别让一篇坏文件搞掉整批页 */
    }
    const rel = relative(root, abs)
    const dirs = dirname(relative(libDir, abs))
      .split('/')
      .filter((d) => d && d !== '.')
    out.push({
      rel,
      title,
      summary: typeof fm.summary === 'string' ? fm.summary.trim() : '',
      docType: typeof fm.doc_type === 'string' ? fm.doc_type : '',
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      sensitive: fm.sensitive === true,
      dirs,
    })
  }
  return out
}

/**
 * 纯函数：来源 → 主题清单。抽出来是为了 `smoke:cards` 零文件系统断言门槛与合并规则。
 * 目录主题：每篇的每一级目录名各记一次（《总结.md》同时属于「星母培训计划」与「数据复盘」）。
 * 同名目录在不同父目录下（两个「团队培训」）合成一页——用户问"团队培训"时本来就两边都要看。
 */
export function groupTopics(sources: WikiSource[]): WikiTopic[] {
  const byDir = new Map<string, WikiSource[]>()
  const byTag = new Map<string, WikiSource[]>()
  for (const s of sources) {
    for (const d of new Set(s.dirs)) {
      const name = d.replace(/^\d+_/, '')
      if (!name || name.startsWith('.')) continue
      byDir.set(name, [...(byDir.get(name) ?? []), s])
    }
    for (const t of new Set(s.tags.map((x) => x.trim()))) {
      if (TAG_STOP.has(t) || looksLikeNoiseTag(t)) continue
      byTag.set(t, [...(byTag.get(t) ?? []), s])
    }
  }
  const topics = new Map<string, WikiTopic>()
  for (const [name, list] of byDir) {
    if (list.length < MIN_DIR || list.length > MAX_DIR) continue
    topics.set(name, { name, kind: 'dir', sources: list })
  }
  for (const [name, list] of byTag) {
    if (list.length < MIN_TAG) continue
    const prev = topics.get(name)
    if (prev) {
      const seen = new Set(prev.sources.map((s) => s.rel))
      prev.sources.push(...list.filter((s) => !seen.has(s.rel)))
      prev.kind = 'mixed'
    } else {
      topics.set(name, { name, kind: 'tag', sources: list })
    }
  }
  return [...topics.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 页是不是敏感页：与实体卡同一条判据——**只由敏感文档支撑**才敏感 */
export const topicIsSensitive = (t: WikiTopic): boolean => t.sources.length > 0 && t.sources.every((s) => s.sensitive)

/** 自动区正文（不含标记、不含指纹）。纯函数，smoke 直接断言"普通页里一个敏感文件名/摘要都不许出现" */
export function renderAuto(t: WikiTopic, sensitivePage: boolean): string {
  const normal = t.sources.filter((s) => !s.sensitive)
  const sens = t.sources.filter((s) => s.sensitive)
  const row = (s: WikiSource): string =>
    `- [[${s.rel.replace(/\.md$/, '')}|${s.title}]]${s.summary ? ` — ${s.summary}` : ''}${s.docType ? `（${s.docType}）` : ''}`
  const kindLabel = t.kind === 'dir' ? '目录主题' : t.kind === 'tag' ? '标签主题' : '目录 + 标签主题'
  const lines: string[] = ['## 摘要区', '', `${t.name} · ${kindLabel} · 关联 ${t.sources.length} 篇`, '']
  const listed = sensitivePage ? sens : normal
  for (const s of listed.slice(0, MAX_ROWS)) lines.push(row(s))
  if (listed.length > MAX_ROWS) lines.push(`- …另有 ${listed.length - MAX_ROWS} 篇未列（按标题检索可找到）`)
  if (!sensitivePage && sens.length) {
    // 普通页会上云：敏感文档只报数，不写文件名、不写摘要、不建链（同实体卡 autoSection 的口径）
    lines.push('', `> 另有 ${sens.length} 份敏感文档属于本主题，按设置仅存本地，未列在这里。`)
  }
  const kw = [...new Set(listed.flatMap((s) => s.tags).filter((x) => !looksLikeNoiseTag(x)))].slice(0, 40)
  if (kw.length) lines.push('', `关键词：${kw.join(' ')}`)
  lines.push('', '> 以上是各篇的摘要，回答问题前请 Read 原文。')
  return lines.join('\n').trimEnd()
}

function renderPage(t: WikiTopic, sensitivePage: boolean, prevBody = ''): string {
  const auto = renderAuto(t, sensitivePage)
  const fm = [
    '---',
    'doc_type: 主题页',
    `topic_kind: ${t.kind}`,
    `topic_name: ${JSON.stringify(t.name)}`,
    'tags: ["主题"]',
    `sources_normal: ${t.sources.filter((s) => !s.sensitive).length}`,
    `sources_sensitive: ${t.sources.filter((s) => s.sensitive).length}`,
    ...(sensitivePage ? ['sensitive: true'] : []),
    `auto_hash: ${sha1(auto)}`,
    '---',
    '',
  ]
  return `${fm.join('\n')}# 📚 ${t.name}\n\n${AUTO_START}\n${auto}\n${AUTO_END}\n${prevBody ? `\n${prevBody}\n` : ''}`
}

/** 主题页目录：实体目录旁的 `主题/`。不进 layout.json（理由见文件头） */
export async function wikiDir(root: string): Promise<string> {
  const cfg = await readVaultConfig(root)
  return join(dirname(cfg.entities.talent), '主题')
}

export async function buildWikiPages(root: string, libName: string): Promise<WikiStats> {
  const dir = await wikiDir(root)
  const st: WikiStats = { scanned: 0, topics: 0, created: 0, updated: 0, unchanged: 0, conflicted: 0, sensitivePages: 0, sensitivePaths: [], dir }
  const sources = await collectSources(root, libName)
  st.scanned = sources.length
  const topics = groupTopics(sources)
  st.topics = topics.length
  if (!topics.length) return st
  await fs.mkdir(join(root, dir), { recursive: true })

  for (const t of topics) {
    const sensitivePage = topicIsSensitive(t)
    const file = join(root, dir, `${t.name.replace(/[\\/:*?"<>|]/g, '_')}.md`)
    let prev = ''
    try {
      prev = await fs.readFile(file, 'utf-8')
    } catch {
      /* 新页 */
    }
    const nextAuto = renderAuto(t, sensitivePage)
    if (!prev) {
      await fs.writeFile(file, renderPage(t, sensitivePage), 'utf-8')
      st.created++
    } else {
      const i = prev.indexOf(AUTO_START)
      const j = prev.indexOf(AUTO_END)
      const prevAuto = i >= 0 && j > i ? prev.slice(i + AUTO_START.length, j).trim() : ''
      let prevHash = ''
      try {
        prevHash = (matter(prev).data?.auto_hash as string) ?? ''
      } catch {
        /* 用户把 frontmatter 改坏了：按"改过"处理，走待合并 */
      }
      if (i < 0 || j < 0 || (prevHash && prevHash !== sha1(prevAuto))) {
        // 用户改过自动区 → 保用户版，新内容进「待合并」（同实体卡，M-27 的原则）
        const rest = userPart(prev)
        const patch = `${CONFLICT_HEAD}\n\n${nextAuto}`
        const body = rest.includes(CONFLICT_HEAD) ? rest.replace(new RegExp(`${CONFLICT_HEAD}[\\s\\S]*`), patch) : `${rest}\n\n${patch}`.trim()
        const head = j >= 0 ? prev.slice(0, j + AUTO_END.length) : prev.trimEnd()
        await fs.writeFile(file, `${head}\n\n${body}\n`, 'utf-8')
        st.conflicted++
      } else if (prevAuto === nextAuto) {
        st.unchanged++
      } else {
        await fs.writeFile(file, renderPage(t, sensitivePage, userPart(prev)), 'utf-8')
        st.updated++
      }
    }
    if (sensitivePage) {
      st.sensitivePages++
      st.sensitivePaths.push(relative(root, file))
    }
  }
  log(
    'info',
    'wiki',
    `主题页完成：扫 ${st.scanned} 篇 → 主题 ${st.topics} 个｜新建 ${st.created} 更新 ${st.updated} 未变 ${st.unchanged} 冲突保留用户版 ${st.conflicted}｜敏感页 ${st.sensitivePages}（落位 ${dir}）`
  )
  return st
}
