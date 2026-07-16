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

/** 全库扫描：单次读文件（索引与检索共用 raw），并发 64 */
export async function scanVault(
  root: string
): Promise<{ notes: Map<string, VaultNote>; bodies: Map<string, string> }> {
  const files = await fg('**/*.md', { cwd: root, ignore: IGNORE, absolute: true, dot: false })
  const notes = new Map<string, VaultNote>()
  const bodies = new Map<string, string>()
  const CONCURRENCY = 64
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = await Promise.all(files.slice(i, i + CONCURRENCY).map((f) => parseNote(root, f)))
    for (const r of batch) {
      if (r) {
        notes.set(r.note.path, r.note)
        bodies.set(r.note.path, r.raw)
      }
    }
  }
  return { notes, bodies }
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

export function buildTree(notes: Map<string, VaultNote>): VaultTreeNode[] {
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

  const sorted = [...notes.keys()].sort()
  for (const p of sorted) {
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
