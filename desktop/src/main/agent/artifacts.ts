import { createHash } from 'crypto'
import { promises as fs, existsSync } from 'fs'
import { join, relative, basename } from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { shell } from 'electron'
import { notifyDingtalk } from '../lib/dingtalk'
import { notify } from '../lib/notify'
import { broadcast } from '../lib/windows'
import { store } from '../store'
import { inboxOrchestrator } from '../inbox/orchestrator'
import { vaultManager } from '../vault'
import { tasks } from '../tasks/registry'
import { getIngested, markIngested, type IngestedEntry } from '../tasks/persist'
import { log } from '../lib/logger'
import { readVaultConfig } from '../vault/taxonomy'

export interface Artifact {
  path: string
  name: string
  mtimeMs: number
  size: number
}

/** 产物卡片要的「已入库」判定结果（渲染层没有 Node，哈希校验只能在这边做完再给它） */
export interface IngestedInfo {
  at: number
  noteRel?: string
}

const sha256 = async (abs: string): Promise<string> =>
  createHash('sha256').update(await fs.readFile(abs)).digest('hex')

/** 监听 vault/90_产物：新产物推事件给产物面板 */
export class ArtifactsWatcher {
  private watcher: FSWatcher | null = null
  private dir: string | null = null
  /** 已 enqueue、等本轮 pipeline 跑完才知道成没成的产物 */
  private pending = new Set<string>()
  /** 入库前的笔记全集快照：跑完做差集就知道新落位了哪些笔记 */
  private beforeNotes: Set<string> | null = null

  constructor() {
    // ingest 的 running 阶段由某个 inbox run 承载，所以结果也跟着那一轮走
    inboxOrchestrator.onRunEnd((ok, canceled) => void this.resolvePending(ok, canceled))
  }

  /** 保留签名给调用方；下行事件走 broadcast（见 lib/windows.ts） */
  attachWindow(): void {}

