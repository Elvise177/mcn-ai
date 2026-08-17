import { spawn, type ChildProcess } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join, basename } from 'path'
import { type BrowserWindow } from 'electron'
import chokidar, { FSWatcher } from 'chokidar'
import { store, getLlmKey } from '../store'
import { vaultManager } from '../vault'
import { ingestNote } from '../knowledge/client'
import { getAccessToken } from '../auth'
import { pipelineBin } from '../lib/pipeline'
import { log } from '../lib/logger'
import { notifyDingtalk } from '../lib/dingtalk'
import { tasks } from '../tasks/registry'
import { appendUsage } from '../usage'
import { INBOX_FLOW, type InboxEvent, type InboxTask } from '../tasks/types'
import { getLastInboxRun, setLastInboxRun } from '../tasks/persist'

export type { InboxEvent }

/** 投递箱编排：监听 inbox 目录 → 去抖合并 → 串行 spawn 冻结版 pipeline → 进度转 IPC */
export class InboxOrchestrator {
  private win: BrowserWindow | null = null
  private watcher: FSWatcher | null = null
  private vaultRoot: string | null = null
  private inboxDir: string | null = null
  private running = false
  private rerun = false
  private debounce: ReturnType<typeof setTimeout> | null = null
  /** 最近一次运行的阶段记录，任务对象的 stages 从这里来 */
  private stages: InboxEvent[] = []
  /** 本轮收到的文件名（钉钉通知用），run-end 后清空 */
  private runFiles: string[] = []
  /**
   * 当前 pipeline 子进程。**必须是实例字段**：以前它是 run() 里 Promise 内的局部变量，
   * 外面拿不到句柄 = 没有任何 kill 入口（审计 H-13），退出应用还会留下孤儿进程
   */
  private child: ChildProcess | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  /** 本轮是被谁停的。非 null 时终态是 canceled 而不是 failed */
  private canceledBy: 'user' | 'quit' | null = null

  attachWindow(win: BrowserWindow): void {
    this.win = win
  }

  private send(ev: InboxEvent): void {
    if (ev.type === 'run-start') this.stages = []
    if (ev.type === 'stage') {
      this.stages.push(ev)
      if (ev.status === 'error') log('error', 'inbox', `${ev.stage}: ${ev.message}`)
    }
    this.toTask(ev)
  }

  private get taskId(): string {
    return `inbox:${this.vaultRoot ?? ''}`
  }

  /** 进度分母在主进程算，渲染层不再自己拼（同一句话要在全局条和面板里一致） */
  private computeProgress(): { done: number; total: number; label: string } {
    let done = 0
    let label = ''
    for (const ev of this.stages) {
      if (ev.type !== 'stage' || !ev.stage) continue
      const i = INBOX_FLOW.findIndex(([k]) => k === ev.stage)
      if (i < 0) continue
      done = Math.max(done, i + 1)
      label = INBOX_FLOW[i][1]
    }
    return { done, total: INBOX_FLOW.length, label: label || '准备中' }
  }

