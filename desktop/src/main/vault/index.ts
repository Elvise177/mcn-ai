import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { shell, type BrowserWindow } from 'electron'
import { scanVault, parseNote, readNoteBody, buildTree, IGNORE } from './reader'
import { buildGraph, makeResolver } from './graph'
import { VaultSearcher } from './searcher'
import type { VaultNote, VaultTreeNode, GraphData, SearchHit } from './types'

/** vault 单例管理器：索引 + 监听 + 检索 + 读写，主进程内唯一数据源 */
export class VaultManager {
  private root: string | null = null
  private notes = new Map<string, VaultNote>()
  private searcher = new VaultSearcher()
  private watcher: FSWatcher | null = null
  private win: BrowserWindow | null = null

  attachWindow(win: BrowserWindow): void {
    this.win = win
  }

  get currentRoot(): string | null {
    return this.root
  }

  async open(root: string): Promise<{ noteCount: number }> {
    // 同一库已打开则直接复用索引——切页面回来不再全量重扫
    if (this.root === root && this.notes.size > 0) {
      return { noteCount: this.notes.size }
    }
    await this.close()
    this.root = root
    const { notes, bodies } = await scanVault(root)
    this.notes = notes
    // 检索索引后台构建，不阻塞界面打开
    this.searcher.rebuild(notes, bodies)
    this.startWatcher()
    return { noteCount: this.notes.size }
  }

  private startWatcher(): void {
    if (!this.root) return
    this.watcher = chokidar.watch('**/*.md', {
      cwd: this.root,
      ignored: IGNORE,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 },
    })
    const onUpsert = async (rel: string): Promise<void> => {
      if (!this.root) return
      const r = await parseNote(this.root, join(this.root, rel))
      if (r) {
        this.notes.set(r.note.path, r.note)
        this.searcher.upsert(r.note, r.raw)
        this.notify(r.note.path)
      }
    }
    this.watcher.on('add', onUpsert)
    this.watcher.on('change', onUpsert)
    this.watcher.on('unlink', (rel: string) => {
      this.notes.delete(rel)
      this.searcher.remove(rel)
      this.notify(rel)
    })
  }

  private notify(path: string): void {
    this.win?.webContents.send('vault:changed', { path })
  }

  async close(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    this.notes.clear()
    this.root = null
  }

  tree(): VaultTreeNode[] {
    return buildTree(this.notes)
  }

  graph(): GraphData {
    return buildGraph(this.notes)
  }

  search(q: string): Promise<SearchHit[]> {
    return this.searcher.search(q)
  }

  async read(relPath: string): Promise<{ frontmatter: Record<string, unknown>; body: string; title: string }> {
    if (!this.root) throw new Error('vault 未打开')
    const { frontmatter, body } = await readNoteBody(this.root, relPath)
    return { frontmatter, body, title: relPath.split('/').pop()?.replace(/\.md$/, '') ?? relPath }
  }

  /** 原文读取（含 frontmatter），编辑模式用——与 Obsidian 源码模式等价 */
  async readRaw(relPath: string): Promise<string> {
    if (!this.root) throw new Error('vault 未打开')
    return fs.readFile(join(this.root, relPath), 'utf-8')
  }

  /** 写回原文；watcher 会自动捕获变更刷新索引 */
  async write(relPath: string, raw: string): Promise<void> {
    if (!this.root) throw new Error('vault 未打开')
    await fs.writeFile(join(this.root, relPath), raw, 'utf-8')
  }

  /** 新建笔记，返回相对路径；重名自动加序号 */
  async createNote(dir: string, name: string): Promise<string> {
    if (!this.root) throw new Error('vault 未打开')
    const safe = name.replace(/[\\/:*?"<>|]/g, '').trim() || '未命名'
    let rel = join(dir, `${safe}.md`)
    let n = 1
    while (this.notes.has(rel)) {
      rel = join(dir, `${safe} ${++n}.md`)
    }
    const abs = join(this.root, rel)
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, `---\ntags: []\n---\n\n# ${safe}\n\n`, 'utf-8')
    return rel
  }

  /** 删除 = 移入系统废纸篓（可恢复，不做硬删除） */
  async deleteNote(relPath: string): Promise<void> {
    if (!this.root) throw new Error('vault 未打开')
    await shell.trashItem(join(this.root, relPath))
    this.notes.delete(relPath)
    this.searcher.remove(relPath)
    this.notify(relPath)
  }

  /** 打开库内非 md 文件（PDF 等）：相对当前笔记或库根解析后交系统默认应用 */
  async openFile(href: string, fromNote: string): Promise<boolean> {
    if (!this.root) return false
    let decoded = href
    try {
      decoded = decodeURIComponent(href)
    } catch {
      /* 保留原样 */
    }
    const candidates = [join(this.root, dirname(fromNote), decoded), join(this.root, decoded)]
    for (const p of candidates) {
      try {
        await fs.access(p)
        await shell.openPath(p)
        return true
      } catch {
        continue
      }
    }
    return false
  }

  /** wiki 链接目标 → 相对路径（全路径/后缀/短名三级解析，与图谱共用一套规则） */
  resolveLink(target: string): string | null {
    return makeResolver(this.notes)(target)
  }
}

export const vaultManager = new VaultManager()
