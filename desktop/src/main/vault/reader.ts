import { promises as fs } from 'fs'
import { join, relative, basename, sep } from 'path'
import fg from 'fast-glob'
import matter from 'gray-matter'
import type { VaultNote, VaultTreeNode } from './types'

export const IGNORE = [
  '**/.obsidian/**',
  '**/.mcnai/**',
  '**/.git/**',
  '**/.done/**',
  '**/.failed/**',
  '**/node_modules/**',
  /**
   * `_assets/` 是 `02_convert` 抽出来的嵌图仓库，里面**一篇笔记都没有**。
   * 不排掉的话它会作为一个顶层目录出现在文件树里、点开空空如也
   * （截图里一眼就看得见）。图片本身照常渲染——那条路走的是 `mcnai-asset` 协议，
   * 与这里的笔记索引无关。
   */
  '**/_assets/**',
  '_assets',
]

const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
/** 标准 md 链接指向库内 .md 也算一条边（Obsidian 同样计入图谱） */
const MD_LINK = /\[[^\]]*\]\(([^)\s]+\.md)\)/g
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu

function parseRaw(root: string, absPath: string, raw: string, mtimeMs: number): VaultNote {
  let fm: Record<string, unknown> = {}
  let body = raw
  try {
    const parsed = matter(raw)
    fm = parsed.data ?? {}
    body = parsed.content
  } catch {
    /* frontmatter YAML 损坏时按纯正文处理，不让单个文件搞挂索引 */
  }
  const links = [...body.matchAll(WIKI_LINK)].map((m) => m[1].trim())
  for (const m of body.matchAll(MD_LINK)) {
    try {
      links.push(decodeURIComponent(m[1]).replace(/^\.\//, ''))
    } catch {
      links.push(m[1].replace(/^\.\//, ''))
    }
  }
  const fmTags = Array.isArray(fm.tags) ? fm.tags.map(String) : []
  const inlineTags = [...body.matchAll(INLINE_TAG)].map((m) => m[1])
  return {
    path: relative(root, absPath),
    title: basename(absPath, '.md'),
    frontmatter: fm,
    links: [...new Set(links)],
    tags: [...new Set([...fmTags, ...inlineTags])],
    mtimeMs,
  }
}

export async function parseNote(
  root: string,
  absPath: string
): Promise<{ note: VaultNote; raw: string } | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(absPath, 'utf-8'), fs.stat(absPath)])
    return { note: parseRaw(root, absPath, raw, stat.mtimeMs), raw }
  } catch {
    return null
  }
}

/** 全库扫描：单次读文件（索引与检索共用 raw），并发 64。
 *  同时收集目录——文件树按磁盘真实文件夹展示（Obsidian 一致），
 *  否则「只有原文件、没生成 md」的文件夹（如拖入视频/压缩包）在界面里永远看不到。
 *  原件本身不进树（0号用户 2026-07-24：太多太乱），要看原件去 Finder 或笔记内链接。 */
export async function scanVault(
  root: string
): Promise<{ notes: Map<string, VaultNote>; bodies: Map<string, string>; dirs: Set<string> }> {
  const [mdFiles, dirList] = await Promise.all([
    fg('**/*.md', { cwd: root, ignore: IGNORE, absolute: true, dot: false }),
    fg('**', { cwd: root, ignore: IGNORE, onlyDirectories: true, dot: false }),
  ])
  const notes = new Map<string, VaultNote>()
  const bodies = new Map<string, string>()
  const CONCURRENCY = 64
  for (let i = 0; i < mdFiles.length; i += CONCURRENCY) {
    const batch = await Promise.all(mdFiles.slice(i, i + CONCURRENCY).map((f) => parseNote(root, f)))
    for (const r of batch) {
      if (r) {
        notes.set(r.note.path, r.note)
        bodies.set(r.note.path, r.raw)
      }
    }
  }
  const dirs = new Set(dirList.map((d) => d.replace(/\/$/, '')))
  return { notes, bodies, dirs }
}

export async function readNoteBody(
  root: string,
  relPath: string
): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
  const raw = await fs.readFile(join(root, relPath), 'utf-8')
  try {
    const parsed = matter(raw)
    return { frontmatter: parsed.data ?? {}, body: parsed.content }
  } catch {
    return { frontmatter: {}, body: raw }
  }
}

export function buildTree(notes: Map<string, VaultNote>, dirs: Set<string> = new Set()): VaultTreeNode[] {
  const rootNodes: VaultTreeNode[] = []
  const dirMap = new Map<string, VaultTreeNode>()

  const ensureDir = (dirPath: string): VaultTreeNode[] => {
    if (!dirPath) return rootNodes
    let node = dirMap.get(dirPath)
    if (!node) {
      node = { name: basename(dirPath), path: dirPath, children: [] }
      dirMap.set(dirPath, node)
      const parentChildren = ensureDir(dirPath.split(sep).slice(0, -1).join(sep))
      parentChildren.push(node)
    }
    return node.children!
  }

  // 先登记所有目录——空目录 / 只含原文件的目录也要出现
  for (const d of [...dirs].sort()) ensureDir(d)

  for (const p of [...notes.keys()].sort()) {
    const dir = p.split(sep).slice(0, -1).join(sep)
    ensureDir(dir).push({ name: basename(p, '.md'), path: p })
  }

  const sortRec = (nodes: VaultTreeNode[]): void => {
    nodes.sort((a, b) => (!!b.children ? 1 : 0) - (!!a.children ? 1 : 0) || a.name.localeCompare(b.name, 'zh'))
    nodes.forEach((n) => n.children && sortRec(n.children))
  }
  sortRec(rootNodes)
  return rootNodes
}
