import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync } from 'fs'
import type { VaultNote, SearchHit, SearchResult } from './types'

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

  constructor() {
    this.worker = new Worker(workerPath())
    this.worker.on('message', (m: { type: string; id?: number; hits?: SearchHit[]; total?: number; fuzzy?: boolean }) => {
      if (m.type === 'results' && m.id != null) {
        this.pending.get(m.id)?.({ hits: m.hits ?? [], total: m.total ?? m.hits?.length ?? 0, fuzzy: m.fuzzy })
        this.pending.delete(m.id)
      }
    })
    this.worker.on('error', (err) => console.error('[search-worker]', err))
  }

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
    void this.worker.terminate()
  }
}