  /** 把阶段事件翻译成任务状态。任务是唯一真相源，legacy 事件只是它的副本 */
  private toTask(ev: InboxEvent): void {
    const id = this.taskId
    const cur = tasks.get(id)
    const live = cur && (cur.status === 'queued' || cur.status === 'running')

    if (ev.type === 'file-added') {
      // watcher 收到文件 → 3 秒去抖窗口内先挂一个 queued，用户立刻看得见"收下了"
      if (!live) {
        tasks.start({
          id,
          kind: 'inbox',
          key: this.vaultRoot ?? '',
          status: 'queued',
          title: '投递箱已收到文件',
          // 3 秒去抖窗口内也能取消（那会儿还没 spawn，取消 = 撤掉这轮调度）
          cancelable: true,
          files: ev.file ? [ev.file] : [],
          stages: [],
        })
      } else {
        const files = [...(cur as InboxTask).files, ev.file ?? ''].filter(Boolean)
        tasks.patch(id, { files, title: `投递箱已收到 ${files.length} 个文件` } as Partial<InboxTask>)
      }
      return
    }

    if (ev.type === 'run-start') {
      const files = live ? (cur as InboxTask).files : []
      tasks.start({
        id,
        kind: 'inbox',
        key: this.vaultRoot ?? '',
        status: 'running',
        title: '投递箱处理中',
        cancelable: true,
        files,
        stages: [],
        progress: { done: 0, total: INBOX_FLOW.length, label: '准备中' },
      })
      return
    }

    if (ev.type === 'stage') {
      if (!live) return
      tasks.patch(id, {
        stages: [...this.stages],
        progress: this.computeProgress(),
        ...(ev.status === 'error' ? { error: `${ev.stage}: ${ev.message ?? '失败'}` } : {}),
      } as Partial<InboxTask>)
      return
    }

    if (ev.type === 'run-end') {
      const canceled = this.canceledBy
      const progress = this.computeProgress()
      tasks.patch(id, {
        stages: [...this.stages],
        progress,
        pid: undefined,
        cancelable: false,
        canceled: canceled ?? undefined,
        // 取消不是出错：把中途 stage 留下的 error 抹掉，面板/全局条才不会画成红色
        ...(canceled ? { error: undefined } : {}),
        title: canceled
          ? `已停止（本轮处理到 ${progress.done}/${progress.total}，已完成的部分已保留）`
          : ev.ok
            ? '投递箱处理完成'
            : '投递箱处理失败',
      } as Partial<InboxTask>)
      // 用户主动停的是 canceled 不是 failed——主动操作不该看起来像出错（设计 §5.1）
      tasks.finish(id, canceled ? 'canceled' : ev.ok ? 'succeeded' : 'failed')
      // 「进行中」永不落盘，落的只有这一条终态结果（重启后面板仍能看到上次结果）
      setLastInboxRun({
        endedAt: Date.now(),
        ok: !!ev.ok,
        canceled: !!canceled,
        files: [...((tasks.get(id) as InboxTask | undefined)?.files ?? [])],
        stages: [...this.stages],
      })
    }
  }

