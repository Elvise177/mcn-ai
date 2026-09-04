import { spawn, type ChildProcess } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join, basename, extname, dirname } from 'path'
import { shell } from 'electron'
import chokidar, { FSWatcher } from 'chokidar'
import { store, getLlmKey } from '../store'
import { buildEntityCards } from '../vault/entity-cards'
import { readVaultConfig } from '../vault/taxonomy'
import { ingestNote } from '../knowledge/client'
import { getAccessToken } from '../auth'
import { pipelineBin, pipelineArgs, pipelineEnv } from '../lib/pipeline'
import { log } from '../lib/logger'
import { hasSensitiveMark } from '../lib/sensitive'
import { notifyDingtalk } from '../lib/dingtalk'
import { notify } from '../lib/notify'
import { tasks } from '../tasks/registry'
import { appendUsage } from '../usage'
import {
  INBOX_FLOW,
  computeInboxProgress,
  judgeBackfill,
  type BackfillVerdict,
  type InboxEvent,
  type InboxTask,
} from '../tasks/types'
import {
  dropNoteSyncFailure,
  getLastInboxRun,
  pendingSyncTotal,
  pushNoteSyncFailure,
  setLastInboxRun,
} from '../tasks/persist'

export type { InboxEvent }

/**
 * 能入库的扩展名。定义搬到了 `lib/supported-ext.ts`（desktop 侧唯一一份，R7），这里只是转出口，
 * 老的 import 路径不用改。
 *
 * 之所以在拷进投递箱之前就筛：不支持的格式拷进去也没人处理，
 * `02_convert` 连 fail 都不算（只有认识的扩展名转换失败才进 `.failed/`），
 * 结果就是一堆原件永远躺在投递箱里，而用户以为入库了。
 */
export { SUPPORTED_EXT } from '../lib/supported-ext'
import { SUPPORTED_EXT } from '../lib/supported-ext'
import { TailBuffer } from '../lib/tail-buffer'

/** 与 `02_convert.py` 的 `JUNK_DIRS` 对齐 */
const JUNK_DIRS = new Set(['node_modules', 'venv', '.venv', '.git', '__MACOSX', '__pycache__'])


/**
 * 递归护栏。整包拖入是「用户一个动作、后台跑很久」的操作，没有上限的话
 * 拖错一个目录（比如家目录）就是几万个文件，且中途没有任何出口。
 *
 * - **单次 500**：真正防跑飞的是这一条。Maggie 那份 98 个文件，500 够日常整包导入，超了提示分批
 * - **深度 10**：原定 6，实测改的——Maggie 全量最深正好 **6 层**，卡在 6 等于零余量，
 *   客户目录再深一级就**静默丢文件**，而这正是 A-1 要根治的那类故障。
 *   深度不是防跑飞的有效闸门（拖家目录是被文件数拦住的，不是被深度），
 *   所以这里给足余量，把「别丢用户的文件」放在前面
 */
const MAX_DEPTH = 10
const MAX_FILES = 500

/** `enqueue` 的结果。**不能只回一个数字**——「0 个」和「跳过了 20 个不支持的格式」得分得开 */
export interface EnqueueResult {
  /** 真正拷进投递箱的文件数 */
  added: number
  /** 扩展名不在 `SUPPORTED_EXT` 里 */
  skippedUnsupported: number
  /** 隐藏文件/目录、Office 锁文件（`~$`）、空文件、垃圾目录 */
  skippedJunk: number
  /** 因为超过 `MAX_DEPTH` 而没有进去的目录数 */
  depthExceeded: number
  /** 撞上 `MAX_FILES` 被截断（true 时 `added === MAX_FILES`） */
  truncated: boolean
}

/** 投递箱编排：监听 inbox 目录 → 去抖合并 → 串行 spawn 冻结版 pipeline → 进度转 IPC */
export class InboxOrchestrator {
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
  private canceledBy: 'user' | 'quit' | 'switch' | null = null
  /**
   * 上一轮是被用户停掉的、而且没跑完 → 「立即处理」必须放行，哪怕投递箱是空的。
   *
   * **这是 2026-08-19 我自己引入的回归**：为了修「空投递箱点立即处理会默默跑全库」，
   * 我加了一道"投递箱空就拒绝"的闸门，结果把**取消后接着做**这条路一起堵死了——
   * 而取消提示写的正是「点『立即处理』可接着做」。
   * 客户实测：停在 PII守卫（2/8）后点立即处理，报"没有文件要处理"。
   * 真相是文件在更早的「转换」阶段就已经进 `.done/` 了，剩下没跑完的是**对全库跑的阶段**。
   */
  private canceledIncomplete = false

