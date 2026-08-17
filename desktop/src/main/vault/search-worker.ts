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

/**
 * 摘要用的纯文本：索引照旧吃原文（匹配行为不变），但展示给用户的片段要干净——
 * 去掉 frontmatter 块、双链括号、表格竖线与分隔行、以及各类 md 记号，
 * 否则搜索结果里全是「--- doc_type: 达人档案 ... |||」这种噪音。
 */
function plain(md: string): string {
  let t = md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/, '') // frontmatter
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1') // 代码块/行内代码
  t = t.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, ' ') // 表格分隔行 |---|:--:|
  t = t.replace(/\|/g, ' ') // 表格竖线
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
  t = t.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target, alias) => alias || target) // 双链
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // md 链接
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题号
  t = t.replace(/^\s{0,3}>\s?/gm, '') // 引用
  t = t.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '') // 列表符号
  t = t.replace(/^\s*[-*_]{3,}\s*$/gm, ' ') // 分割线
  t = t.replace(/(\*\*|__|\*|~~)/g, '') // 强调
  return t.replace(/\s+/g, ' ').trim()
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
  bodies.set(doc.path, plain(doc.body)) // bodies 只用于出摘要，存清洗后的纯文本
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
      // 总数取截断前的命中数：UI 要显示「20 / 共 137 条」，否则截断是静默的（M-13）
      const all = mini.search(q)
      const hits = all.slice(0, 20).map((r) => {
        const body = bodies.get(String(r.id)) ?? ''
        const idx = body.indexOf(q.slice(0, 12))
        const at = idx >= 0 ? idx : 0
        const from = Math.max(0, at - 30)
        const to = at + 90
        return {
          path: String(r.id),
          title: String(r.title),
          snippet: (from > 0 ? '…' : '') + body.slice(from, to).trim() + (to < body.length ? '…' : ''),
        }
      })
      parentPort!.postMessage({ type: 'results', id: msg.id, hits, total: all.length })
      break
    }
  }
})
