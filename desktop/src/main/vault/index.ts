import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { shell, type BrowserWindow } from 'electron'
import { scanVault, parseNote, readNoteBody, buildTree, IGNORE } from './reader'
import { buildGraph, makeResolver } from './graph'
import { VaultSearcher } from './searcher'
import type { VaultNote, VaultTreeNode, GraphData, SearchResult } from './types'

/** 编辑冲突检测（M-27）用的内容指纹。用内容 hash 而不是 mtime——见 startWatcher 的注释 */
const hashOf = (raw: string): string => createHash('sha256').update(raw, 'utf-8').digest('hex')

/** vault 单例管理器：索引 + 监听 + 检索 + 读写，主进程内唯一数据源 */
export class VaultManager {
  private root: string | null = null
  private notes = new Map<string, VaultNote>()
  private dirs = new Set<string>()
  private searcher = new VaultSearcher()
  private watcher: FSWatcher | null = null
  private win: BrowserWindow | null = null
  /**
   * 自触发抑制表（M-27）：应用自己 write 出去的内容指纹。
   * 我们自己写的那一下也会让 watcher 冒 change 事件，不区分的话每次保存都会自己给自己报冲突。
   * **按内容 hash 而不是 mtime 匹配**：chokidar 的 awaitWriteFinish(800ms) 会让事件里的 mtime
   * 与写入那一刻记录的对不上，漏抑制就是误报（设计 §8 风险 3）
   */
  private selfWrites = new Map<string, string>()

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
    const { notes, bodies, dirs } = await scanVault(root)
    this.notes = notes
    this.dirs = dirs
    // 检索索引后台构建，不阻塞界面打开
    this.searcher.rebuild(notes, bodies)
    this.startWatcher()
    return { noteCount: this.notes.size }
  }

  private startWatcher(): void {
    if (!this.root) return
    // 监听整库（不再只盯 md）：目录与原文件的增删也要反映到文件树
    // 追加隐藏文件/目录忽略（.checkpoint.jsonl 等 pipeline 内部文件不进树，与初始扫描 dot:false 对齐）
    this.watcher = chokidar.watch('.', {
      cwd: this.root,
      ignored: [...IGNORE, /(^|[/\\])\../],
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 },
    })
    const isMd = (p: string): boolean => p.toLowerCase().endsWith('.md')
    const onUpsert = async (rel: string): Promise<void> => {
      if (!this.root || !isMd(rel)) return // 原件不进树，非 md 变更不刷新
      const r = await parseNote(this.root, join(this.root, rel))
      if (r) {
        this.notes.set(r.note.path, r.note)
        this.searcher.upsert(r.note, r.raw)
        // 内容与我们刚写出去的一致 = 这条事件是我们自己触发的，不算"外部改动"
        const mine = this.selfWrites.get(rel) === hashOf(r.raw)
        if (mine) this.selfWrites.delete(rel)
        this.notify(rel, mine)
      }
    }
    this.watcher.on('add', onUpsert)
    this.watcher.on('change', onUpsert)
    this.watcher.on('unlink', (rel: string) => {
      if (!isMd(rel)) return
      this.notes.delete(rel)
      this.searcher.remove(rel)
      this.notify(rel)
    })
    this.watcher.on('addDir', (rel: string) => {
      if (rel) {
        this.dirs.add(rel)
        this.notify(rel)
      }
    })
    this.watcher.on('unlinkDir', (rel: string) => {
      if (rel) {
        this.dirs.delete(rel)
        this.notify(rel)
      }
    })
  }

  /** self=true 表示这次变更是应用自己写出去的，冲突检测要跳过它 */
  private notify(path: string, self = false): void {
    this.win?.webContents.send('vault:changed', { path, self })
  }

  async close(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    this.notes.clear()
    this.dirs.clear()
    this.root = null
    // 换库时把索引就绪位清掉：新库还没建好索引之前，不许拿旧库的结果糊弄
    this.searcher.reset()
  }

  /** 按相对路径取一篇笔记（cloudSync 判 `sensitive` 用；不另建索引，直接读内存里那份） */
  noteAt(relPath: string): VaultNote | undefined {
    return this.notes.get(relPath)
  }

  tree(): VaultTreeNode[] {
    return buildTree(this.notes, this.dirs)
  }

  graph(): GraphData {
    return buildGraph(this.notes)
  }

  search(q: string): Promise<SearchResult> {
    // 没开库就没什么可等的，直接回空（否则会在 searcher 的就绪闸门上白等）
    if (!this.root) return Promise.resolve({ hits: [], total: 0 })
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
    // 先登记指纹再写：watcher 的 change 事件靠它认出"这是我自己写的"
    this.selfWrites.set(relPath, hashOf(raw))
    try {
      await fs.writeFile(join(this.root, relPath), raw, 'utf-8')
    } catch (e) {
      this.selfWrites.delete(relPath)
      throw e
    }
  }

  /**
   * 编辑冲突检测的基线（M-27，设计 §5.2）：进入编辑态时记一份 `{mtimeMs, hash}`。
   * 文件不存在时返回 hash='' —— 调用方据此知道"这篇还没落盘"。
   */
  async stat(relPath: string): Promise<{ mtimeMs: number; hash: string; size: number }> {
    if (!this.root) throw new Error('vault 未打开')
    const abs = join(this.root, relPath)
    try {
      const [raw, st] = await Promise.all([fs.readFile(abs, 'utf-8'), fs.stat(abs)])
      return { mtimeMs: st.mtimeMs, hash: hashOf(raw), size: st.size }
    } catch {
      return { mtimeMs: 0, hash: '', size: 0 }
    }
  }

  /**
   * 带基线校验的写入（设计 §5.2 的时机 (c)）：保存那一刻再算一次磁盘 hash 与基线比对，
   * 兜住编辑期间那条非模态提示条漏掉的窗口 / TOCTOU。
   * 对不上就**不写**，把磁盘现状回给渲染层，由用户在三选一里决定怎么办。
   */
  async writeChecked(
    relPath: string,
    raw: string,
    baseHash: string
  ): Promise<{ ok: true } | { ok: false; conflict: true; current: string; currentHash: string }> {
    if (!this.root) throw new Error('vault 未打开')
    const now = await this.stat(relPath)
    if (now.hash !== baseHash) {
      const current = now.hash ? await this.readRaw(relPath) : ''
      return { ok: false, conflict: true, current, currentHash: now.hash }
    }
    await this.write(relPath, raw)
    return { ok: true }
  }

  /**
   * 冲突时的「另存为副本」：写成 `笔记名 (冲突副本 2026-08-16 14-30).md`，两份都保住。
   * 它是三选一里的默认项——唯一零数据丢失的选项（Obsidian / Dropbox / 坚果云的通行做法）。
   */
  async saveConflictCopy(relPath: string, raw: string): Promise<string> {
    if (!this.root) throw new Error('vault 未打开')
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`
    const dir = relPath.split('/').slice(0, -1).join('/')
    const base = (relPath.split('/').pop() ?? relPath).replace(/\.md$/i, '')
    let rel = join(dir, `${base} (冲突副本 ${stamp}).md`)
    let n = 1
    while (this.notes.has(rel)) {
      rel = join(dir, `${base} (冲突副本 ${stamp}-${++n}).md`)
    }
    await this.write(rel, raw)
    return rel
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

  /** 重命名（同目录）；索引由 watcher 的 unlink+add 自动跟进 */
  async renameNote(relPath: string, newName: string): Promise<string> {
    if (!this.root) throw new Error('vault 未打开')
    const safe = newName.replace(/[\\/:*?"<>|]/g, '').trim()
    if (!safe) throw new Error('名称无效')
    const dir = relPath.split('/').slice(0, -1).join('/')
    const newRel = dir ? `${dir}/${safe}.md` : `${safe}.md`
    if (newRel === relPath) return relPath
    if (this.notes.has(newRel)) throw new Error('同名笔记已存在')
    await fs.rename(join(this.root, relPath), join(this.root, newRel))
    return newRel
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
  /** 当前索引里的全部笔记路径。产物入库靠"跑完前后的差集"找落位笔记 */
  notePaths(): string[] {
    return [...this.notes.keys()]
  }

  resolveLink(target: string): string | null {
    return makeResolver(this.notes)(target)
  }
}

export const vaultManager = new VaultManager()
