import { promises as fs, existsSync } from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { Embedder, EMBED_DIM, MODEL_ID, cosine } from './embedder'
import type { VaultNote } from './types'
import { log } from '../lib/logger'

/**
 * 语义索引（检索优化第三单，方案 `docs/PLAN-retrieval-embedding.md` §2–3）。
 *
 * 语料 = **摘要级**，每篇一条：`标题。summary`；没有 summary 的（老库未打标、实体卡）补正文前 200 字。
 * 不 embed 全文——体积大两个量级，且第二单已证明"摆到面前的多 ≠ 读到的多"，语义通道要给的是**该读哪几篇**。
 * 敏感文档**照常进索引**：向量不出门，这是本地 embedding 相对云端的核心优势。
 *
 * 存储 = 平面文件，不用向量库：1000 篇 × 512 维 × 4 字节 = 2 MB，暴力余弦 20k 篇也 < 20 ms。
 *   `<库>/.mcnai/embeddings/<模型>.bin`   Float32 连续块，按 meta.entries 顺序
 *   `<库>/.mcnai/embeddings/<模型>.json`  { model, dim, entries: [{ path, hash }] }
 * `.mcnai/` 在扫描 IGNORE 里、也被 cloudSync 的 walk 跳过（`isCloudSyncSkipped`），索引文件永远不上云。
 *
 * 增量：以语料文本的 sha1 为键——标题或摘要没变就不重算；watcher upsert 单篇重算（~5 ms）；换模型整体重建。
 * 建索引在后台分批（每批 16、批间让出事件循环），不阻塞开库与入库；进度与失败原因都走 `status()`，
 * 设置页「语义索引：已建 N 篇 / 建索引中 M/N / 不可用（原因）」就读它——失败必须说出来（Q13 的教训）。
 */

export type EmbedState = 'disabled' | 'unavailable' | 'building' | 'ready' | 'empty'

export interface EmbedStatus {
  state: EmbedState
  /** 已入索引的篇数 */
  count: number
  /** 本次要建的总篇数（building 时有意义） */
  total: number
  reason?: string
  model: string
  /** 上次建索引/增量花了多久 */
  lastBuildMs?: number
}

export interface SemanticHit {
  path: string
  score: number
}

