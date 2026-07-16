/**
 * 检索 worker 线程：bigram 分词 + MiniSearch 全在这里跑，
 * 主进程完全不承担索引 CPU（此前索引构建会堵住 IPC，点文件/缩放图谱卡顿数秒）
 */
import { parentPort } from 'worker_threads'
import MiniSearch from 'minisearch'

interface Doc {
  path: string
  title: string
  tags: string
  body: string
}

function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const seg of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!seg) continue
    if (/^[a-z0-9_-]+$/.test(seg)) {
      tokens.push(seg)
    } else {
      for (let i = 0; i < seg.length; i++) {
        tokens.push(seg[i])
        if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2))
      }
    }
  }
  return tokens
}

function newIndex(): MiniSearch {
  return new MiniSearch({
    fields: ['title', 'body', 'tags'],
    storeFields: ['title'],
    tokenize,
    searchOptions: { boost: { title: 3, tags: 2 }, combineWith: 'AND' },
  })
}

let mini = newIndex()
const bodies = new Map<string, string>()

function add(doc: Doc): void {
  if (mini.has(doc.path)) mini.discard(doc.path)
  bodies.set(doc.path, doc.body)
  mini.add({ id: doc.path, title: doc.title, body: doc.body, tags: doc.tags })
}

parentPort!.on('message', (msg: { type: string; [k: string]: unknown }) => {
  switch (msg.type) {
    case 'rebuild': {
      mini = newIndex()
      bodies.clear()
      for (const d of msg.docs as Doc[]) add(d)
      parentPort!.postMessage({ type: 'ready', count: (msg.docs as Doc[]).length })
      break
    }
    case 'upsert':
      add(msg.doc as Doc)
      break
    case 'remove': {
      const p = msg.path as string
      if (mini.has(p)) mini.discard(p)
      bodies.delete(p)
      break
    }
    case 'search': {
      const q = msg.q as string
      const hits = mini.search(q).slice(0, 20).map((r) => {
        const body = bodies.get(String(r.id)) ?? ''
        const idx = body.indexOf(q.slice(0, 12))
        const at = idx >= 0 ? idx : 0
        return {
          path: String(r.id),
          title: String(r.title),
          snippet: body.slice(Math.max(0, at - 30), at + 90).replace(/\n+/g, ' '),
        }
      })
      parentPort!.postMessage({ type: 'results', id: msg.id, hits })
      break
    }
  }
})
