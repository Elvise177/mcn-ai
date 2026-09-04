import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync } from 'fs'
import type { VaultNote, SearchHit, SearchResult } from './types'

/** worker 反复崩时最多重建几次，见 `restarts` 的注释 */
const MAX_RESTARTS = 3

function workerPath(): string {
  // 本模块可能被 rollup 打进 chunks/，worker 文件始终在 out/main/ 根：两级探测
  for (const p of [join(__dirname, 'search-worker.js'), join(__dirname, '..', 'search-worker.js')]) {
    const real = p.replace('app.asar', 'app.asar.unpacked')
    if (existsSync(real)) return real
  }
  throw new Error('search-worker.js 未找到')
}

/** 主进程侧代理：真正的索引/检索在 search-worker 线程，主进程事件循环零阻塞 */
export class VaultSearcher {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, (r: SearchResult) => void>()

  /**
   * 最近一次 rebuild 投出去的文档快照（R16）。worker 崩了要靠它把索引重建回来——
   * 没有它的话，重建出来的 worker 拿着**空索引**，而 `indexed` 还是 true：
   * 此后每一次检索都秒回 0 条，界面按三态规则画成「没找到「X」」。
   * 那正是产品说谎，比"检索报错"坏得多。
   */
  private lastDocs: Array<{ path: string; title: string; tags: string; body: string }> = []
  /**
   * 已经重建过几次。**必须封顶**：worker 一起来就崩（依赖缺失、内存不够）时，
   * 无上限重建就是一个每秒几十次的 spawn 循环，把主进程一起拖垮。
   * 封顶之后退化为"检索不可用但应用还活着"，这是可接受的降级。
   */
  private restarts = 0

  constructor() {
    this.worker = this.spawn()
  }

  private spawn(): Worker {
    const w = new Worker(workerPath())
    w.on('message', (m: { type: string; id?: number; hits?: SearchHit[]; total?: number; fuzzy?: boolean }) => {
      if (m.type === 'results' && m.id != null) {
        this.pending.get(m.id)?.({ hits: m.hits ?? [], total: m.total ?? m.hits?.length ?? 0, fuzzy: m.fuzzy })
        this.pending.delete(m.id)
      }
    })
    w.on('error', (err) => {
      console.error('[search-worker]', err)
      this.restart(`error: ${err instanceof Error ? err.message : String(err)}`)
    })
    // `exit` 也要接：worker 线程被 OOM kill 之类的情况不走 `error`，只有一个退出码。
    // 不接的话 pending 里的查询**永远不会 resolve**——界面上是搜索框转圈转到天荒地老
    w.on('exit', (code) => {
      if (this.disposed || w !== this.worker) return // 我们自己 terminate 的，或已经被换掉的旧 worker
      this.restart(`exit code ${code}`)
    })
    return w
  }

  /**
   * worker 崩了就地重建（R16）。
   *
   * 顺序有讲究：**先把在等的查询放掉，再重建**。反过来的话那批查询还挂在旧的
   * `pending` 里，而新 worker 永远不会回它们的 id ——搜索框就一直转圈。
   * 放掉时回空结果而不是抛错：调用方（`search`）的契约是"总会 resolve"。
   */
  private restart(why: string): void {
    if (this.disposed) return
    for (const [, resolve] of this.pending) resolve({ hits: [], total: 0 })
    this.pending.clear()
    if (this.restarts >= MAX_RESTARTS) {
      this.indexed = true // 别再让查询卡在 whenIndexed 上等满 20 秒，宁可快点回空
      console.error(`[search-worker] 已重建 ${this.restarts} 次仍不稳定，放弃重建（${why}）`)
      return
    }
    this.restarts++
    console.error(`[search-worker] 崩了，第 ${this.restarts} 次重建（${why}）`)
    void this.worker.terminate()
    this.worker = this.spawn()
    // 索引跟着 worker 一起没了：拿最近一次的文档快照重灌，并把就绪位压回去，
    // 让这期间进来的查询在 whenIndexed 上等一等，别拿空索引回 0 条
    this.indexed = false
    if (this.lastDocs.length) {
      this.worker.postMessage({ type: 'rebuild', docs: this.lastDocs })
      this.indexed = true
      this.waiters.splice(0).forEach((f) => f())
    }
  }

  private disposed = false

  /**
   * 索引就绪闸门（2026-08-19，Electron 43 升级时暴露）。
   *
   * `open()` 是**先置 root、再 await scanVault、最后才 rebuild**，中间那一段
   * 「库已打开、索引还是空的」的窗口是真实存在的。这期间来的查询会被 worker
   * 拿空索引**秒回 0 条**——界面照三态规则画成「没找到「X」」，而真相是"还没建好"。
   * 用户看到的是产品说谎，正好踩在 §2-19 规则 10b 立的那条规矩上。
   *
   * Electron 30 上扫得快，走查从没撞上；43 慢了一档就每轮必现（前 1~2 条查询归零）。
   * **所以这不是 Electron 的 bug，是它把一个一直都在的窗口撑开了。**
   */
  private indexed = false
  private waiters: (() => void)[] = []

  private whenIndexed(ms: number): Promise<void> {
    if (this.indexed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(done)
        if (i >= 0) this.waiters.splice(i, 1)
        resolve() // 等超了也放行：宁可回空，不可把界面挂死
      }, ms)
      this.waiters.push(done)
    })
  }

  /** 换库时调用：新库的索引还没建好之前，不能拿旧库的结果糊弄 */
  reset(): void {
    this.indexed = false
  }

  rebuild(notes: Map<string, VaultNote>, bodies: Map<string, string>): void {
    const docs = [...notes.values()].map((n) => ({
      path: n.path,
      title: n.title,
      tags: n.tags.join(' '),
      body: bodies.get(n.path) ?? '',
    }))
    this.lastDocs = docs // worker 崩了要靠它重灌（R16）
    this.worker.postMessage({ type: 'rebuild', docs })
    // worker 的消息是保序的：rebuild 投出去之后再投的 search 一定看得到这份索引
    this.indexed = true
    this.waiters.splice(0).forEach((f) => f())
  }

  upsert(note: VaultNote, raw: string): void {
    this.worker.postMessage({
      type: 'upsert',
      doc: { path: note.path, title: note.title, tags: note.tags.join(' '), body: raw },
    })
  }

  remove(path: string): void {
    this.worker.postMessage({ type: 'remove', path })
  }

  async search(q: string): Promise<SearchResult> {
    // 索引还没建好就等它（见 whenIndexed 的注释）。已建好时这一行是同步返回，零开销
    await this.whenIndexed(20000)
    const id = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.worker.postMessage({ type: 'search', id, q })
      // 兜底超时：索引重建期间查询会排队（大库可达数秒），给足余量
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ hits: [], total: 0 })
      }, 20000)
    })
  }

  dispose(): void {
    // 先立旗再 terminate：不然自己 kill 出来的 `exit` 会被当成崩溃，
    // 应用退出的路上还要白重建一个 worker（R16）
    this.disposed = true
    void this.worker.terminate()
  }
}
