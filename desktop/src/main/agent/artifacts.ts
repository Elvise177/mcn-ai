import { promises as fs } from 'fs'
import { join, relative, basename } from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { shell, type BrowserWindow } from 'electron'
import { notifyDingtalk } from '../lib/dingtalk'

export interface Artifact {
  path: string
  name: string
  mtimeMs: number
  size: number
}

/** 监听 vault/90_产物：新产物推事件给产物面板 */
export class ArtifactsWatcher {
  private win: BrowserWindow | null = null
  private watcher: FSWatcher | null = null
  private dir: string | null = null

  attachWindow(win: BrowserWindow): void {
    this.win = win
  }

  async configure(vaultRoot: string): Promise<void> {
    await this.watcher?.close()
    this.dir = join(vaultRoot, '90_产物')
    await fs.mkdir(this.dir, { recursive: true })
    this.watcher = chokidar.watch(this.dir, {
      ignored: /(^|\/)\./,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 200 },
    })
    this.watcher.on('add', (p: string) => {
      this.win?.webContents.send('artifact:created', { path: relative(this.dir!, p), name: basename(p) })
      notifyDingtalk('artifact', 'mcn-ai 产物', `### 新产物生成 📄\n\n**${basename(p)}**\n\n> ${new Date().toLocaleString('zh-CN')} · mcn-ai 自动化`)
    })
  }

  async list(): Promise<Artifact[]> {
    if (!this.dir) return []
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

  async open(relPath: string): Promise<void> {
    if (!this.dir) return
    await shell.openPath(join(this.dir, relPath))
  }

  async readText(relPath: string): Promise<string> {
    if (!this.dir) throw new Error('未就绪')
    return fs.readFile(join(this.dir, relPath), 'utf-8')
  }
}

export const artifactsWatcher = new ArtifactsWatcher()
