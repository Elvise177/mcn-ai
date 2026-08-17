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

let mini: MiniSearch
const bodies = new Map<string, string>()

function newIndex(): MiniSearch {
  return new MiniSearch({
    fields: ['title', 'body', 'tags'],
    storeFields: ['title'],
    tokenize,
    searchOptions: { boost: { title: 3, tags: 2 }, combineWith: 'AND' },
  })
}

/**
 * 虚词与疑问词：查询里去掉它们再检索（B-1 第一层）。
 *
 * 索引侧是 unigram+bigram、检索侧是 AND，于是查询串里**每个字、每对相邻字**都必须在同一篇
 * 笔记里出现。整句自然语言查询会带进一堆**跨词边界的二元组**（「公司年度目标」里的「司年」、
 * 「星母第二期」里的「母第」），这些组合在任何一篇笔记里都不存在 → 整条查询归零。
 * 实测：`公司年度目标` 0 命中 ／ `公司 年度目标` 5 命中，只差一个空格。
 *
 * 顺序按长度倒序，先剥长的（`是什么` 要在 `是` 之前剥掉）。
 */
const STOPWORDS = [
  '怎么样', '有没有', '是不是', '是什么', '为什么', '请问',
  '怎么', '怎样', '如何', '多少', '哪些', '哪个', '哪位', '什么',
  '我们', '我的', '你的', '一下', '情况', '目前', '现在', '以及',
  '最好', '最高', '最大', '最多', '最适合', '适合', '表现',
  '的', '了', '吗', '呢', '吧', '呀', '啊', '和', '与', '及', '谁', '在', '是',
].sort((a, b) => b.length - a.length)

/** 清洗后的查询。全被剥空就退回原串（宁可查不准，也不能查空） */
function cleanQuery(q: string): string {
  let s = q
  for (const w of STOPWORDS) s = s.split(w).join(' ')
  s = s.replace(/\s+/g, ' ').trim()
  return tokenize(s).length ? s : q
}

/**
 * 两遍检索（B-1）。第一遍 AND 命中就直接返回（`fuzzy=false`）；空了才跑第二遍，
 * 第二遍的结果一律标 `fuzzy=true`，让上层能把「精确命中」和「相近结果」说清楚。
 *
 * 第二遍由三道闸串起来，**每一道都是被实测逼出来的**：
 *  1. 丢掉语料里 DF=0 的 term —— 它让合取永远不可满足，而它多半就是跨词边界的二元组
 *     （「母第」「司年」「度目」）
 *  2. 存活**二元组**的覆盖率 ≥ `MIN_COVERAGE`（单字不进分母：「完/美/日/记」这种到处都是）
 *  3. **连续性**：结果必须真的包含查询的一个 ≥3 字连续片段
 *
 * 走过的弯路，别再走一遍：
 *  - **纯 OR**：任一字命中即返回，「没找到」几乎不可达。而「没找到」是问答链路防幻觉的地基
 *    ——模型分不清「我搜不到」和「库里没有」，陷阱题就从假阴性变成假阳性
 *  - **OR + 只数 term 覆盖率**：`完美日记`（库里没有这个品牌）漏 12 条，置顶正好是
 *    「向日花年框」「霞飞年框」，**恰好是最危险的张冠李戴形态**。收窄到只数二元组后仍有 3 条，
 *    因为「完美」「日记」在库里真的各自存在（「完美的妆面」+「日记账收入」）。
 *    分不开的原因是**只数命中个数不看位置**——加上第 3 道连续性闸才归零
 *  - **丢完 DF=0 后仍用全 AND**：所有查询全归零。剩下的词仍要求「每个都在同一篇」，
 *    而 `公司年度目标` 命中的那几篇根本没写「公司」
 *  - **「没有可丢的 term 就判真没有」的早退**：错的。AND 失败只说明词凑不到同一篇，
 *    每个词自己都可能在（库里既有「公司年度」又有「年度目标」，于是「司年」「度目」DF 都不为 0）
 */
/** 存活二元组的最低命中覆盖率。低了放进噪音，高了把真命中挡掉 */
const MIN_COVERAGE = 0.6

/**
 * 按**原样**的 term 检索：`tokenize: (s) => [s]` 关掉二次分词。
 *
 * 踩坑：不关的话 `search('司年')` 会被再切成 司/司年/年，单字到处都是 → 任何 term 的 DF 都 > 0，
 * 「丢掉 DF=0 的跨词二元组」这条逻辑直接失效（实测表现为**所有查询全归零**，
 * 因为早退分支认为没有可丢的）。
 */
const EXACT = { tokenize: (s: string) => [s] }