  /** 保留签名给调用方。**这里本来就不发下行事件**（投递箱状态一律走任务层），
      所以它现在是空的——留着只是为了 `createWindow()` 那一串调用整齐 */
  attachWindow(): void {}

  /**
   * `id` 是这一轮开始时快照下来的任务 id（R2）：换库后 `this.taskId` 已经指向新库，
   * 旧轮次的尾段事件（run-end）不传快照就会 patch 到新库的任务上。不传 = 当前库（watcher 事件用）。
   */
  private send(ev: InboxEvent, id?: string): void {
    if (ev.type === 'run-start') this.stages = []
    if (ev.type === 'stage') {
      this.stages.push(ev)
      if (ev.status === 'error') log('error', 'inbox', `${ev.stage}: ${ev.message}`)
    }
    this.toTask(ev, id)
  }

  private get taskId(): string {
    return `inbox:${this.vaultRoot ?? ''}`
  }

  /** 进度分母在主进程算，渲染层不再自己拼（同一句话要在全局条和面板里一致） */
  /**
   * 打标的篇级进度（B3c）。**没有它，界面在这一步会十几分钟一动不动**——
   * 客户实测：投 14 个文件，面板停在「PII守卫 2/8」十分钟没变，
   * 而后台其实一直在稳步打标，只是没人报进度，看着就是死机。
   */
  private tagProgress: { done: number; total: number } | null = null

  /** 进度计算在 `tasks/types.ts` 的纯函数里（抽出去是为了能零花费测，见那边的注释） */
  private computeProgress(): { done: number; total: number; label: string } {
    return computeInboxProgress(this.stages, this.tagProgress)
  }