  /** 退出前显式关掉 watcher（见 index.ts 的 before-quit：Electron 43 起不关就退不掉） */
  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
  }

  async configure(vaultRoot: string): Promise<void> {
    await this.watcher?.close()
    this.dir = join(vaultRoot, (await readVaultConfig(vaultRoot)).artifacts)
    /**
     * **不再 mkdir 产物目录**（0.2.0 批 3）。
     *
     * 这一行原来是 `await fs.mkdir(this.dir)`，于是不管这个库有没有产物，
     * 一开库就凭空长出一个空的 `90_产物`——批 3 要的"干净新库"就被它破坏了。
     *
     * chokidar 盯一个不存在的目录在 macOS 上不可靠，所以改成两段：
     * 目录已经在 → 直接盯它；还不在 → 先浅盯库根等它出现（产物由渲染器
     * 或 render_pptx 写出时自然创建），出现的那一刻再切过去盯真正的目录。
     */
    if (!existsSync(this.dir)) {
      const root = vaultRoot
      const boot = chokidar.watch(root, { depth: 0, ignoreInitial: true, ignored: /(^|\/)\./ })
      boot.on('addDir', (p: string) => {
        if (p !== this.dir) return
        void boot.close().then(() => this.configure(root))
      })
      this.watcher = boot
      return
    }
    this.watcher = chokidar.watch(this.dir, {
      ignored: /(^|\/)\./,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 200 },
    })
    this.watcher.on('add', (p: string) => {
      const rel = relative(this.dir!, p)
      broadcast('artifact:created', { path: rel, name: basename(p) })
      /**
       * F10：产物做完了发一条。**耗时给足**（产物本来就要几十秒，这里给
       * `NOTIFY_MIN_MS` 之上的值直接放行）——它不像入库那样会因为"拖一个文件"被频繁触发，
       * 而是用户明确要了一件东西、等着拿。
       */
      notify('artifact', '产物已生成', `${basename(p)} 做好了，可以打开或入库`, Number.MAX_SAFE_INTEGER)
      if (store.get('artifactAutoIngest')) void this.ingest(rel)
      notifyDingtalk('artifact', 'mcn-ai 产物', `### 新产物生成 📄\n\n**${basename(p)}**\n\n> ${new Date().toLocaleString('zh-CN')} · mcn-ai 自动化`)
    })
  }

  async list(): Promise<Artifact[]> {
    // 产物目录是**按需创建**的（批 3），没有产物时它根本不存在——
    // 直接 readdir 会 ENOENT，而"还没有产物"是完全正常的状态，不是错误
    if (!this.dir || !existsSync(this.dir)) return []
    const out: Artifact[] = []
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const p = join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else {
          const st = await fs.stat(p)
          out.push({ path: relative(this.dir!, p), name: e.name, mtimeMs: st.mtimeMs, size: st.size })
        }
      }
    }
    try {
      await walk(this.dir)
    } catch {
      /* 目录不存在等 */
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 30)
  }

  /**
   * 显式入库：建一个 ingest 任务再送进投递箱。
   * 以前是 `void enqueue(...)` 发射后不管，用户点完只有一句 toast、之后再无音讯。
   */
  async ingest(relPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.dir) return { ok: false, error: '请先打开知识库' }
    const id = `ingest:${relPath}`
    tasks.start({
      id,
      kind: 'ingest',
      key: relPath,
      status: 'queued',
      title: `入库「${basename(relPath)}」`,
      cancelable: false,
      artifactPath: relPath,
    })
    try {
      // 差集基线只在本批第一个入库任务时拍一次
      if (!this.pending.size) this.beforeNotes = new Set(vaultManager.notePaths())
      await inboxOrchestrator.enqueue([join(this.dir, relPath)])
      this.pending.add(relPath)
      return { ok: true }
    } catch (e) {
      tasks.finish(id, 'failed', e instanceof Error ? e.message : String(e))
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 本轮 pipeline 跑完：把等着的 ingest 任务一并结掉，并把「已入库」写进落盘表 */
  private async resolvePending(ok: boolean, canceled = false): Promise<void> {
    for (const rel of [...this.pending]) {
      this.pending.delete(rel)
      const id = `ingest:${rel}`
      if (canceled) {
        // 用户停了本轮投递：这些入库跟着停，是 canceled 不是 failed（中性灰，不报红）
        tasks.patch(id, { title: `已停止入库「${basename(rel)}」` })
        tasks.finish(id, 'canceled')
        continue
      }
      if (!ok) {
        tasks.patch(id, { title: `入库失败「${basename(rel)}」` })
        tasks.finish(id, 'failed', '投递箱本轮处理失败')
        continue
      }
      try {
        const abs = join(this.dir!, rel)
        const st = await fs.stat(abs)
        const base = basename(rel).replace(/\.[^.]+$/, '')
        // 找落位笔记。**不能只按文件名猜**：开了智能打标时 pipeline 会按内容给笔记重新命名，
        // 按原文件名 resolveLink 必然扑空。所以先按名字试，再退回"本轮新增的笔记"差集。
        // 另外 pipeline 刚写完 md、vault watcher（awaitWriteFinish 800ms）还没收进索引，
        // 两条路都要给几次重试
        let noteRel: string | undefined
        for (let i = 0; i < 6 && !noteRel; i++) {
          if (i) await new Promise((r) => setTimeout(r, 1200))
          noteRel = (await vaultManager.resolveLink(base)) ?? undefined
          if (noteRel) break
          const added = vaultManager.notePaths().filter((p) => !this.beforeNotes?.has(p))
          // 名字对得上的优先；本批只有一个产物且只新增了一篇时，那篇就是它
          noteRel =
            added.find((p) => basename(p).replace(/\.md$/, '') === base) ??
            (added.length === 1 ? added[0] : undefined)
        }
        markIngested(rel, {
          contentHash: await sha256(abs),
          mtimeMs: st.mtimeMs,
          size: st.size,
          at: Date.now(),
          noteRel,
        })
        tasks.patch(id, { noteRel, title: `已入库「${basename(rel)}」` })
        tasks.finish(id, 'succeeded')
      } catch (e) {
        log('error', 'ingest', `${rel}: ${e}`)
        tasks.finish(id, 'failed', e instanceof Error ? e.message : String(e))
      }
    }
    this.beforeNotes = null
  }

  /**
   * 已入库表（复合主键 artifactRel + contentHash，见设计 §3.4）。
   * 快速门：mtime+size 与存量一致就直接信任存量哈希，不重算——产物面板一次列 30 个，
   * pptx 动辄几 MB，每次开面板全量 sha256 是纯浪费。
   */
  async ingested(): Promise<Record<string, IngestedInfo>> {
    if (!this.dir) return {}
    const table = getIngested()
    const out: Record<string, IngestedInfo> = {}
    for (const [rel, e] of Object.entries(table)) {
      try {
        const abs = join(this.dir, rel)
        const st = await fs.stat(abs)
        let entry: IngestedEntry = e
        if (st.mtimeMs !== e.mtimeMs || st.size !== e.size) {
          // 动过了才真去算哈希：内容没变（只是被 touch）仍算已入库，内容变了就放行重新入库
          const hash = await sha256(abs)
          if (hash !== e.contentHash) continue
          entry = { ...e, mtimeMs: st.mtimeMs, size: st.size }
          markIngested(rel, entry)
        }
        out[rel] = { at: entry.at, noteRel: entry.noteRel }
      } catch {
        /* 产物被删了：不再算已入库 */
      }
    }
    return out
  }

  /**
   * 打开产物（M-05）。以前 `shell.openPath` 的返回值被直接丢掉——它失败时返回的是错误字符串，
   * 结果"系统里没装 Keynote/Office"或"产物已被删掉"时点「打开」纯粹没反应。
   * 现在把失败原因回给渲染层，由它 toast 并给「在 Finder 中显示」兜底。
   */
  async open(relPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.dir) return { ok: false, error: '请先打开知识库' }
    const abs = join(this.dir, relPath)
    try {
      await fs.access(abs)
    } catch {
      return { ok: false, error: '文件不存在（可能已被移动或删除）' }
    }
    const err = await shell.openPath(abs)
    return err ? { ok: false, error: err } : { ok: true }
  }

  /** 打不开时的兜底出口：至少让用户在 Finder 里看到这个文件 */
  reveal(relPath: string): void {
    if (!this.dir) return
    shell.showItemInFolder(join(this.dir, relPath))
  }

  async readText(relPath: string): Promise<string> {
    if (!this.dir) throw new Error('未就绪')
    return fs.readFile(join(this.dir, relPath), 'utf-8')
  }
}

export const artifactsWatcher = new ArtifactsWatcher()
