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

/** 一次增量/全量同步的结果（入库尾部那一格与设置页「重建」按钮都拿它说话） */
export interface EmbedSyncResult {
  ok: boolean
  /** 本次重算的篇数（新增 + 内容变了的） */
  added: number
  /** 本次从索引里剔掉的篇数（删除 / 移出库 / 重命名的旧名） */
  removed: number
  /** 同步后索引里一共有多少篇 */
  count: number
  ms: number
  /** ok=false 时的人话原因；skipped 时说明为什么没跑 */
  reason?: string
  /** 'disabled' | 'no-vault'：压根没跑，不算失败 */
  skipped?: 'disabled' | 'no-vault'
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
  /**
   * 换库代号（第四单）。**没有它，换库时上一个库的向量会落进新库的索引里**：
   * `open()` 是"立即返回、后台接着算"的，换库时旧库那一轮 build 还在 batch 循环里，
   * 而 `setEntry` 写的是 `this.meta`——那时 `this.meta` 已经是新库的了。
   * 于是新库的 `.mcnai/embeddings` 里混进上一个库的笔记路径，检索会摆出根本不存在的文件。
   * 每次 open/close 都 +1，跑着的那一轮每批检查一次，代号变了立刻收手（不落盘、不改状态）。
   */
  private gen = 0
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
    this.gen++
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
      .then(() => undefined)
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

  /**
   * 落盘串行队列（第四单 2026-09-06 被 smoke 逮到的真 bug）。
   *
   * `persist()` 是 write-tmp → rename 两步，而调用它的路有三条：建索引末尾、单篇 upsert、
   * 单篇 remove（后两条还是 `void` 出去的）。三条路并发时**两个 persist 会抢同一个 `.tmp`**：
   * 先跑完的那个把 tmp 改名走了，后一个的 rename 直接 `ENOENT`。
   * 现场是删一篇（remove 的 `void persist()`）紧接着一次批量 sync——索引同步整个报失败，
   * 而在此之前那条 `void` 会把它变成一次静默的 unhandled rejection。
   *
   * 两道措施都要：**队列**保证同一时刻只有一个 persist 在跑；**tmp 名带序号**保证
   * 万一还有别的进程/实例在写同一个库，也不会互相抢（同一份库被两个实例打开是真发生过的事）。
   */
  private persistChain: Promise<void> = Promise.resolve()
  private persistSeq = 0

  /** 把一件"要动索引目录的活"排进队列，保证同一时刻只有一个在跑 */
  private queue(job: () => Promise<void>): Promise<void> {
    const next = this.persistChain.catch(() => undefined).then(job)
    // 链上不留失败态：下一次该照常跑（这一次的失败由它自己的调用方处理）
    this.persistChain = next.catch(() => undefined)
    return next
  }

  private persist(): Promise<void> {
    return this.queue(() => this.writeIndexFiles())
  }

  private async writeIndexFiles(): Promise<void> {
    if (!this.root) return
    await fs.mkdir(this.dir(), { recursive: true })
    const all = new Float32Array(this.vectors.length * EMBED_DIM)
    this.vectors.forEach((v, i) => all.set(v, i * EMBED_DIM))
    // 先写临时文件再改名：建索引中途被关机不能留半个 .bin 配一个完整的 .json
    const bin = join(this.dir(), `${MODEL_ID}.bin`)
    const metaPath = join(this.dir(), `${MODEL_ID}.json`)
    const tmp = `.tmp-${process.pid}-${++this.persistSeq}`
    await fs.writeFile(bin + tmp, Buffer.from(all.buffer, all.byteOffset, all.byteLength))
    await fs.writeFile(metaPath + tmp, JSON.stringify(this.meta))
    await fs.rename(bin + tmp, bin)
    await fs.rename(metaPath + tmp, metaPath)
  }

