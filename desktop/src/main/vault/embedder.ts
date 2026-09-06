import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * 本地 embedding（检索优化第三单，方案 `docs/PLAN-retrieval-embedding.md`）。
 *
 * 模型：bge-small-zh-v1.5，q8 ONNX（24 MB），随包放在 `resources/models/bge-small-zh-v1.5/`，**永不联网**。
 * 运行时：**直接 onnxruntime-node**，不经 transformers.js——后者硬依赖 sharp（libvips 16 MB 原生库），
 * 平白多一片要签名的 Mach-O；自写的 BERT WordPiece 分词与它逐 token 一致（`smoke:embed` 用 4 段文本比对余弦 = 1.00000），
 * 而且直调快 5 倍（1.1 ms/篇 对 5.1 ms/篇，2026-09-05 M1 Pro 实测）。
 *
 * 向量口径：CLS pooling + L2 归一化（bge 官方口径），维度 512。
 * 输出与 transformers.js 的 `pooling:'cls', normalize:true` 逐位相同，所以选型实验里的名次可以直接沿用。
 */

export const MODEL_ID = 'bge-small-zh-v1.5'
export const EMBED_DIM = 512
/** 单条文本上限（token）。语料是摘要级，≤400 字，512 足够；超长截断 */
const MAX_TOKENS = 512

/**
 * 模型目录：打包后在 `<App>/Contents/Resources/resources/models/`，开发时在仓库 `resources/models/`。
 * `app` 在 ELECTRON_RUN_AS_NODE 下是 undefined（冒烟就是这么跑的），所以不能无条件调 getAppPath；
 * 开发态兜底用 `__dirname/../..`（out/main → 仓库根），与打包态的 resourcesPath 两条路都覆盖。
 */
export function modelDir(): string {
  // 惰性取 electron：包内以 ELECTRON_RUN_AS_NODE 跑冒烟时 `require('electron')` 会抛 MODULE_NOT_FOUND
  //（asar 里没有那个 npm 包），静态 import 会让整个 smoke-embed 起不来——打包形态第一次实测就栽在这
  let appPath = ''
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    appPath = (require('electron') as { app?: { getAppPath?: () => string } }).app?.getAppPath?.() ?? ''
  } catch {
    /* 非 Electron 上下文 */
  }
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'resources', 'models', MODEL_ID) : '',
    appPath ? join(appPath, 'resources', 'models', MODEL_ID) : '',
  ].filter(Boolean)
  // 开发态兜底：从本文件所在目录往上找仓库根（electron-vite 会把本模块打进 out/main/chunks/，层级不固定）
  let up = __dirname
  for (let i = 0; i < 5; i++) {
    candidates.push(join(up, 'resources', 'models', MODEL_ID))
    up = join(up, '..')
  }
  for (const c of candidates) if (existsSync(join(c, 'model_quantized.onnx'))) return c
  return candidates[0] || join(__dirname, 'resources', 'models', MODEL_ID)
}

// ---- 分词（BertNormalizer + BertPreTokenizer + WordPiece）------------------------------

const isCJK = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f)
const PUNCT = /[\p{P}\p{S}]/u

export class WordPiece {
  private vocab: Record<string, number>
  readonly unk: number
  readonly cls: number
  readonly sep: number
  constructor(tokenizerJson: string) {
    const t = JSON.parse(tokenizerJson) as { model: { vocab: Record<string, number> } }
    this.vocab = t.model.vocab
    this.unk = this.vocab['[UNK]']
    this.cls = this.vocab['[CLS]']
    this.sep = this.vocab['[SEP]']
  }

  /** 与 tokenizers 库的 BertNormalizer(clean_text, handle_chinese_chars, lowercase=false) + BertPreTokenizer 同一口径 */
  encode(text: string, maxLen = MAX_TOKENS): number[] {
    let s = ''
    for (const c of text.normalize('NFC')) {
      const cp = c.codePointAt(0)!
      if (cp === 0 || cp === 0xfffd || (cp < 0x20 && !/\s/.test(c))) continue
      if (/\s/.test(c)) {
        s += ' '
        continue
      }
      s += isCJK(cp) ? ` ${c} ` : c
    }
    const words: string[] = []
    for (const w of s.split(/\s+/).filter(Boolean)) {
      let cur = ''
      for (const c of w) {
        if (PUNCT.test(c)) {
          if (cur) words.push(cur)
          words.push(c)
          cur = ''
        } else cur += c
      }
      if (cur) words.push(cur)
    }
    const ids = [this.cls]
    for (const w of words) {
      if (ids.length >= maxLen - 1) break
      if (w.length > 100) {
        ids.push(this.unk)
        continue
      }
      let start = 0
      const sub: number[] = []
      let bad = false
      while (start < w.length) {
        let end = w.length
        let found: number | undefined
        while (start < end) {
          const piece = (start > 0 ? '##' : '') + w.slice(start, end)
          if (piece in this.vocab) {
            found = this.vocab[piece]
            break
          }
          end--
        }
        if (found === undefined) {
          bad = true
          break
        }
        sub.push(found)
        start = end
      }
      ids.push(...(bad ? [this.unk] : sub))
    }
    ids.push(this.sep)
    return ids.slice(0, maxLen)
  }
}

