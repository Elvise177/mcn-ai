import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync } from 'fs'
import type { VaultNote, SearchHit } from './types'

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
  private pending = new Map<number, (hits: SearchHit[]) => void>()

  constructor() {
    this.worker = new Worker(workerPath())
    this.worker.on('message', (m: { type: string; id?: number; hits?: SearchHit[] }) => {
      if (m.type === 'results' && m.id != null) {
        this.pending.get(m.id)?.(m.hits ?? [])
        this.pending.delete(m.id)
      }
    })
    this.worker.on('error', (err) => console.error('[search-worker]', err))
  }

  rebuild(notes: Map<string, VaultNote>, bodies: Map<string, string>): void {
    const docs = [...notes.values()].map((n) => ({
      path: n.path,
      title: n.title,
      tags: n.tags.join(' '),
      body: bodies.get(n.path) ?? '',
    }))
    this.worker.postMessage({ type: 'rebuild', docs })
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

  search(q: string): Promise<SearchHit[]> {
    const id = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.worker.postMessage({ type: 'search', id, q })
      // 兜底超时：索引重建期间查询会排队（大库可达数秒），给足余量
      setTimeout(() => {
        if (this.pending.delete(id)) resolve([])
      }, 20000)
    })
  }

  dispose(): void {
    void this.worker.terminate()
  }
}