  /**
   * 换模型之后把上一个模型的索引文件删掉。
   *
   * 换模型走的是"整体重建"（`loadStored` 认出 `meta.model` 不一致就当没有旧索引），
   * 但旧的 `<老模型>.bin/.json` **会永远躺在用户库里**——每换一次模型多一份，
   * 谁都不会去看那个隐藏目录。文件名里带模型 id 正是为了能这样识别，
   * 所以顺手清掉：只删这个目录里我们自己写的、模型 id 不是当前这个的那几个。
   */
  private async pruneOtherModels(): Promise<void> {
    try {
      for (const name of await fs.readdir(this.dir())) {
        // 上次写到一半被关机留下的临时文件也一起收掉（正常路径写完就 rename 走了）
        const stale = /\.tmp-\d+-\d+$/.test(name)
        if (!stale) {
          if (name.startsWith(MODEL_ID)) continue
          if (!name.endsWith('.bin') && !name.endsWith('.json')) continue
        }
        await fs.rm(join(this.dir(), name), { force: true })
        log('info', 'embed', `清掉${stale ? '残留的临时' : '上一个模型的'}索引文件：${name}`)
      }
    } catch {
      /* 目录读不了就算了：这只是清理，不该拖垮建索引 */
    }
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

  /**
   * 索引与「当前这份笔记集合」对齐。
   *
   * **判据是集合差 + 语料内容哈希，不是 mtime**（第四单，2026-09-06）：
   * pipeline 落文件、实体建卡、上云回写都会动 mtime，而其中大多数动的是与语料无关的部分
   * （正文改了但标题/摘要没改）；反过来 rsync 拷进来的库 mtime 全是新的，按 mtime 判就是整库重算。
   * 集合差还顺带把**删除/移出库/重命名的旧名**一次清干净——那是 mtime 永远给不出的信息。
   *
   * @param load  true = 先从盘上读回旧索引（开库时）；false = 拿内存里这份接着增量（入库尾段/手动重建）
   */
  private async build(
    notes: Map<string, VaultNote>,
    bodies: Map<string, string>,
    opts: { load: boolean; onProgress?: (done: number, total: number) => void } = { load: true }
  ): Promise<EmbedSyncResult> {
    const t0 = Date.now()
    const gen = this.gen
    if (opts.load) await this.loadStored()
    if (gen !== this.gen) return { ok: true, added: 0, removed: 0, count: 0, ms: 0, skipped: 'no-vault', reason: '已换库' }
    // 目标集合：当前笔记；旧索引里已经不存在的路径剔掉
    const want = new Map<string, { hash: string; text: string }>()
    for (const [path, note] of notes) {
      const text = corpusText(note, bodies.get(path) ?? '')
      want.set(path, { hash: sha1(text), text })
    }
    let removed = 0
    for (const e of [...this.meta.entries]) {
      if (!want.has(e.path)) {
        this.removeEntry(e.path)
        removed++
      }
    }
    const todo = [...want].filter(([path, w]) => this.meta.entries[this.byPath.get(path) ?? -1]?.hash !== w.hash)
    this.total = want.size
    if (!todo.length) {
      // 只有剔除、没有新算：也要落盘，否则删掉的文件重启后又从 .bin 里冒回来
      if (removed) await this.persist()
      this.state = this.meta.entries.length ? 'ready' : 'empty'
      this.lastBuildMs = Date.now() - t0
      opts.onProgress?.(0, 0)
      return { ok: true, added: 0, removed, count: this.meta.entries.length, ms: this.lastBuildMs }
    }
    opts.onProgress?.(0, todo.length)
    const embedder = await this.ensureEmbedder()
    const BATCH = 16
    for (let i = 0; i < todo.length; i += BATCH) {
      // 换库了就立刻收手：这一轮的向量属于上一个库，写进去就是污染（见 gen 的注释）
      if (gen !== this.gen) {
        log('info', 'embed', `建索引中途换库，本轮丢弃（已算 ${i} 篇）`)
        return { ok: true, added: 0, removed: 0, count: 0, ms: Date.now() - t0, skipped: 'no-vault', reason: '已换库' }
      }
      const batch = todo.slice(i, i + BATCH)
      const vecs = await embedder.embed(batch.map(([, w]) => w.text))
      // 推理这一下也是个 await：换库可能正好落在里面，写之前再验一次代号
      if (gen !== this.gen) continue
      batch.forEach(([path, w], k) => this.setEntry(path, w.hash, vecs[k]))
      opts.onProgress?.(Math.min(i + BATCH, todo.length), todo.length)
      // 每批让出事件循环：建索引与入库、检索、界面同时跑，不许独占
      await new Promise((r) => setImmediate(r))
    }
    if (gen !== this.gen) return { ok: true, added: 0, removed: 0, count: 0, ms: Date.now() - t0, skipped: 'no-vault', reason: '已换库' }
    await this.persist()
    // 清理也排进落盘队列：它会删 `.tmp-*`，而并发的 persist 正指望自己那个 tmp 还在
    await this.queue(() => this.pruneOtherModels())
    this.lastBuildMs = Date.now() - t0
    this.state = 'ready'
    log('info', 'embed', `语义索引就绪：${this.meta.entries.length} 篇（本次补算 ${todo.length}，剔除 ${removed}，${this.lastBuildMs} ms）`)
    this.scheduleUnload()
    // 建索引期间排队的增量
    const pend = [...this.pendingUpserts]
    this.pendingUpserts.clear()
    for (const [path, v] of pend) {
      if (v) await this.upsert(v.note, v.raw)
      else this.remove(path)
    }
    return { ok: true, added: todo.length, removed, count: this.meta.entries.length, ms: this.lastBuildMs }
  }

  /**
   * 入库尾段那一格（`embed_index`）与设置页「重建」按钮的入口：**等得到结果**的同步。
   *
   * 与 `open()` 的区别只有两点：等（调用方要报进度、要把结果写进阶段事件）、
   * 不重读盘上的旧索引（内存里那份就是最新的）。模型加载失败时**不吞**——
   * 回一条 `ok:false` + 人话原因，由调用方响亮地说出来（Q13 的教训：不许无条件报成功）。
   */
  async sync(
    notes: Map<string, VaultNote>,
    bodies: Map<string, string>,
    onProgress?: (done: number, total: number) => void,
    /** true = 设置页那颗「重建索引」：先把旧向量整个丢掉，全部重算（索引坏了/口径变了的出口） */
    full = false
  ): Promise<EmbedSyncResult> {
    const empty = { added: 0, removed: 0, count: this.meta.entries.length, ms: 0 }
    if (!this.enabled) return { ok: true, ...empty, skipped: 'disabled', reason: '语义检索已在设置里关闭' }
    if (!this.root) return { ok: true, ...empty, skipped: 'no-vault', reason: '还没有打开知识库' }
    // 开库那一轮可能还在跑（400 篇约 2 秒）：等它，别两个 build 同时改同一份 meta
    if (this.building) await this.building.catch(() => undefined)
    if (full) {
      this.meta = { model: MODEL_ID, dim: EMBED_DIM, entries: [] }
      this.vectors = []
      this.byPath.clear()
    }
    this.state = 'building'
    this.reason = undefined
    let out: EmbedSyncResult = { ok: false, ...empty }
    this.building = this.build(notes, bodies, { load: false, onProgress })
      .then((r) => {
        out = r
      })
      .catch((e) => {
        const reason = e instanceof Error ? e.message : String(e)
        this.state = 'unavailable'
        this.reason = reason
        out = { ok: false, ...empty, count: this.meta.entries.length, reason }
        log('error', 'embed', `语义索引同步失败：${reason}`)
      })
      .finally(() => {
        this.building = null
      })
    await this.building
    return out
  }

  /** 后台还在建的那一半：入库尾段超时放行后，调用方拿它接着等（不 await 也不会漏落盘） */
  get inFlight(): Promise<void> | null {
    return this.building
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
    const gen = this.gen
    try {
      const [vec] = await (await this.ensureEmbedder()).embed([text])
      // 加载模型 + 推理之间可能已经换库了（同 build 里那道闸门）
      if (gen !== this.gen) return
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
      // 落盘失败要**说出来**：这条路原来是裸 `void`，失败时只有一次静默的 unhandled rejection，
      // 而后果是删掉的文件重启后从 .bin 里复活、继续被摆到模型面前
      this.persist().catch((e) =>
        log('warn', 'embed', `剔除《${path}》后落盘失败（重启后可能复活）：${e instanceof Error ? e.message : String(e)}`)
      )
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
    this.gen++ // 跑着的那一轮 build 从这一刻起作废，别让它把向量写进下一个库
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
