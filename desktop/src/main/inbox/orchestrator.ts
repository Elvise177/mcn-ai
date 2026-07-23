import { spawn } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join, basename } from 'path'
import { app, type BrowserWindow } from 'electron'
import chokidar, { FSWatcher } from 'chokidar'
import { store, getLlmKey } from '../store'
import { ingestNote } from '../knowledge/client'
import { getAccessToken } from '../auth'
import { pipelineBin } from '../lib/pipeline'
import { log } from '../lib/logger'
import { notifyDingtalk } from '../lib/dingtalk'

export interface InboxEvent {
  type: 'file-added' | 'run-start' | 'stage' | 'run-end'
  stage?: string
  status?: string
  message?: string
  pending?: number
  file?: string
  ok?: boolean
}

/** 投递箱编排：监听 inbox 目录 → 去抖合并 → 串行 spawn 冻结版 pipeline → 进度转 IPC */
export class InboxOrchestrator {
  private win: BrowserWindow | null = null
  private watcher: FSWatcher | null = null
  private vaultRoot: string | null = null
  private inboxDir: string | null = null
  private running = false
  private rerun = false
  private debounce: ReturnType<typeof setTimeout> | null = null
  /** 最近一次运行的阶段记录，UI 恢复用 */
  lastRun: InboxEvent[] = []
  /** 本轮收到的文件名（钉钉通知用），run-end 后清空 */
  private runFiles: string[] = []

  attachWindow(win: BrowserWindow): void {
    this.win = win
  }

  private send(ev: InboxEvent): void {
    if (ev.type === 'run-start') this.lastRun = []
    if (ev.type === 'stage') {
      this.lastRun.push(ev)
      if (ev.status === 'error') log('error', 'inbox', `${ev.stage}: ${ev.message}`)
    }
    this.win?.webContents.send('inbox:event', ev)
  }

  private configuring: Promise<string> | null = null

  /** 打开 vault 后调用：定位投递箱目录并开始监听。
      同一库重复调用直接复用（切页面会反复触发，叠加 watcher 曾导致事件重复 N 份） */
  configure(vaultRoot: string): Promise<string> {
    if (this.vaultRoot === vaultRoot && this.watcher && this.inboxDir) {
      return Promise.resolve(basename(this.inboxDir))
    }
    if (this.configuring) return this.configuring
    this.configuring = this.doConfigure(vaultRoot).finally(() => {
      this.configuring = null
    })
    return this.configuring
  }

  private async doConfigure(vaultRoot: string): Promise<string> {
    await this.stop()
    this.vaultRoot = vaultRoot
    let inboxName = '00_投递箱'
    try {
      const layout = JSON.parse(await fs.readFile(join(vaultRoot, '.mcnai', 'layout.json'), 'utf-8'))
      if (layout.inbox) inboxName = layout.inbox
    } catch {
      if (existsSync(join(vaultRoot, '95_待入库'))) inboxName = '95_待入库'
    }
    this.inboxDir = join(vaultRoot, inboxName)
    await fs.mkdir(this.inboxDir, { recursive: true })

    this.watcher = chokidar.watch(this.inboxDir, {
      ignored: [/\.done/, /\.failed/, /(^|\/)\./],
      ignoreInitial: false, // 启动时投递箱里已有的文件也要处理
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
    })
    this.watcher.on('add', (p: string) => {
      // 同名文件 5 秒内只报一次（兜底防抖）
      const name = basename(p)
      const now = Date.now()
      const last = this.recentFiles.get(name) ?? 0
      this.recentFiles.set(name, now)
      if (now - last > 5000) {
        this.send({ type: 'file-added', file: name })
        this.runFiles.push(name)
      }
      this.schedule()
    })
    return inboxName
  }