// ---- 推理 ---------------------------------------------------------------------------------

type Ort = typeof import('onnxruntime-node')

export interface EmbedderInfo {
  ok: boolean
  reason?: string
  loadMs?: number
  dir: string
}

/**
 * 模型会话。`load()` 失败不抛——返回原因，上层据此降级并**说出来**（设置页「语义索引：不可用（原因）」），
 * 这是 Q13 那条教训：不许把失败静默成"已就绪"。
 */
export class Embedder {
  private session: import('onnxruntime-node').InferenceSession | null = null
  private ort: Ort | null = null
  private tok: WordPiece | null = null
  readonly dir = modelDir()
  /**
   * 线程数（intra/inter op），默认 2（960 篇 1.9 s；1 线程 3.5 s）。
   * **onnxruntime-node 必须 ≥1.29**：1.21 在 Electron 43（Node 24）里进程退出时静态析构撞锁，
   * `mutex lock failed` → SIGABRT，与线程数、是否 release()、是否 process.exit 都无关（2026-09-05 五种组合全试过）；
   * 升到 1.29.0 消失。`smoke:embed` 的退出码守着这条——它要是又崩，先查版本
   */
  constructor(private readonly threads = 2) {}

  get ready(): boolean {
    return !!this.session
  }

  async load(): Promise<EmbedderInfo> {
    if (this.session) return { ok: true, loadMs: 0, dir: this.dir }
    const t0 = Date.now()
    try {
      const model = join(this.dir, 'model_quantized.onnx')
      const tokenizer = join(this.dir, 'tokenizer.json')
      if (!existsSync(model) || !existsSync(tokenizer)) return { ok: false, reason: `模型文件缺失：${this.dir}`, dir: this.dir }
      // 动态 import：原生模块加载失败（架构不对 / 被隔离 / 缺库）要能被 catch 住并降级，不许把主进程带崩
      this.ort = await import('onnxruntime-node')
      this.tok = new WordPiece(readFileSync(tokenizer, 'utf-8'))
      this.session = await this.ort.InferenceSession.create(model, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: this.threads,
        interOpNumThreads: this.threads,
      })
      return { ok: true, loadMs: Date.now() - t0, dir: this.dir }
    } catch (e) {
      this.session = null
      return { ok: false, reason: e instanceof Error ? e.message : String(e), dir: this.dir }
    }
  }

  /** 卸载释放内存（空闲一段时间后由上层调用；下次 embed 前再 load，热加载约 0.1 s） */
  async unload(): Promise<void> {
    await this.session?.release()
    this.session = null
  }

  /** 一批文本 → 归一化 CLS 向量。**批内按最长序列补齐**，别把 16 条短摘要和 1 条长文放一批 */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.session || !this.ort || !this.tok) throw new Error('embedder 未加载')
    const ort = this.ort
    const seqs = texts.map((t) => this.tok!.encode(t))
    const n = seqs.length
    const L = Math.max(1, ...seqs.map((s) => s.length))
    const ids = new BigInt64Array(n * L)
    const mask = new BigInt64Array(n * L)
    const types = new BigInt64Array(n * L)
    seqs.forEach((s, i) =>
      s.forEach((id, j) => {
        ids[i * L + j] = BigInt(id)
        mask[i * L + j] = 1n
      })
    )
    const feeds: Record<string, import('onnxruntime-node').Tensor> = {
      input_ids: new ort.Tensor('int64', ids, [n, L]),
      attention_mask: new ort.Tensor('int64', mask, [n, L]),
    }
    if (this.session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', types, [n, L])
    const out = await this.session.run(feeds)
    const h = out[this.session.outputNames[0]]
    const dim = h.dims[2]
    const data = h.data as Float32Array
    return seqs.map((_, i) => {
      const v = Float32Array.from(data.subarray(i * L * dim, i * L * dim + dim))
      let norm = 0
      for (const x of v) norm += x * x
      norm = Math.sqrt(norm) || 1
      for (let k = 0; k < v.length; k++) v[k] /= norm
      return v
    })
  }
}

/** 余弦（向量已归一化 → 点积） */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