/**
 * 查询的「连续片段」：每个空格分段里长度 ≥3 的连续子串（中文），
 * 以及长度 ≥3 的英文/数字整词。用来判断一篇笔记是不是真的沾了这条查询。
 */
function queryFragments(q: string): string[] {
  const out = new Set<string>()
  for (const seg of q.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (seg.length < 3) continue
    if (/^[a-z0-9_-]+$/.test(seg)) {
      out.add(seg)
      continue
    }
    for (let n = seg.length; n >= 3; n--) {
      for (let i = 0; i + n <= seg.length; i++) out.add(seg.slice(i, i + n))
    }
  }
  return [...out]
}

/** 这篇笔记（标题或正文）含不含查询的任一连续片段 */
function hasFragment(path: string, title: string, frags: string[]): boolean {
  if (!frags.length) return true // 查询里没有 ≥3 字的片段（如「星母」），不设这道闸
  const hay = (title + '\n' + (bodies.get(path) ?? '')).toLowerCase()
  return frags.some((f) => hay.includes(f))
}

/** term → 文档频次。按索引版本缓存，重建即失效 */
let dfCache = new Map<string, number>()
function df(term: string): number {
  let v = dfCache.get(term)
  if (v === undefined) {
    v = mini.search({ queries: [term], combineWith: 'OR', ...EXACT }).length
    dfCache.set(term, v)
  }
  return v
}

function runSearch(raw: string): { results: ReturnType<MiniSearch['search']>; fuzzy: boolean } {
  const q = cleanQuery(raw)
  const strict = mini.search(q)
  if (strict.length) return { results: strict, fuzzy: false }

  const terms = [...new Set(tokenize(q))]
  const alive = terms.filter((t) => df(t) > 0)
  const grams = alive.filter((t) => t.length >= 2)
  if (!grams.length) return { results: [], fuzzy: false }
  const gramSet = new Set(grams)
  const need = Math.max(2, Math.ceil(grams.length * MIN_COVERAGE))
  const frags = queryFragments(q)
  const loose = mini
    .search({ queries: alive, combineWith: 'OR', ...EXACT })
    .filter((r) => r.terms.filter((t) => gramSet.has(t)).length >= need)
    // 第 3 道闸：连续性
    .filter((r) => hasFragment(String(r.id), String(r.title), frags))
  return { results: loose, fuzzy: loose.length > 0 }
}

function add(doc: Doc): void {
  dfCache.clear() // 索引一变，DF 就不作数了
  if (mini.has(doc.path)) mini.discard(doc.path)
  bodies.set(doc.path, plain(doc.body)) // bodies 只用于出摘要，存清洗后的纯文本
  mini.add({ id: doc.path, title: doc.title, body: doc.body, tags: doc.tags })
}

mini = newIndex()

parentPort!.on('message', (msg: { type: string; [k: string]: unknown }) => {
  switch (msg.type) {
    case 'rebuild': {
      mini = newIndex()
      bodies.clear()
      dfCache = new Map()
      for (const d of msg.docs as Doc[]) add(d)
      parentPort!.postMessage({ type: 'ready', count: (msg.docs as Doc[]).length })
      break
    }
    case 'upsert':
      add(msg.doc as Doc)
      break
    case 'remove': {
      const p = msg.path as string
      dfCache.clear()
      if (mini.has(p)) mini.discard(p)
      bodies.delete(p)
      break
    }
    case 'search': {
      const q = msg.q as string
      // 总数取截断前的命中数：UI 要显示「20 / 共 137 条」，否则截断是静默的（M-13）
      const { results: all, fuzzy } = runSearch(q)
      const hits = all.slice(0, 20).map((r) => {
        const body = bodies.get(String(r.id)) ?? ''
        // 摘要定位：先按原串找，找不到再拿最长的查询词去找。
        // 模糊那一遍原串多半不在正文里，不退而求其次的话摘要永远从第 0 字开始截，等于没有摘要
        let idx = body.indexOf(q.slice(0, 12))
        if (idx < 0) {
          for (const t of [...new Set(tokenize(cleanQuery(q)))].sort((a, b) => b.length - a.length)) {
            idx = body.indexOf(t)
            if (idx >= 0) break
          }
        }
        const at = idx >= 0 ? idx : 0
        const from = Math.max(0, at - 30)
        const to = at + 90
        return {
          path: String(r.id),
          title: String(r.title),
          snippet: (from > 0 ? '…' : '') + body.slice(from, to).trim() + (to < body.length ? '…' : ''),
        }
      })
      parentPort!.postMessage({ type: 'results', id: msg.id, hits, total: all.length, fuzzy })
      break
    }
  }
})