  /** 重启后把上一轮结果塞回 recent —— 面板上仍能看到「上次 6/6 完成」 */
  private seedFromDisk(): void {
    const r = getLastInboxRun()
    if (!r) return
    this.stages = r.stages
    tasks.seedRecent({
      id: this.taskId,
      kind: 'inbox',
      key: this.vaultRoot ?? '',
      status: r.canceled ? 'canceled' : r.ok ? 'succeeded' : 'failed',
      title: r.canceled ? '上次投递被停止' : r.ok ? '上次投递处理完成' : '上次投递处理失败',
      canceled: r.canceled ? 'user' : undefined,
      startedAt: r.endedAt,
      endedAt: r.endedAt,
      cancelable: false,
      seq: 0,
      files: r.files,
      stages: r.stages,
      progress: this.computeProgress(),
    })
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

  private seeded = false

  private async doConfigure(vaultRoot: string): Promise<string> {
    await this.stop()
    this.vaultRoot = vaultRoot
    if (!this.seeded) {
      this.seeded = true
      this.seedFromDisk()
    }
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

  /** 退出前的清理入口：有没有还活着的 pipeline */
  hasChild(): boolean {
    return !!this.child?.pid
  }

  /**
   * 杀掉整个 pipeline **进程组**（设计 §5.1）。
   *
   * `child.kill()` 只杀直接子进程：spawn 起的是 PyInstaller onedir 的引导程序，
   * 真正干活的 Python 是它 fork 出来的孙子进程，会变成孤儿继续写 vault、继续烧 LLM 额度，
   * 而 UI 已经显示"已停止"——比不做取消更糟。所以 spawn 时加 detached:true 让子进程成为
   * 新进程组的组长（组 id == child.pid），这里用负号杀整组。
   */
  private killGroup(reason: 'user' | 'quit'): void {
    const pgid = this.child?.pid
    if (!pgid) return
    this.canceledBy = reason
    this.rerun = false // 停了就别接着排下一轮
    try {
      process.kill(-pgid, 'SIGTERM')
      log('info', 'inbox', `已 SIGTERM 进程组 ${pgid}（${reason}）`)
    } catch (e) {
      // ESRCH = 进程组正好在这一刻自己退了，当成已停止
      log('warn', 'inbox', `SIGTERM 进程组 ${pgid} 失败：${e}`)
    }
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = setTimeout(() => {
      try {
        process.kill(-pgid, 'SIGKILL')
        log('warn', 'inbox', `进程组 ${pgid} 3 秒未退，已 SIGKILL`)
      } catch {
        /* 已经退了 */
      }
    }, 3000)
    this.killTimer.unref?.()
  }

  /**
   * 取消当前这一轮投递。**不做回滚**：pipeline 已经落位的 md、已经写的 .done 标记全部保留
   * ——回滚意味着删用户 vault 里的文件，风险远大于收益。未处理的文件仍在投递箱里，
   * 下次「立即处理」会接着做。
   */
  async cancel(reason: 'user' | 'quit' = 'user'): Promise<boolean> {
    // 还在 3 秒去抖窗口里、pipeline 没起来：撤掉这轮调度即可
    if (!this.child) {
      if (this.debounce) {
        clearTimeout(this.debounce)
        this.debounce = null
      }
      const t = tasks.get(this.taskId)
      if (!t || (t.status !== 'queued' && t.status !== 'running')) return false
      this.rerun = false
      tasks.patch(this.taskId, {
        canceled: reason,
        cancelable: false,
        title: '已取消本轮投递（文件仍在投递箱里）',
      } as Partial<InboxTask>)
      tasks.finish(this.taskId, 'canceled')
      return true
    }
    const child = this.child
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    this.killGroup(reason)
    // SIGKILL 在 3 秒时补刀，这里再多给 1 秒兜底，之后无论如何都返回
    await Promise.race([closed, new Promise((r) => setTimeout(r, 4000))])
    return true
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

  /** 本轮跑完的回调（产物入库任务靠它知道自己成没成——ingest 的 running 阶段由某个 inbox run 承载） */
  private runEndCbs: Array<(ok: boolean, canceled: boolean) => void> = []
  onRunEnd(cb: (ok: boolean, canceled: boolean) => void): void {
    this.runEndCbs.push(cb)
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

      // A-8：带 `sensitive: true` 的笔记不进云端（除非用户在设置里开了第三档）。
      // 标记由 09_pii_guard 写进 frontmatter——不读 pipeline 的 .checkpoint.jsonl，
      // 那是它的内部文件，让主进程去读是错误的依赖方向
      const allowCloud = store.get('sensitiveAllowCloud')
      const isSensitive = (rel: string): boolean =>
        vaultManager.noteAt(rel)?.frontmatter?.sensitive === true
      const held = allowCloud ? [] : changed.filter(isSensitive)
      const toPush = allowCloud ? changed : changed.filter((r) => !isSensitive(r))

      let synced = 0
      for (const rel of toPush.slice(0, 50)) {
        const r = await ingestNote(rel)
        if (r.ok && !r.skipped) synced++
      }
      // 「N 篇未同步」单说会让人以为同步坏了、去查网络——而那 M 篇是按他自己的设置刻意不传的
      const holdNote = held.length ? `，其中 ${held.length} 篇为敏感文件，按设置仅存本地` : ''
      const truncated = Math.max(0, toPush.length - 50)
      const truncNote = truncated ? `，另有 ${truncated} 篇待同步（单轮上限 50）` : ''
      this.send({ type: 'stage', stage: 'cloud_sync', status: 'ok', message: `${synced} 篇上云${holdNote}${truncNote}` })
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
    this.canceledBy = null
    const runStart = Date.now()
    this.send({ type: 'run-start' })

    const llmKey = getLlmKey()
    const args = ['--vault', this.vaultRoot, '--max-cost', '10']
    // A-8 三态：默认敏感文件只走本地规则打标；用户在设置里明示后才允许发给模型
    if (store.get('sensitiveAllowAi')) args.push('--sensitive-allow-ai')
    if (llmKey) {
      args.push('--llm-key', llmKey, '--llm-base-url', store.get('llmBaseUrl'), '--llm-model', store.get('llmModel'))
    } else {
      args.push('--skip-llm')
    }

    const ok = await new Promise<boolean>((resolve) => {
      // detached:true → 子进程成为新进程组的组长（组 id == child.pid），取消时才能连孙子进程
      // 一起杀（见 killGroup）。**不调 unref()**：我们仍然要等它的 close 事件
      const child = spawn(pipelineBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      this.child = child
      // pid 进任务对象：取消入口与走查的进程组断言都靠它
      tasks.patch(this.taskId, { pid: child.pid, cancelable: true } as Partial<InboxTask>)
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
            this.send({
              type: 'stage',
              stage: ev.stage,
              status: ev.status,
              message: ev.message,
              pending: ev.pending,
              failed: ev.failed,
              unsupported: ev.unsupported,
              // 打标阶段若报了 token 用量就带上；pipeline 目前不报，那就只记次数（见下方 appendUsage）
              usage: ev.usage,
            })
          } catch {
            /* 非 JSON 行来自阶段脚本的中文日志，忽略 */
          }
        }
      })
      child.stderr.on('data', () => void 0)
      const settle = (v: boolean): void => {
        if (this.child === child) this.child = null
        if (this.killTimer) {
          clearTimeout(this.killTimer)
          this.killTimer = null
        }
        resolve(v)
      }
      child.on('close', (code) => settle(code === 0 && lastStatus === 'ok'))
      child.on('error', (err) => {
        this.send({ type: 'stage', stage: 'spawn', status: 'error', message: String(err) })
        settle(false)
      })
    })

    // 被停掉的那一轮不再上云：半截结果没必要推到云端，也别让用户多等一次网络往返
    if (ok && !this.canceledBy) await this.cloudSync(runStart)

    const canceled = !!this.canceledBy

    // 用量记账：智能打标是 pipeline 子进程里的 LLM 调用，绝大多数情况拿不到 token 数
    // ——那就**只记次数**（一轮一条），比"因为没有 usage 就不记"诚实得多
    if (llmKey && !canceled) {
      const tag = this.stages.find((s) => s.stage === 'tag_llm' && s.status !== 'skipped')
      if (tag) {
        appendUsage({
          ts: Date.now(),
          sessionId: `inbox:${this.vaultRoot ?? ''}`,
          taskType: 'ingest-tag',
          tier: null, // 入库打标不经档位层，走的是 llmBaseUrl/llmModel 那条独立线路
          expected_model: store.get('llmModel'),
          resolved_model: null,
          durationMs: Date.now() - runStart,
          usage: tag.usage ?? null,
          calls: 1,
        })
      }
    }

    this.send({ type: 'run-end', ok })
    for (const cb of this.runEndCbs) {
      try {
        cb(ok, canceled)
      } catch (e) {
        log('error', 'inbox', `run-end 回调失败: ${e}`)
      }
    }
    // 用户自己停的不推钉钉——那是他刚做的动作，不是需要被通知的事件
    if (!canceled) {
      const files = this.runFiles.splice(0)
      const fileLine = files.length ? `\n\n处理文件：${files.slice(0, 8).join('、')}${files.length > 8 ? ` 等${files.length}个` : ''}` : ''
      notifyDingtalk(
        'inbox',
        'mcn-ai 投递箱',
        `### 投递箱处理${ok ? '完成 ✅' : '失败 ❌'}${fileLine}\n\n> ${new Date().toLocaleString('zh-CN')} · mcn-ai 自动化`
      )
    } else {
      this.runFiles.length = 0
    }
    this.running = false
    // 取消之后不接着排下一轮：文件还在投递箱里，等用户自己点「立即处理」
    if (this.rerun && !canceled) {
      this.rerun = false
      this.schedule()
    }
    this.rerun = false
  }
}

export const inboxOrchestrator = new InboxOrchestrator()