  private recentFiles = new Map<string, number>()

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    if (this.debounce) clearTimeout(this.debounce)
  }

  /** 拖拽/批量导入入口：拷贝进投递箱，watcher 自然接管 */
  async enqueue(paths: string[], subdir?: string): Promise<number> {
    if (!this.inboxDir) throw new Error('投递箱未就绪，请先打开知识库')
    const destDir = subdir ? join(this.inboxDir, subdir.replace(/[\\:*?"<>|.]/g, '')) : this.inboxDir
    await fs.mkdir(destDir, { recursive: true })
    let n = 0
    for (const p of paths) {
      try {
        const st = await fs.stat(p)
        if (st.isDirectory()) {
          for (const f of await fs.readdir(p)) {
            const src = join(p, f)
            if ((await fs.stat(src)).isFile() && !f.startsWith('.')) {
              await fs.copyFile(src, join(destDir, f))
              n++
            }
          }
        } else if (!basename(p).startsWith('.')) {
          await fs.copyFile(p, join(destDir, basename(p)))
          n++
        }
      } catch (e) {
        this.send({ type: 'stage', stage: 'enqueue', status: 'error', message: `${basename(p)}: ${e}` })
      }
    }
    return n
  }

  /** 多文件拖入 3 秒内合并为一次 pipeline 运行 */
  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.run(), 3000)
  }

  /** 入库成功后：本轮修改过的 md 上云（私人层）。未登录直接跳过 */
  private async cloudSync(sinceMs: number): Promise<void> {
    if (!this.vaultRoot) return
    if (!(await getAccessToken())) {
      this.send({ type: 'stage', stage: 'cloud_sync', status: 'skipped', message: '未登录' })
      return
    }
    try {
      const { promises: fsp } = await import('fs')
      const { join: pjoin, relative } = await import('path')
      const changed: string[] = []
      const walk = async (d: string): Promise<void> => {
        for (const e of await fsp.readdir(d, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue
          const p = pjoin(d, e.name)
          if (e.isDirectory()) await walk(p)
          else if (e.name.endsWith('.md')) {
            const st = await fsp.stat(p)
            if (st.mtimeMs > sinceMs - 60_000) changed.push(relative(this.vaultRoot!, p))
          }
        }
      }
      await walk(this.vaultRoot)
      let synced = 0
      for (const rel of changed.slice(0, 50)) {
        const r = await ingestNote(rel)
        if (r.ok && !r.skipped) synced++
      }
      this.send({ type: 'stage', stage: 'cloud_sync', status: 'ok', message: `${synced} 篇上云` })
    } catch (e) {
      this.send({ type: 'stage', stage: 'cloud_sync', status: 'error', message: String(e) })
    }
  }

  async run(): Promise<void> {
    if (!this.vaultRoot) return
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    const runStart = Date.now()
    this.send({ type: 'run-start' })

    const llmKey = getLlmKey()
    const args = ['--vault', this.vaultRoot, '--max-cost', '10']
    if (llmKey) {
      args.push('--llm-key', llmKey, '--llm-base-url', store.get('llmBaseUrl'), '--llm-model', store.get('llmModel'))
    } else {
      args.push('--skip-llm')
    }

    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(pipelineBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let buf = ''
      let lastStatus = 'ok'
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString()
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('{')) continue
          try {
            const ev = JSON.parse(line)
            if (ev.stage === 'done') lastStatus = ev.status
            this.send({ type: 'stage', stage: ev.stage, status: ev.status, message: ev.message, pending: ev.pending })
          } catch {
            /* 非 JSON 行来自阶段脚本的中文日志，忽略 */
          }
        }
      })
      child.stderr.on('data', () => void 0)
      child.on('close', (code) => resolve(code === 0 && lastStatus === 'ok'))
      child.on('error', (err) => {
        this.send({ type: 'stage', stage: 'spawn', status: 'error', message: String(err) })
        resolve(false)
      })
    })

    if (ok) await this.cloudSync(runStart)

    this.send({ type: 'run-end', ok })
    {
      const files = this.runFiles.splice(0)
      const fileLine = files.length ? `\n\n处理文件：${files.slice(0, 8).join('、')}${files.length > 8 ? ` 等${files.length}个` : ''}` : ''
      notifyDingtalk(
        'inbox',
        'mcn-ai 投递箱',
        `### 投递箱处理${ok ? '完成 ✅' : '失败 ❌'}${fileLine}\n\n> ${new Date().toLocaleString('zh-CN')} · mcn-ai 自动化`
      )
    }
    this.running = false
    if (this.rerun) {
      this.rerun = false
      this.schedule()
    }
  }
}

export const inboxOrchestrator = new InboxOrchestrator()