  /** 把阶段事件翻译成任务状态。任务是唯一真相源，legacy 事件只是它的副本 */
  private toTask(ev: InboxEvent, id: string = this.taskId): void {
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
        key: id.replace(/^inbox:/, ''),
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
          ? canceled === 'switch'
            ? `已停止上一库的入库（处理到 ${progress.done}/${progress.total}，已完成的部分已保留）`
            : `已停止（本轮处理到 ${progress.done}/${progress.total}，已完成的部分已保留）`
          : ev.ok
            ? '投递箱处理完成'
            : '投递箱处理失败',
      } as Partial<InboxTask>)
      // 被用户停掉 = 还有活没干完，「立即处理」得能接着做（见 canceledIncomplete 的注释）。
      // 跑到自然结束（不论成败）就把这个标记清掉——那时投递箱空就是真的没事可做了
      this.canceledIncomplete = canceled === 'user'
      /**
       * 「未处理的文件仍在投递箱里」这句话**不一定成立**——文件在「转换」阶段就已经进了
       * `.done/`，停在后面那些**对全库跑的**阶段时投递箱其实是空的（客户 2026-08-19 实测：
       * 停在 PII守卫 后点立即处理，被告知"没有文件要处理"，而提示语刚说过"仍在投递箱里"）。
       * 说错话比不说更糟，所以数一遍再决定怎么说。`toTask` 是同步的，这里异步补后半句。
       */
      if (canceled === 'user') {
        const base = `已停止（本轮处理到 ${progress.done}/${progress.total}，已完成的部分已保留）`
        void this.pendingCount()
          .then((n) => {
            tasks.patch(id, {
              title: base + (n > 0 ? `；还有 ${n} 个文件没处理` : '；剩余的整理步骤没跑完'),
            } as Partial<InboxTask>)
          })
          .catch(() => {})
      }
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

  /**
   * 在访达里打开最近一次的 `.failed/` 目录（0.1.2）。
   *
   * **磁盘上那份 `失败原因.txt` 才是持久记录**——投递箱面板会自动收起、
   * 应用也会重启，而"哪些文件没进来、为什么"是用户过几天还要回头查的东西。
   * 界面上的清单只是它的快捷入口，真相在盘上。
   */
  async openFailedDir(): Promise<{ ok: boolean; error?: string }> {
    if (!this.inboxDir) return { ok: false, error: '还没有打开知识库' }
    const root = join(this.inboxDir, '.failed')
    if (!existsSync(root)) return { ok: false, error: '还没有失败记录' }
    // 取最新的那一天（目录名是 YYYYMMDD）
    const days = (await fs.readdir(root)).filter((d) => /^\d{8}$/.test(d)).sort()
    const target = days.length ? join(root, days[days.length - 1]) : root
    const reason = join(target, '失败原因.txt')
    // 有原因文件就选中它——直接把人带到那句话上，而不是丢进一个文件夹里自己找
    if (existsSync(reason)) shell.showItemInFolder(reason)
    else shell.showItemInFolder(target)
    return { ok: true }
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
    // 配置只从 taxonomy 这一个入口读（老库探测、逐字段兜底都在里面，与 pipeline 同一套判据）
    const inboxName = (await readVaultConfig(vaultRoot)).inbox
    this.inboxDir = join(vaultRoot, inboxName)
    await fs.mkdir(this.inboxDir, { recursive: true })

    this.watcher = chokidar.watch(this.inboxDir, {
      ignored: [/\.done/, /\.failed/, /(^|\/)\./],
      ignoreInitial: false, // 启动时投递箱里已有的文件也要处理
      // 跟 enqueue 的递归上限对齐：原来钉死 3，而整包拖入后文件可以深到 6 层，
      // 深层文件不触发 'add' → 界面上的文件名列表会缺一大块
      // （跑不跑得起来另有保障：enqueue 拷完会自己 schedule）
      depth: MAX_DEPTH,
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

  /**
   * 上一次 `stop()` 是否真的停掉了一轮在跑的 pipeline。`openVault` 换库成功后取走它，
   * 决定要不要 toast「已停止上一库的入库」——取走即清。
   */
  private stoppedForSwitch = false
  takeStoppedForSwitch(): boolean {
    const v = this.stoppedForSwitch
    this.stoppedForSwitch = false
    return v
  }

  /**
   * 换库 / 退出前停下这个库上的一切（PLAN-v2 R2，销掉 HANDOFF §3 bug#10）。
   *
   * 以前这里**只关 watcher**：在跑的 pipeline 不杀、`running` 不重置。换库之后旧 pipeline
   * 继续写旧库、烧额度，`run()` 尾段又按 getter 读到**新库**的 taskId 去 patch——
   * 这就是「同库两个 mcn-ingest / before-quit 只杀得掉一个」的机制。
   * 现在：先关 watcher（别再收新文件）→ 撤掉去抖调度 → 有 child 就 kill 整个进程组并等它退（≤4s）
   * → 重置 running/rerun。顺序固定，别调换。
   */
  async stop(reason: 'switch' | 'quit' = 'switch'): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    if (this.debounce) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
    this.rerun = false
    if (this.child) {
      log('info', 'inbox', `${reason === 'switch' ? '换库' : '退出'}时投递箱还在跑，先停掉这一轮`)
      await this.cancel(reason)
      if (reason === 'switch') this.stoppedForSwitch = true
    }
    // 兜底：cancel 等到 close 后 run() 的尾段会自己把 running 放掉；万一 4 秒兜底先到（进程没退干净），
    // 也不能让下一个库的 run() 被一个已经不属于它的 running 挡住
    this.running = false
  }

  /**
   * 投递箱里还有几个待处理的文件（`.done`/`.failed` 与隐藏文件不算）。
   *
   * 「立即处理」以前不看这个数直接把 pipeline 拉起来，而 pipeline 的后半段
   * （实体建卡 / MOC 重建 / 主题索引）是**对全库跑的**——于是空投递箱点一下
   * 就是"把整个库重过一遍"：白等几分钟、可能烧打标额度，界面上还只显示一条进度条，
   * 用户完全看不出其实没有新东西。客户 2026-08-19 实测提的就是这个。
   */
  async pendingCount(): Promise<number> {
    if (!this.inboxDir) return 0
    let n = 0
    const walk = async (d: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(d, { withFileTypes: true })
      } catch {
        return // 目录还没建 / 读不了：当作没有待处理
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue // .done / .failed / .DS_Store 都在这儿被排除
        if (e.isDirectory()) await walk(join(d, e.name), depth + 1)
        else n++
      }
    }
    await walk(this.inboxDir, 0)
    return n
  }

  /**
   * 还有多少篇笔记的标签是旧版本生成的（B3b）。零 LLM、零写盘，几十毫秒。
   *
   * 拆出来的理由：以前"全库补齐"是搭在**随便哪次入库**上的——用户投 1 个文件，
   * 后台却在补打标上百篇旧笔记，十分钟不动（客户实测原话：「入库1个文件都要这么久」）。
   * 现在常规入库只打本批（`03_tag_llm --files`），补齐由用户显式发起。
   */
  async staleTagCount(): Promise<number> {
    if (!this.vaultRoot) return 0
    return new Promise((resolve) => {
      const child = spawn(pipelineBin(), ['--vault', this.vaultRoot!, '--count-stale', '--skip-llm'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let buf = ''
      child.stdout.on('data', (d: Buffer) => (buf += d.toString()))
      child.on('close', () => {
        for (const line of buf.split('\n')) {
          if (!line.trim().startsWith('{')) continue
          try {
            const ev = JSON.parse(line)
            if (ev.stage === 'tag_stale') return resolve(Number(ev.stale) || 0)
          } catch {
            /* 不是我们要的那行 */
          }
        }
        resolve(0)
      })
      child.on('error', () => resolve(0))
    })
  }

  /**
   * 全库补齐（B3b）：把还没达到当前 schema 的笔记补打一遍。
   * **用户显式发起**，作为一条独立任务跑，不挡入库、可取消（复用同一套 kill 进程组）。
   */
  async runTagBackfill(): Promise<BackfillVerdict> {
    /**
     * **不许再静默 return**（0.1.2）。这三个前提原来是三行裸 `return`，
     * 一句日志都不落、一个事件都不发——用户点了「现在升级」界面毫无变化，
     * 真实客户卡在这儿问我们是不是坏了。判据抽进 `judgeBackfill`（纯函数，可零花费测），
     * 结果一路返回到渲染层弹 toast。
     */
    const llmKey = getLlmKey()
    const staleNow = this.vaultRoot ? await this.staleTagCount() : 0
    const verdict = judgeBackfill({
      vaultRoot: this.vaultRoot,
      running: this.running,
      hasKey: !!llmKey,
      staleCount: staleNow,
    })
    if (!verdict.ok) {
      log('info', 'inbox', `打标补齐没有开始：${verdict.reason} —— ${verdict.message}`)
      return verdict
    }
    this.running = true
    this.tagProgress = null
    const id = this.taskId
    tasks.start({
      id,
      kind: 'inbox',
      // 同上：no-vault 已经被 judgeBackfill 挡掉了，TS 跟不过来这层保证
      key: this.vaultRoot!,
      status: 'running',
      title: '正在升级旧笔记的标签',
      cancelable: true,
      files: [],
      stages: [],
      // 分母一开始就给真数：停在「准备中 0/1」和"没反应"在用户眼里是一回事。
      // staleTagCount() 已经在 judgeBackfill 那步数过了，这里不再多跑一次子进程
      progress: { done: 0, total: staleNow, label: `准备升级 ${staleNow} 篇` },
    })
    const outcome = await new Promise<BackfillVerdict>((resolve) => {
      const child = spawn(
        pipelineBin(),
        [
          '--vault', this.vaultRoot!, '--tag-backfill', '--max-cost', '10',
          '--llm-base-url', store.get('llmBaseUrl'), '--llm-model', store.get('llmModel'),
        ],
        // key 走 env 不走 argv（R5）；llmKey 非空是 judgeBackfill 保证的
        { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: pipelineEnv(process.env, llmKey) }
      )
      this.child = child
      tasks.patch(id, { pid: child.pid, cancelable: true } as Partial<InboxTask>)
      let buf = ''
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString()
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line.startsWith('{')) continue
          try {
            const ev = JSON.parse(line)
            if (ev.status === 'progress' && ev.stage === 'tag_llm') {
              const done = Number(ev.done) || 0
              const total = Number(ev.total) || 1
              tasks.patch(id, {
                progress: { done, total, label: `已升级 ${done}/${total} 篇` },
              } as Partial<InboxTask>)
            }
          } catch {
            /* 忽略非 JSON 行 */
          }
        }
      })
      child.on('close', () => {
        this.child = null
        const canceled = this.canceledBy === 'user'
        tasks.patch(id, {
          pid: undefined,
          cancelable: false,
          title: canceled ? '标签升级已停止（已完成的部分保留，可再次开始）' : '旧笔记标签升级完成',
        } as Partial<InboxTask>)
        tasks.finish(id, canceled ? 'canceled' : 'succeeded')
        this.running = false
        this.canceledBy = null
        resolve({ ok: true, canceled, done: this.tagProgress?.done ?? 0 })
      })
      child.on('error', (e: Error) => {
        this.child = null
        // 起不来也要**响亮**：原来只 finish('failed')，任务条闪一下就没，用户什么都没看见
        const msg = e instanceof Error ? e.message : String(e)
        log('error', 'inbox', `打标补齐启动失败：${msg}`)
        tasks.patch(id, { title: `标签升级失败：${msg}` } as Partial<InboxTask>)
        tasks.finish(id, 'failed', msg)
        this.running = false
        resolve({ ok: true, failed: msg })
      })
    })
    return outcome
  }

  /** 上一轮是不是被用户停掉且没跑完（「立即处理」据此放行，见 canceledIncomplete） */
  hasUnfinishedWork(): boolean {
    return this.canceledIncomplete
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
  private killGroup(reason: 'user' | 'quit' | 'switch'): void {
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
  async cancel(reason: 'user' | 'quit' | 'switch' = 'user'): Promise<boolean> {
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
  /**
   * 把文件/目录收进投递箱。**目录递归，并原样保留相对子路径**（A-1，2026-08-18 补做）。
   *
   * 原实现只对目录做一层 `readdir` 且拍平：嵌套目录里的文件一个都进不来，
   * 而且返回 0 时界面完全静默——新客户把整个文件夹拖进来，界面毫无反应。
   *
   * **保留子路径不是锦上添花，是落位的全部依据**：pipeline 的 `03b_tag_rules` 用
   * `cat1 = rel.parts[0]`、`cat2 = rel.parts[1]` 推分类，而 `rel` 就是投递箱里的相对路径。
   * 拍平 = 所有笔记都掉进「未分类」。阶段一那 92/92 的落位一致率就是靠目录树来的。
   *
   * **拖入目录时，目录自己的名字不进路径**，只保留它内部的结构——
   * 与阶段一基线的口径一致（那轮是 `relative(源根, 叶子目录)` 逐个入箱）。
   * 反过来把目录名也算进去的话，`cat1` 会全变成那个文件夹名，92 篇的落位一次性作废。
   * 代价是：拖一个「里面全是文件、没有子目录」的文件夹，这些文件落在投递箱根 → 未分类。
   */
  async enqueue(paths: string[], subdir?: string): Promise<EnqueueResult> {
    if (!this.inboxDir) throw new Error('投递箱未就绪，请先打开知识库')
    const destDir = subdir ? join(this.inboxDir, subdir.replace(/[\\:*?"<>|.]/g, '')) : this.inboxDir
    await fs.mkdir(destDir, { recursive: true })

    const r: EnqueueResult = {
      added: 0,
      skippedUnsupported: 0,
      skippedJunk: 0,
      depthExceeded: 0,
      truncated: false,
    }
    const junkName = (name: string): boolean =>
      name.startsWith('.') || name.startsWith('~$') || JUNK_DIRS.has(name) || name.endsWith('.app')

    /** 拷一个文件，`rel` 是它相对投递箱落点的子路径（`''` 表示直接落在 destDir） */
    const takeFile = async (src: string, rel: string, size: number): Promise<void> => {
      const name = basename(src)
      if (junkName(name) || size === 0) {
        r.skippedJunk++
        return
      }
      if (!SUPPORTED_EXT.has(extname(name).toLowerCase())) {
        r.skippedUnsupported++
        return
      }
      if (r.added >= MAX_FILES) {
        r.truncated = true
        return
      }
      const dest = join(destDir, rel)
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.copyFile(src, dest)
      r.added++
    }

    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) {
        r.depthExceeded++
        return
      }
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (r.truncated) return
        const src = join(dir, e.name)
        if (e.isDirectory()) {
          if (junkName(e.name)) {
            r.skippedJunk++
            continue
          }
          await walk(src, join(rel, e.name), depth + 1)
        } else if (e.isFile()) {
          // 符号链接不跟随（`withFileTypes` 下 `isFile()` 对 symlink 为 false）：
          // 跟随的话一个指回上级的链接就能把递归拖进环里
          await takeFile(src, join(rel, e.name), (await fs.stat(src)).size)
        }
      }
    }

    for (const p of paths) {
      if (r.truncated) break
      try {
        const st = await fs.stat(p)
        if (st.isDirectory()) await walk(p, '', 1)
        else await takeFile(p, basename(p), st.size)
      } catch (e) {
        this.send({ type: 'stage', stage: 'enqueue', status: 'error', message: `${basename(p)}: ${e}` })
      }
    }

    /**
     * **不在这里 `schedule()`**，交给 watcher 踢。
     *
     * 一度加过一句 `if (r.added > 0) this.schedule()`，理由是「watcher 的 depth 够不到深层文件」。
     * 但 watcher 的 `depth` 已经跟 `MAX_DEPTH` 对齐，而 enqueue 写进去的东西又受同一个上限约束——
     * 它一定看得见，那句就是纯多余。代价却是实打实的：每次入箱多排一轮 pipeline，
     * 走查里直接把「退出应用后无孤儿进程」那条断言干挂了（同一个库上同时活着两个 mcn-ingest）。
     */
    return r
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

  /**
   * 实体建卡（A-3）：扫全库 `entities_*` → 归一 → 建/更新三类卡 → 卡与文档互建双链。
   * 跑在 pipeline 之后、上云之前——新卡要上云，而敏感卡必须在上云前就被识别出来。
   * 实现在 `vault/entity-cards.ts`（不在 pipeline 里，见那里的头注释）。
   */
  private async buildCards(root: string, taskId: string = this.taskId): Promise<string[]> {
    try {
      const libName = await this.libraryName(root)
      const st = await buildEntityCards(root, libName)
      const bits = [`实体 ${st.entities} 个`, `新建卡 ${st.created}`]
      if (st.updated) bits.push(`更新 ${st.updated}`)
      if (st.merged) bits.push(`归一合并 ${st.merged}`)
      if (st.links) bits.push(`双链 ${st.links} 条`)
      if (st.reused) bits.push(`复用已有卡 ${st.reused}`)
      if (st.deduped) bits.push(`清理重复卡 ${st.deduped}`)
      if (st.sensitiveCards) bits.push(`${st.sensitiveCards} 张敏感卡仅存本地`)
      // 冲突必须**说出来**：静默覆盖用户手工编辑过的卡是不可接受的（同 M-27 的原则）
      if (st.conflicted) bits.push(`${st.conflicted} 张你改过的卡未覆盖，新内容放在「待合并」里`)
      this.send({ type: 'stage', stage: 'build_cards', status: st.conflicted ? 'warn' : 'ok', message: bits.join('，') }, taskId)
      return st.sensitivePaths
    } catch (e) {
      this.send({ type: 'stage', stage: 'build_cards', status: 'error', message: String(e) }, taskId)
      return []
    }
  }

  /** 资料库目录名：与 pipeline 的 `cli.py` 同一套判据（配置 → 老库探测 → 出厂值） */
  private async libraryName(root: string): Promise<string> {
    return (await readVaultConfig(root)).library
  }

  /** 入库成功后：本轮修改过的 md 上云（私人层）。未登录直接跳过 */
  private async cloudSync(root: string, sinceMs: number, extraSensitive: string[], taskId: string): Promise<void> {
    if (!(await getAccessToken())) {
      this.send({ type: 'stage', stage: 'cloud_sync', status: 'skipped', message: '未登录' }, taskId)
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
            if (st.mtimeMs > sinceMs - 60_000) changed.push(relative(root, p))
          }
        }
      }
      await walk(root)

      // A-8：带 `sensitive: true` 的笔记不进云端（除非用户在设置里开了第三档）。
      // 标记由 09_pii_guard 写进 frontmatter——不读 pipeline 的 .checkpoint.jsonl，
      // 那是它的内部文件，让主进程去读是错误的依赖方向
      const allowCloud = store.get('sensitiveAllowCloud')
      /**
       * **判敏感必须读盘，不能读内存索引**（2026-08-18 修，A-3 单查出）。
       *
       * 旧写法是 `vaultManager.noteAt(rel)?.frontmatter?.sensitive`，而那个 Map 由
       * vault watcher 填充、`awaitWriteFinish` 是 **800ms**。09 写的标记之所以一直没出事，
       * 是因为它在链路很靠前、到收尾时早进索引了；而**实体建卡就在这一步的前一刻**才写完卡，
       * 内存里极可能还没有它 → `sensitive` 判 false → 敏感继承卡照样上云，
       * 正好打穿 A-8 刚修好的边界。读盘慢一点，但这条边界不能赌时序。
       */
      const extra = new Set(extraSensitive)
      const sensitiveCache = new Map<string, boolean>()
      const isSensitive = async (rel: string): Promise<boolean> => {
        if (extra.has(rel)) return true
        const hit = sensitiveCache.get(rel)
        if (hit !== undefined) return hit
        let v = false
        try {
          v = hasSensitiveMark(await fsp.readFile(join(root, rel), 'utf-8'))
        } catch {
          // 读不到就当敏感：宁可少传一篇，不可误传一篇
          v = true
        }
        sensitiveCache.set(rel, v)
        return v
      }
      const held: string[] = []
      const toPush: string[] = []
      for (const rel of changed) {
        if (!allowCloud && (await isSensitive(rel))) held.push(rel)
        else toPush.push(rel)
      }

      // A-7：**全量同步，不再截断**。旧实现是 `changed.slice(0, 50)`——92 篇的批量导入
      // 只推前 50 篇，另外 42 篇永远不上云且不提示；而问库在登录态下走的是云端语义检索，
      // 没上云的那些在对话里等于不存在，界面上却看得见摸得着。
      // 改成分批推进 + 进度可见：每批之间发一次 stage 事件，长队列不再像卡死
      const BATCH = 20
      let synced = 0
      let failed = 0
      for (let i = 0; i < toPush.length; i += BATCH) {
        if (this.canceledBy) break // 用户停了这一轮就别继续推
        const batch = toPush.slice(i, i + BATCH)
        for (const rel of batch) {
          const r = await ingestNote(rel)
          if (r.ok) {
            if (!r.skipped) synced++
            // 上一轮排进队列的这一篇现在通了，撤掉它（不然它会一直挂在「N 条待同步」里）
            dropNoteSyncFailure(root, rel)
          } else {
            failed++
            /**
             * F3 / Q2：**真进重试队列**。以前这里只有一个计数器，文案却说「已进重试队列」——
             * 而那个队列（`syncQueue`）只服务聊天记录，笔记压根没人管。
             * 后果：云端静默缺篇，而登录态下问库走的是云端语义检索，
             * 没上云的那些在对话里等于不存在。
             */
            pushNoteSyncFailure(root, rel, r.error ?? '未知原因')
          }
        }
        if (toPush.length > BATCH && i + BATCH < toPush.length) {
          // 文案不再自带「上云」二字：面板会把阶段名画在前面（`上云 · 20/61 篇`），
          // 自己再带一遍就成了「上云 · 上云中 20/61 篇」
          this.send(
            {
              type: 'stage',
              stage: 'cloud_sync',
              status: 'ok',
              message: `${Math.min(i + BATCH, toPush.length)}/${toPush.length} 篇`,
            },
            taskId
          )
        }
      }
      // 「N 篇未同步」单说会让人以为同步坏了、去查网络——而那 M 篇是按他自己的设置刻意不传的
      const holdNote = held.length ? `，其中 ${held.length} 篇为敏感文件，按设置仅存本地` : ''
      // 这句话现在是**实话**了（F3）：队列真的存在，退避到期会自己重传，
      // 转手动之后的出口是侧栏那颗「重试同步」
      const failNote = failed ? `，${failed} 篇没传上去，已排队稍后自动重试` : ''
      this.send(
        {
          type: 'stage',
          stage: 'cloud_sync',
          status: failed ? 'warn' : 'ok',
          message: `已完成 ${synced} 篇${holdNote}${failNote}`,
        },
        taskId
      )
      // 失败的那几篇要立刻反映到侧栏的「N 条待同步」上，不能等下一次 30 秒扫描
      if (failed) tasks.setCloud({ pendingSync: pendingSyncTotal() })
    } catch (e) {
      this.send({ type: 'stage', stage: 'cloud_sync', status: 'error', message: String(e) }, taskId)
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
    this.tagProgress = null // 每轮重新计数
    const runStart = Date.now()
    /**
     * **这一轮的身份在开头拍下来**（R2）：库根、任务 id、轮次号。下面每一个 await 之后
     * `this.vaultRoot`/`this.taskId` 都可能已经指向别的库（用户中途换库），
     * 尾段（建卡 / 上云 / 记账 / run-end / 放开 running）全部只认快照。
     */
    const root = this.vaultRoot
    const taskId = this.taskId
    const gen = ++this.runGen
    this.send({ type: 'run-start' }, taskId)

    const llmKey = getLlmKey()
    // argv 里没有 key（R5）：key 走 env，见 lib/pipeline.ts 的两个纯函数（smoke:guards 守着）
    const args = pipelineArgs({
      root,
      llmKey,
      llmBaseUrl: store.get('llmBaseUrl'),
      llmModel: store.get('llmModel'),
      sensitiveAllowAi: store.get('sensitiveAllowAi'),
    })
    // stderr 只留尾部 2KB（R4）：崩溃没来得及打 JSON 事件时，这是唯一的原因来源
    const stderrTail = new TailBuffer(2048)

    const ok = await new Promise<boolean>((resolve) => {
      // detached:true → 子进程成为新进程组的组长（组 id == child.pid），取消时才能连孙子进程
      // 一起杀（见 killGroup）。**不调 unref()**：我们仍然要等它的 close 事件
      const child = spawn(pipelineBin(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        // key 走环境变量不走 argv（R5，审计 b5）：argv 在 `ps` 里任何本机用户都看得见。
        // cli.py 的 `--llm-key` 默认值就是 `os.environ["LLM_API_KEY"]`，冻结产物不用改
        env: pipelineEnv(process.env, llmKey),
      })
      this.child = child
      // pid 进任务对象：取消入口与走查的进程组断言都靠它
      tasks.patch(taskId, { pid: child.pid, cancelable: true } as Partial<InboxTask>)
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
            /**
             * 打标的**篇级进度**（B3c）：`03_tag_llm` 每处理一篇打一行
             * `{stage:'tag_llm', status:'progress', done, total, file}`。
             * 它不是阶段迁移，所以**不进 stages**（进了会把 8 个阶段的进度算歪），
             * 只更新 `tagProgress` 让阶段标签带上篇数，然后就地 patch 一次任务。
             */
            if (ev.status === 'progress' && ev.stage === 'tag_llm') {
              this.tagProgress = { done: Number(ev.done) || 0, total: Number(ev.total) || 0 }
              tasks.patch(taskId, { progress: this.computeProgress() } as Partial<InboxTask>)
              continue
            }
            if (ev.stage === 'done') lastStatus = ev.status
            this.send(
              {
                type: 'stage',
                stage: ev.stage,
                status: ev.status,
                message: ev.message,
                pending: ev.pending,
                failed: ev.failed,
                unsupported: ev.unsupported,
                // 打标阶段若报了 token 用量就带上；pipeline 目前不报，那就只记次数（见下方 appendUsage）
                usage: ev.usage,
              },
              taskId
            )
          } catch {
            /* 非 JSON 行来自阶段脚本的中文日志，忽略 */
          }
        }
      })
      child.stderr.on('data', (d: Buffer) => stderrTail.push(d))
      const settle = (v: boolean): void => {
        if (this.child === child) this.child = null
        if (this.killTimer) {
          clearTimeout(this.killTimer)
          this.killTimer = null
        }
        resolve(v)
      }
      child.on('close', (code, signal) => {
        /**
         * 非零退出且不是我们自己杀的（R4）：把 stderr 尾部端出来。以前这里 stderr 整条丢弃，
         * PyInstaller 找不到模块、Python 段错误这类**没来得及打 JSON 事件**的崩溃在界面上只剩
         * 「投递箱处理失败」四个字，原因为空、日志也没有。现在最后一行进任务 error，整段进 main.log
         */
        if (code !== 0 && !this.canceledBy && !signal) {
          const tail = stderrTail.text()
          if (tail) log('error', 'inbox', `pipeline 退出码 ${code}，stderr 尾部：\n${tail}`)
          this.send(
            {
              type: 'stage',
              stage: 'pipeline',
              status: 'error',
              message: `处理程序异常退出（code ${code}）${stderrTail.lastLine() ? `：${stderrTail.lastLine()}` : '，详见诊断日志'}`,
            },
            taskId
          )
        }
        settle(code === 0 && lastStatus === 'ok')
      })
      child.on('error', (err) => {
        this.send({ type: 'stage', stage: 'spawn', status: 'error', message: String(err) }, taskId)
        settle(false)
      })
    })

    // 建卡 → 上云。顺序不能反：新卡也要上云，而敏感继承卡必须在上云前就被识别出来。
    // **只对快照的 root 做**：换库后 this.vaultRoot 已是新库，对新库跑建卡/上云就是 bug#10 的另一半
    const sensitiveCards = ok && !this.canceledBy ? await this.buildCards(root, taskId) : []
    // 被停掉的那一轮不再上云：半截结果没必要推到云端，也别让用户多等一次网络往返
    if (ok && !this.canceledBy) await this.cloudSync(root, runStart, sensitiveCards, taskId)

    const canceled = !!this.canceledBy

    // 用量记账：智能打标是 pipeline 子进程里的 LLM 调用，绝大多数情况拿不到 token 数
    // ——那就**只记次数**（一轮一条），比"因为没有 usage 就不记"诚实得多
    if (llmKey && !canceled) {
      const tag = this.stages.find((s) => s.stage === 'tag_llm' && s.status !== 'skipped')
      if (tag) {
        appendUsage({
          ts: Date.now(),
          sessionId: taskId,
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

    this.send({ type: 'run-end', ok }, taskId)
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
      /**
       * F10 系统通知：入库要跑几分钟，用户**不会盯着看**。
       * 界面在眼前时一条都不发、几秒就完的也不发（判据见 lib/notify.ts）——
       * 拖一个文件进去两秒转完还弹一条系统通知，比不弹更烦。
       */
      notify(
        ok ? 'inbox-done' : 'inbox-failed',
        ok ? '资料已入库' : '入库没有完成',
        ok
          ? `${files.length || this.stages.length ? `${files.length} 个文件` : '这一批'}处理完了，可以直接问它们了`
          : '有阶段失败了，打开投递箱面板看看是哪一步',
        Date.now() - runStart
      )
      const fileLine = files.length ? `\n\n处理文件：${files.slice(0, 8).join('、')}${files.length > 8 ? ` 等${files.length}个` : ''}` : ''
      notifyDingtalk(
        'inbox',
        'mcn-ai 投递箱',
        `### 投递箱处理${ok ? '完成 ✅' : '失败 ❌'}${fileLine}\n\n> ${new Date().toLocaleString('zh-CN')} · mcn-ai 自动化`
      )
    } else {
      this.runFiles.length = 0
    }
    // 只有还是"这一轮"的时候才放开 running（R2）：换库后新库的一轮可能已经开始，
    // 旧轮次的尾段不许把它的 running 抹掉、也不许替它排下一轮
    if (this.runGen !== gen) return
    this.running = false
    // 取消之后不接着排下一轮：文件还在投递箱里，等用户自己点「立即处理」
    if (this.rerun && !canceled) {
      this.rerun = false
      this.schedule()
    }
    this.rerun = false
  }

  /** 单调递增的轮次号：`run()` 尾段靠它判断"我还是当前这一轮吗"（R2） */
  private runGen = 0
}

export const inboxOrchestrator = new InboxOrchestrator()