/** 语料文本：标题 + 摘要；无摘要（老库 / 实体卡 / MOC）补正文前 200 字。≤400 字 */
export function corpusText(note: VaultNote, raw: string): string {
  const fm = note.frontmatter ?? {}
  const summary = typeof fm.summary === 'string' ? fm.summary.trim() : ''
  const isCard = typeof fm.entity_kind === 'string' || fm.doc_type === '达人档案' || fm.doc_type === '产品' || fm.doc_type === '合作方'
  let extra = ''
  if (!summary || isCard) {
    const body = raw
      .replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    extra = body.slice(0, 200)
  }
  return `${note.title}。${summary}${extra ? ' ' + extra : ''}`.slice(0, 400)
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')

interface Meta {
  model: string
  dim: number
  entries: Array<{ path: string; hash: string }>
}

export class EmbedIndex {
  private root: string | null = null
  private meta: Meta = { model: MODEL_ID, dim: EMBED_DIM, entries: [] }
  private vectors: Float32Array[] = []
  private byPath = new Map<string, number>()
  private embedder: Embedder | null = null
  private state: EmbedState = 'disabled'
  private reason: string | undefined
  private total = 0
  private lastBuildMs: number | undefined
  private building: Promise<void> | null = null
  /** 建完之后要处理的增量（watcher 在建索引期间来的 upsert/remove 排队） */
  private pendingUpserts = new Map<string, { note: VaultNote; raw: string } | null>()
  private unloadTimer: ReturnType<typeof setTimeout> | null = null
  /** 用户在设置页关掉语义通道 */
  enabled = true

  status(): EmbedStatus {
    return { state: this.enabled ? this.state : 'disabled', count: this.meta.entries.length, total: this.total, reason: this.reason, model: MODEL_ID, lastBuildMs: this.lastBuildMs }
  }

  /** 索引就绪（或明确不可用）时 resolve：bench 执行端开库后等它，别在建索引一半时开始提问 */
  async whenSettled(): Promise<EmbedStatus> {
    if (this.building) await this.building.catch(() => undefined)
    return this.status()
  }

  private dir(): string {
    return join(this.root!, '.mcnai', 'embeddings')
  }

  /**
   * 开库：读旧索引 → 与当前笔记按 hash 比对 → 后台补算缺的。**不 await 推理**，立即返回。
   * `notes`/`bodies` 与 searcher.rebuild 用的是同一份快照。
   */
  open(root: string, notes: Map<string, VaultNote>, bodies: Map<string, string>): void {
    this.root = root
    this.meta = { model: MODEL_ID, dim: EMBED_DIM, entries: [] }
    this.vectors = []
    this.byPath.clear()
    this.pendingUpserts.clear()
    if (!this.enabled) {
      this.state = 'disabled'
      return
    }
    this.state = 'building'
    this.reason = undefined
    this.building = this.build(notes, bodies)
      .catch((e) => {
        this.state = 'unavailable'
        this.reason = e instanceof Error ? e.message : String(e)
        log('error', 'embed', `语义索引构建失败：${this.reason}`)
      })
      .finally(() => {
        this.building = null
      })
  }

  private async loadStored(): Promise<void> {
    const metaPath = join(this.dir(), `${MODEL_ID}.json`)
    const binPath = join(this.dir(), `${MODEL_ID}.bin`)
    if (!existsSync(metaPath) || !existsSync(binPath)) return
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Meta
      if (meta.model !== MODEL_ID || meta.dim !== EMBED_DIM) return // 换了模型：整体重建
      const buf = await fs.readFile(binPath)
      if (buf.byteLength !== meta.entries.length * EMBED_DIM * 4) return // 两个文件对不上：当没有
      const all = new Float32Array(buf.buffer, buf.byteOffset, meta.entries.length * EMBED_DIM)
      this.meta = meta
      this.vectors = meta.entries.map((_, i) => all.slice(i * EMBED_DIM, (i + 1) * EMBED_DIM))
      this.byPath = new Map(meta.entries.map((e, i) => [e.path, i]))
    } catch (e) {
      log('warn', 'embed', `旧索引读不出来，重建：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async persist(): Promise<void> {
    if (!this.root) return
    await fs.mkdir(this.dir(), { recursive: true })
    const all = new Float32Array(this.vectors.length * EMBED_DIM)
    this.vectors.forEach((v, i) => all.set(v, i * EMBED_DIM))
    // 先写临时文件再改名：建索引中途被关机不能留半个 .bin 配一个完整的 .json
    const bin = join(this.dir(), `${MODEL_ID}.bin`)
    const metaPath = join(this.dir(), `${MODEL_ID}.json`)
    await fs.writeFile(bin + '.tmp', Buffer.from(all.buffer, all.byteOffset, all.byteLength))
    await fs.writeFile(metaPath + '.tmp', JSON.stringify(this.meta))
    await fs.rename(bin + '.tmp', bin)
    await fs.rename(metaPath + '.tmp', metaPath)
  }

  private async ensureEmbedder(): Promise<Embedder> {
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer)
      this.unloadTimer = null
    }
    if (!this.embedder) this.embedder = new Embedder()
    if (!this.embedder.ready) {
      const info = await this.embedder.load()
      if (!info.ok) throw new Error(info.reason ?? '模型加载失败')
    }
    return this.embedder
  }

  /** 空闲 60 s 卸载模型释放 ~150 MB；下次查询热加载 ~0.1 s */
  private scheduleUnload(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer)
    this.unloadTimer = setTimeout(() => {
      void this.embedder?.unload()
      this.unloadTimer = null
    }, 60_000)
    this.unloadTimer.unref?.()
  }

  private setEntry(path: string, hash: string, vec: Float32Array): void {
    const i = this.byPath.get(path)
    if (i !== undefined) {
      this.meta.entries[i] = { path, hash }
      this.vectors[i] = vec
    } else {
      this.byPath.set(path, this.meta.entries.length)
      this.meta.entries.push({ path, hash })
      this.vectors.push(vec)
    }
  }

  private removeEntry(path: string): void {
    const i = this.byPath.get(path)
    if (i === undefined) return
    this.meta.entries.splice(i, 1)
    this.vectors.splice(i, 1)
    this.byPath = new Map(this.meta.entries.map((e, k) => [e.path, k]))
  }

  private async build(notes: Map<string, VaultNote>, bodies: Map<string, string>): Promise<void> {
    const t0 = Date.now()
    await this.loadStored()
    // 目标集合：当前笔记；旧索引里已经不存在的路径剔掉
    const want = new Map<string, { hash: string; text: string }>()
    for (const [path, note] of notes) {
      const text = corpusText(note, bodies.get(path) ?? '')
      want.set(path, { hash: sha1(text), text })
    }
    for (const e of [...this.meta.entries]) if (!want.has(e.path)) this.removeEntry(e.path)
    const todo = [...want].filter(([path, w]) => this.meta.entries[this.byPath.get(path) ?? -1]?.hash !== w.hash)
    this.total = want.size
    if (!todo.length) {
      this.state = this.meta.entries.length ? 'ready' : 'empty'
      this.lastBuildMs = Date.now() - t0
      return
    }
    const embedder = await this.ensureEmbedder()
    const BATCH = 16
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH)
      const vecs = await embedder.embed(batch.map(([, w]) => w.text))
      batch.forEach(([path, w], k) => this.setEntry(path, w.hash, vecs[k]))
      // 每批让出事件循环：建索引与入库、检索、界面同时跑，不许独占
      await new Promise((r) => setImmediate(r))
    }
    await this.persist()
    this.lastBuildMs = Date.now() - t0
    this.state = 'ready'
    log('info', 'embed', `语义索引就绪：${this.meta.entries.length} 篇（本次补算 ${todo.length}，${this.lastBuildMs} ms）`)
    this.scheduleUnload()
    // 建索引期间排队的增量
    const pend = [...this.pendingUpserts]
    this.pendingUpserts.clear()
    for (const [path, v] of pend) {
      if (v) await this.upsert(v.note, v.raw)
      else this.remove(path)
    }
  }

  async upsert(note: VaultNote, raw: string): Promise<void> {
    if (!this.enabled || !this.root) return
    if (this.building) {
      this.pendingUpserts.set(note.path, { note, raw })
      return
    }
    const text = corpusText(note, raw)
    const hash = sha1(text)
    if (this.meta.entries[this.byPath.get(note.path) ?? -1]?.hash === hash) return
    try {
      const [vec] = await (await this.ensureEmbedder()).embed([text])
      this.setEntry(note.path, hash, vec)
      await this.persist()
      this.state = 'ready'
      this.scheduleUnload()
    } catch (e) {
      // 单篇失败不拖垮整个通道：记下原因，索引其余部分照常可用
      log('warn', 'embed', `《${note.path}》增量 embedding 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  remove(path: string): void {
    if (this.building) {
      this.pendingUpserts.set(path, null)
      return
    }
    if (this.byPath.has(path)) {
      this.removeEntry(path)
      void this.persist()
    }
  }

  /** 语义 top-k。索引没就绪（building / unavailable / disabled）回空数组——调用方按空处理，不抛 */
  async search(query: string, k = 10): Promise<SemanticHit[]> {
    if (!this.enabled || this.state !== 'ready' || !this.vectors.length) return []
    try {
      const [q] = await (await this.ensureEmbedder()).embed([query])
      this.scheduleUnload()
      const scored = this.vectors.map((v, i) => ({ path: this.meta.entries[i].path, score: cosine(q, v) }))
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, k)
    } catch (e) {
      log('warn', 'embed', `语义检索失败：${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  async close(): Promise<void> {
    if (this.unloadTimer) clearTimeout(this.unloadTimer)
    this.unloadTimer = null
    await this.embedder?.unload()
    this.embedder = null
    this.root = null
    this.vectors = []
    this.meta = { model: MODEL_ID, dim: EMBED_DIM, entries: [] }
    this.byPath.clear()
    this.state = this.enabled ? 'empty' : 'disabled'
  }
}

/** 索引目录路径（给 smoke / 清理用） */
export const embedIndexDir = (root: string): string => join(root, '.mcnai', 'embeddings')
export const embedIndexParent = (root: string): string => dirname(embedIndexDir(root))
