#!/usr/bin/env node
/**
 * 检索准确率基准 —— 编排 + 汇总（Node 侧）。
 *
 * 它是后续所有检索优化的尺子：先有数字，再谈"提高"。题目在 e2e/retrieval-bench/bench.jsonl
 * （标准答案由人读原文档写，不是模型生成的），执行端是 out/main/retrieval-bench.js
 * （跑在 Electron 主进程里，用产品自己的对话链路逐题作答，见 src/main/retrieval-bench.ts）。
 *
 * 跑法（在 desktop/ 下）：
 *   npm run bench:retrieval -- --dry-run          # 只报题数与预算，不花钱
 *   npm run bench:retrieval                        # 全量：建库副本 → 跑 45 题 → 判分 → 汇总
 *   npm run bench:retrieval -- --only M-K1,T-1     # 只跑几题（调试）
 *   npm run bench:retrieval -- --type trap         # 只跑一类
 *   npm run bench:retrieval -- --split validate    # 只看验证集（15 题）；调参只许看 --split tune（30 题）
 *   npm run bench:retrieval -- --merge rrf         # 第三单：语义合并方式 channel（默认）| rrf；--no-semantic 关掉语义通道跑对照
 *   npm run bench:retrieval -- --from <results.jsonl> [--json]   # 只重新汇总一份已有结果
 *   npm run bench:retrieval -- [--from …] --baseline <基线 results.jsonl>  # 附对照基线的 diff 表（每格 本轮 (Δpp)）
 *   npm run bench:retrieval -- --rejudge <results.jsonl>         # 用同一份回答重新判分（不再跑对话）
 *   npm run bench:retrieval -- --rejudge <results.jsonl> --rejudge-failed   # 只补判上次判分失败的题
 *   npm run bench:retrieval -- --rereplay <results.jsonl> --merge <那轮的 merge>  # 零 LLM：重放双通道检索，重算「摆到面前」口径（回答与判分不动）
 *
 * key 来源（二选一）：
 *   默认用测试账号登录，服务端按契约 v2 下发标准档（与客户机同一条路，Supabase 必须醒着）
 *   或 BENCH_API_KEY=… BENCH_BASE_URL=https://api.deepseek.com/anthropic（只进内存，不碰 Keychain）
 *
 * 库：默认把 ~/Documents/AI/maggie-vault 与 ~/Downloads/我的知识库 各复制一份到 /tmp/mcnai-bench-*
 *（排除 .git 与 _assets——检索只吃 .md，图片不影响问答），原库零写入。--vault-maggie / --vault-jerry 可换源。
 *
 * 判分口径全部写在 e2e/retrieval-bench/README.md；本文件只算数，不做判断。
 */
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BENCH_DIR = join(ROOT, 'e2e', 'retrieval-bench')
const BENCH_FILE = join(BENCH_DIR, 'bench.jsonl')

// ---------------- 参数 ----------------
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return def
  const v = argv[i + 1]
  if (!v || v.startsWith('--')) return def
  return v
}
const DRY = flag('dry-run')
const NO_BUILD = flag('no-build')
const NO_JUDGE = flag('no-judge')
const JSON_OUT = flag('json')
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
const TYPE = opt('type', '')
/**
 * 调参集 / 验证集（用户拍板，2026-09-05）：bench.jsonl 每题带 `split: tune|validate`（30/15，按题型分层）。
 * 引擎参数只在 tune 上调，对外报的数字只看 validate——同一套题上调参又报分是自己骗自己。
 */
const SPLIT = opt('split', '')
/** 第三单：语义通道合并方式（channel | rrf）与开关（--no-semantic 跑对照） */
const MERGE = opt('merge', '')
const NO_SEMANTIC = flag('no-semantic')
const FROM = opt('from', '')
const BASELINE = opt('baseline', '') // 另一份 results.jsonl：汇总时并排给出每项指标的变化（对照基线出 diff 表）
const REJUDGE = opt('rejudge', '')
const REJUDGE_FAILED = flag('rejudge-failed') // 与 --rejudge 同用：只补判上次判分失败的题
const REREPLAY = opt('rereplay', '') // 零 LLM：按记录的检索词重放双通道检索，重算「摆到面前」；回答与判分原样保留（--merge 要与那轮一致）
const TIMEOUT_MS = Number(opt('timeout', '420000'))
const OUT_DIR = resolve(opt('out-dir', join(BENCH_DIR, 'runs', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))))
const SRC_MAGGIE = opt('vault-maggie', join(homedir(), 'Documents', 'AI', 'maggie-vault'))
const SRC_JERRY = opt('vault-jerry', join(homedir(), 'Downloads', '我的知识库'))
const NO_COPY = flag('no-copy')
const USER_DATA = process.env.MCNAI_BENCH_USERDATA || '/tmp/mcnai-bench-userdata'
const VAULTS = { maggie: NO_COPY ? SRC_MAGGIE : '/tmp/mcnai-bench-maggie', jerry: NO_COPY ? SRC_JERRY : '/tmp/mcnai-bench-jerry' }

/** 与 e2e/jerry-acceptance.mjs 同一个测试账号（仓库里已有明文，不是新增的秘密） */
const TEST_LOGIN = { email: 'mcnai-test-a@example.com', password: 'McnAi-Test-2026!' }

/**
 * 预算估算用的单题均价（¥）。**不是实测口径**——实测数字跑完由账本给（见汇总里的"实花"）。
 * 依据：2026-09-05 冒烟两题的账本：关键词题 33k 输入 + 60k 缓存读 + 0.5k 输出 ≈ ¥0.16，
 * 陷阱题（Grep 三次）37k + 156k 缓存 + 3.3k 输出 ≈ ¥0.23 → 取 ¥0.20/题；
 * 判分一次约 3k 输入 + 0.6k 输出 token，按 deepseek-v4-pro ¥4.5/¥13.5 每百万 ≈ ¥0.02。
 */
const EST_PER_Q_CNY = 0.2
const EST_JUDGE_CNY = 0.02

// ---------------- 题目 ----------------
function loadQuestions() {
  const rows = readFileSync(BENCH_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l)
      } catch (e) {
        throw new Error(`bench.jsonl 第 ${i + 1} 行不是合法 JSON：${e.message}`)
      }
    })
  const ids = new Set()
  for (const q of rows) {
    for (const k of ['id', 'type', 'vault', 'question', 'gold_points', 'expected_files']) {
      if (!(k in q)) throw new Error(`题 ${q.id ?? '(无 id)'} 缺字段 ${k}`)
    }
    if (ids.has(q.id)) throw new Error(`题号重复：${q.id}`)
    ids.add(q.id)
    if (q.type !== 'trap' && (!q.gold_points.length || !q.expected_files.length)) {
      throw new Error(`题 ${q.id} 不是陷阱题却没有要点或应命中文件`)
    }
  }
  return rows
}

function filterQuestions(all) {
  let qs = all.filter((q) => !q.retired)
  if (ONLY.length) qs = qs.filter((q) => ONLY.includes(q.id))
  if (TYPE) qs = qs.filter((q) => q.type === TYPE)
  if (SPLIT) qs = qs.filter((q) => (q.split ?? 'tune') === SPLIT)
  return qs
}

/** 应命中文件必须真的在库里——写错路径的题会把"召回 0"错判成产品的锅 */
function checkExpectedFiles(qs) {
  const missing = []
  for (const q of qs) {
    const root = VAULTS[q.vault]
    for (const f of q.expected_files) if (!existsSync(join(root, f))) missing.push(`${q.id}: ${f}`)
  }
  if (missing.length) throw new Error(`以下应命中文件在库里找不到（先修题目，再跑）：\n  ${missing.join('\n  ')}`)
}

// ---------------- 建库副本 ----------------
function prepareVaults(qs) {
  const needed = new Set(qs.map((q) => q.vault))
  for (const v of needed) {
    const src = v === 'maggie' ? SRC_MAGGIE : SRC_JERRY
    if (!existsSync(src)) throw new Error(`库源不存在：${src}（用 --vault-${v} 指定）`)
    if (NO_COPY) continue
    const dst = VAULTS[v]
    mkdirSync(dst, { recursive: true })
    console.log(`[prep] rsync ${src} → ${dst}（排除 .git / _assets）`)
    const r = spawnSync('rsync', ['-a', '--delete', '--exclude', '.git', '--exclude', '_assets', '--exclude', '.obsidian', `${src}/`, `${dst}/`], {
      stdio: 'inherit',
    })
    if (r.status !== 0) throw new Error(`rsync 失败（${r.status}）`)
  }
}

// ---------------- 汇总 ----------------
const noteKey = (p) => String(p).replace(/\.md$/i, '').toLowerCase()
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`)
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`)

function scoreRow(r) {
  const exp = new Set((r.expected_files ?? []).map(noteKey))
  const shown = new Set((r.surfacedShown ?? []).map(noteKey))
  const all = new Set((r.surfacedAll ?? []).map(noteKey))
  const reads = new Set((r.reads ?? []).map(noteKey))
  const hitShown = [...exp].filter((f) => shown.has(f)).length
  const hitAll = [...exp].filter((f) => all.has(f)).length
  const hitRead = [...exp].filter((f) => reads.has(f)).length
  const isTrap = r.type === 'trap'

  const pts = r.judge?.points ?? []
  const score = (v) => (v === 'covered' ? 1 : v === 'partial' ? 0.5 : 0)
  const coverage = !isTrap && pts.length ? mean(pts.map((p) => score(p.verdict))) : null
  /**
   * 核心要点覆盖率：只看前 2 条要点。bench.jsonl 的要点按"问题直接问的 → 顺带该讲的"排序，
   * 前 2 条就是问题本身的答案。全量覆盖率会把"答对了但没多讲"和"答错了"混在一起
   * （首轮基线 M-K5：问几天/指定品，两条都答对，但 4 条要点只覆盖 38%），这一列把两者拆开。
   */
  const coreCoverage = !isTrap && pts.length ? mean(pts.slice(0, 2).map((p) => score(p.verdict))) : null
  const judged = !!r.judge && !r.judge.error

  const resolved = (r.citations ?? []).filter((c) => c.resolved)
  const correctCites = resolved.filter((c) => exp.has(noteKey(c.resolved))).length
  const unresolved = (r.citations ?? []).length - resolved.length
  /**
   * 引用错位（尺子第二版，2026-09-05 拍板）：预期集合之外的引用不再一律算错，
   * 判分看了文件摘要/正文开头/引用句之后判"与问题相关不相关"，**不相关**才算错位。
   * 判分没给出相关性（老结果、判分失败）的记成"未判"，不算错也不算对。
   */
  const offTarget = resolved.filter((c) => !exp.has(noteKey(c.resolved)))
  const jc = new Map((r.judge?.citations ?? []).map((c) => [String(c.name).trim(), c]))
  let misplaced = 0
  let unjudgedOff = 0
  for (const c of offTarget) {
    const v = jc.get(String(c.name).trim())
    if (!v) unjudgedOff++
    else if (v.relevant === false) misplaced++
  }

  const refusal = r.judge?.refusal
  const trapOk = isTrap && judged ? !!refusal?.says_not_found && !refusal?.fabricated : null
  const falseNotFound = !isTrap && judged ? !!refusal?.says_not_found : null

  return {
    id: r.id,
    type: r.type,
    vault: r.vault,
    sensitive: !!r.sensitive,
    ok: !!r.ok,
    error: r.error,
    stopped: !!r.stopped,
    durationMs: r.durationMs,
    costCny: r.usage?.costCny ?? 0,
    judgeCostCny: r.judge?.costCny ?? 0,
    tokens: r.usage?.tokens,
    expectedCount: exp.size,
    hitShown,
    hitAll,
    hitRead,
    recallShown: exp.size ? hitShown / exp.size : null,
    recallAll: exp.size ? hitAll / exp.size : null,
    allHit: exp.size ? hitShown === exp.size : null,
    anyHit: exp.size ? hitShown > 0 : null,
    coverage,
    coreCoverage,
    judged,
    judgeError: r.judge?.error,
    points: pts,
    citationsTotal: (r.citations ?? []).length,
    citationsResolved: resolved.length,
    citationsCorrect: correctCites,
    citationsUnresolved: unresolved,
    citationsOffTarget: offTarget.length,
    citationsMisplaced: misplaced,
    citationsUnjudged: unjudgedOff,
    misplacedQuestion: misplaced > 0,
    citationJudgments: r.judge?.citations ?? [],
    unverifiedCitations: r.unverifiedCitations ?? [],
    trapOk,
    falseNotFound,
    refusal,
    searches: r.searches ?? [],
    reads: r.reads ?? [],
    scans: r.scans ?? [],
    answer: r.answer ?? '',
    question: r.question,
    models: r.models ?? [],
  }
}

/** 引用错位率格子：`题占比｜错/总条`，有未判的相关性就标出来，别让老结果的 0 看起来像"零错位" */
const misp = (g) => {
  if (g.misplacedRate == null) return '—'
  const tail = g.unjudgedCites ? `，${g.unjudgedCites} 条未判` : ''
  return `${pct(g.misplacedRate)}｜${g.misplacedCites}/${g.citationsResolved}${tail}`
}

const TYPE_LABEL = { keyword: '①关键词题', semantic: '②语义题', multi: '③跨文档汇总题', sensitive: '④敏感区题', trap: '⑤陷阱题' }
const TYPE_ORDER = ['keyword', 'semantic', 'multi', 'sensitive', 'trap']

function aggregate(rows) {
  const scored = rows.map(scoreRow)
  const groups = {}
  for (const t of TYPE_ORDER) {
    const g = scored.filter((s) => s.type === t)
    if (!g.length) continue
    const nonTrap = g.filter((s) => s.type !== 'trap')
    const cites = nonTrap.reduce((a, s) => a + s.citationsResolved, 0)
    const citesOk = nonTrap.reduce((a, s) => a + s.citationsCorrect, 0)
    groups[t] = {
      label: TYPE_LABEL[t],
      n: g.length,
      ok: g.filter((s) => s.ok).length,
      recallShown: mean(nonTrap.map((s) => s.recallShown).filter((x) => x != null)),
      recallAll: mean(nonTrap.map((s) => s.recallAll).filter((x) => x != null)),
      allHitRate: nonTrap.length ? nonTrap.filter((s) => s.allHit).length / nonTrap.length : null,
      readRate: mean(nonTrap.map((s) => (s.expectedCount ? s.hitRead / s.expectedCount : null)).filter((x) => x != null)),
      coverage: mean(nonTrap.map((s) => s.coverage).filter((x) => x != null)),
      coreCoverage: mean(nonTrap.map((s) => s.coreCoverage).filter((x) => x != null)),
      judged: g.filter((s) => s.judged).length,
      citationPrecision: cites ? citesOk / cites : null,
      misplacedRate: nonTrap.length ? nonTrap.filter((s) => s.misplacedQuestion).length / nonTrap.length : null,
      misplacedCites: nonTrap.reduce((a, s) => a + s.citationsMisplaced, 0),
      unjudgedCites: nonTrap.reduce((a, s) => a + s.citationsUnjudged, 0),
      citationsResolved: cites,
      citationsUnresolved: nonTrap.reduce((a, s) => a + s.citationsUnresolved, 0),
      noCitation: nonTrap.filter((s) => s.citationsTotal === 0).length,
      medianMs: median(g.map((s) => s.durationMs).filter((x) => x != null)),
      p90Ms: (() => {
        const xs = g.map((s) => s.durationMs).filter((x) => x != null).sort((a, b) => a - b)
        return xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))] : null
      })(),
      costCny: g.reduce((a, s) => a + s.costCny, 0),
      judgeCostCny: g.reduce((a, s) => a + s.judgeCostCny, 0),
      trapRefusalRate: t === 'trap' ? (g.filter((s) => s.judged).length ? g.filter((s) => s.trapOk).length / g.filter((s) => s.judged).length : null) : null,
      falseNotFound: nonTrap.filter((s) => s.falseNotFound).length,
      stopped: g.filter((s) => s.stopped).length,
    }
  }
  const totalCost = scored.reduce((a, s) => a + s.costCny, 0)
  const totalJudge = scored.reduce((a, s) => a + s.judgeCostCny, 0)
  return { groups, scored, totals: { n: scored.length, costCny: totalCost, judgeCostCny: totalJudge, allCny: totalCost + totalJudge } }
}

function renderMarkdown(agg, meta) {
  const L = []
  L.push(`| 题型 | 题数 | 召回命中率 | 全命中率 | 读到率 | 要点覆盖率 | 核心要点覆盖率（前2条） | 引用错位率（题｜条） | 中位耗时 | P90 耗时 | 实花（对话） |`)
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|`)
  for (const t of TYPE_ORDER) {
    const g = agg.groups[t]
    if (!g) continue
    if (t === 'trap') {
      L.push(`| ${g.label} | ${g.n} | — | — | — | 拒答率 ${pct(g.trapRefusalRate)} | — | — | ${sec(g.medianMs)} | ${sec(g.p90Ms)} | ¥${g.costCny.toFixed(2)} |`)
    } else {
      L.push(
        `| ${g.label} | ${g.n} | ${pct(g.recallShown)} | ${pct(g.allHitRate)} | ${pct(g.readRate)} | ${pct(g.coverage)} | ${pct(g.coreCoverage)} | ${misp(g)} | ${sec(g.medianMs)} | ${sec(g.p90Ms)} | ¥${g.costCny.toFixed(2)} |`
      )
    }
  }
  const nonTrap = agg.scored.filter((s) => s.type !== 'trap')
  const cites = nonTrap.reduce((a, s) => a + s.citationsResolved, 0)
  const citesOk = nonTrap.reduce((a, s) => a + s.citationsCorrect, 0)
  L.push(
    `| **合计** | ${agg.totals.n} | ${pct(mean(nonTrap.map((s) => s.recallShown).filter((x) => x != null)))} | ${pct(nonTrap.length ? nonTrap.filter((s) => s.allHit).length / nonTrap.length : null)} | ${pct(mean(nonTrap.map((s) => (s.expectedCount ? s.hitRead / s.expectedCount : null)).filter((x) => x != null)))} | ${pct(mean(nonTrap.map((s) => s.coverage).filter((x) => x != null)))} | ${pct(mean(nonTrap.map((s) => s.coreCoverage).filter((x) => x != null)))} | ${misp({ misplacedRate: nonTrap.length ? nonTrap.filter((s) => s.misplacedQuestion).length / nonTrap.length : null, misplacedCites: nonTrap.reduce((a, s) => a + s.citationsMisplaced, 0), citationsResolved: cites, unjudgedCites: nonTrap.reduce((a, s) => a + s.citationsUnjudged, 0) })} | ${sec(median(agg.scored.map((s) => s.durationMs)))} | — | ¥${agg.totals.costCny.toFixed(2)}（判分另 ¥${agg.totals.judgeCostCny.toFixed(2)}） |`
  )
  L.push('')
  L.push(`> 口径：召回命中率 = 应命中文件里被摆到模型面前（检索前 6 条 ∪ Read 过）的比例，按题平均；全命中率 = 应命中文件全部被摆到面前的题占比；读到率 = 应命中文件真的被 Read 的比例；要点覆盖率 = 判分 covered 1 / partial 0.5 / missing 0 按题平均；核心要点覆盖率 = 只算每题前 2 条要点（问题直接问的那部分）；引用错位率 = 引用了与问题不相关文件的题占比｜错位引用条数/解析到文件的引用条数（预期集合内天然相关；集合外由判分看文件摘要与引用句判相关性并写明依据；「未判」= 老结果没有相关性判定）；陷阱题拒答率 = 明确说"库里没有"且未编造的比例。`)
  if (meta?.provider) L.push(`> 线路：${meta.provider.baseUrl} / ${meta.provider.model}；开始 ${meta.startedAt}${meta.finishedAt ? `，结束 ${meta.finishedAt}` : ''}`)
  L.push('')
  L.push('### 逐题明细')
  L.push('')
  L.push('| 题号 | 题型 | 库 | 状态 | 耗时 | 检索/读/扫 | 应命中→命中(读到) | 要点 | 引用 错位/集合外/解析（未判） | 花费 |')
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const s of agg.scored) {
    const status = s.error ? `❌ ${s.error.slice(0, 40)}` : s.stopped ? '⏱ 超时停止' : '✓'
    const pts = s.type === 'trap' ? (s.judged ? (s.trapOk ? '拒答 ✓' : `未拒答（${s.refusal?.says_not_found ? '说了没有但有编造' : '当成有答了'}）`) : '未判') : s.judged ? `${pct(s.coverage)}（${s.points.map((p) => (p.verdict === 'covered' ? '●' : p.verdict === 'partial' ? '◐' : '○')).join('')}）` : `未判${s.judgeError ? '：' + s.judgeError.slice(0, 30) : ''}`
    L.push(
      `| ${s.id} | ${s.type}${s.sensitive && s.type !== 'sensitive' ? '·敏' : ''} | ${s.vault} | ${status} | ${sec(s.durationMs)} | ${s.searches.length}/${s.reads.length}/${s.scans.length} | ${s.expectedCount}→${s.hitShown}(${s.hitRead}) | ${pts} | ${s.citationsMisplaced}/${s.citationsOffTarget}/${s.citationsResolved}${s.citationsUnjudged ? `（${s.citationsUnjudged} 未判）` : ''} | ¥${s.costCny.toFixed(3)} |`
    )
  }
  return L.join('\n')
}

/**
 * 对照表：本轮 vs 基线，每格 `本轮 (Δ)`。Δ 用百分点（耗时用秒）。
 * 逐题一栏只列**变化了的题**（召回/覆盖/引用任一项变了），没变的不占版面。
 */
function renderDiff(agg, base, baseLabel) {
  const L = []
  const d = (a, b, fmt = pct) => {
    if (a == null || b == null) return fmt(a)
    const delta = a - b
    const sign = delta > 0 ? '+' : ''
    const dl = fmt === sec ? `${sign}${(delta / 1000).toFixed(1)}s` : `${sign}${(delta * 100).toFixed(0)}pp`
    return `${fmt(a)} (${dl})`
  }
  const money = (a, b) => `¥${a.toFixed(2)}${b != null ? ` (${a - b >= 0 ? '+' : ''}${(a - b).toFixed(2)})` : ''}`
  L.push(`### 对照基线（${baseLabel}）`)
  L.push('')
  L.push('| 题型 | 召回命中率 | 全命中率 | 读到率 | 要点覆盖率 | 核心要点覆盖率 | 引用错位率（题｜条） | 中位耗时 | 实花 |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  for (const t of TYPE_ORDER) {
    const g = agg.groups[t]
    const b = base.groups[t]
    if (!g) continue
    if (t === 'trap') {
      L.push(`| ${g.label} | — | — | — | 拒答 ${d(g.trapRefusalRate, b?.trapRefusalRate)} | — | — | ${d(g.medianMs, b?.medianMs, sec)} | ${money(g.costCny, b?.costCny)} |`)
      continue
    }
    L.push(
      `| ${g.label} | ${d(g.recallShown, b?.recallShown)} | ${d(g.allHitRate, b?.allHitRate)} | ${d(g.readRate, b?.readRate)} | ${d(g.coverage, b?.coverage)} | ${d(g.coreCoverage, b?.coreCoverage)} | ${misp(g)}${b ? ` ← 基线 ${misp(b)}` : ''} | ${d(g.medianMs, b?.medianMs, sec)} | ${money(g.costCny, b?.costCny)} |`
    )
  }
  L.push(`| **合计** | | | | | | | | ${money(agg.totals.costCny, base.totals.costCny)}，判分 ¥${agg.totals.judgeCostCny.toFixed(2)} |`)
  L.push('')
  L.push('逐题变化（只列有变化的）：')
  L.push('')
  L.push('| 题号 | 题型 | 应命中→命中 | 要点覆盖 | 核心覆盖 | 引用 错位/解析 | 耗时 |')
  L.push('|---|---|---|---|---|---|---|')
  const bs = new Map(base.scored.map((s) => [s.id, s]))
  const n = (x) => (x == null ? '—' : String(x))
  const arrow = (a, b, fmt) => (a === b ? fmt(a) : `${fmt(b)} → ${fmt(a)}`)
  for (const s of agg.scored) {
    const b = bs.get(s.id)
    if (!b) continue
    const changed =
      s.hitShown !== b.hitShown ||
      s.coverage !== b.coverage ||
      s.citationsMisplaced !== b.citationsMisplaced ||
      s.citationsResolved !== b.citationsResolved ||
      (s.type === 'trap' && s.trapOk !== b.trapOk)
    if (!changed) continue
    L.push(
      `| ${s.id} | ${s.type} | ${s.expectedCount}→${arrow(s.hitShown, b.hitShown, n)} | ${s.type === 'trap' ? (s.trapOk ? '拒答 ✓' : '未拒答') : arrow(s.coverage, b.coverage, pct)} | ${s.type === 'trap' ? '—' : arrow(s.coreCoverage, b.coreCoverage, pct)} | ${arrow(s.citationsMisplaced, b.citationsMisplaced, n)}/${arrow(s.citationsResolved, b.citationsResolved, n)} | ${arrow(s.durationMs, b.durationMs, sec)} |`
    )
  }
  return L.join('\n')
}

/** 逐题的判分理由——给人复核用，客户问"准确率怎么来的"时拿这个 */
function renderDetails(agg) {
  const L = []
  for (const s of agg.scored) {
    L.push(`## ${s.id} · ${TYPE_LABEL[s.type]} · ${s.vault}${s.sensitive ? ' · 敏感' : ''}`)
    L.push('')
    L.push(`**问**：${s.question}`)
    L.push('')
    L.push(`**状态**：${s.error ? '出错：' + s.error : s.stopped ? '超时停止' : '正常'}｜耗时 ${sec(s.durationMs)}｜模型 ${s.models.join('/') || '—'}｜花费 ¥${s.costCny.toFixed(3)}`)
    L.push('')
    L.push('**检索过程**：')
    for (const q of s.searches) L.push(`- search「${q.query}」→ ${q.total} 条${q.fuzzy ? '（相近结果）' : ''}：${q.shown.map((p) => p.split('/').pop()).join('、') || '无'}`)
    for (const f of s.reads) L.push(`- Read《${f}》`)
    for (const g of s.scans) L.push(`- ${g.tool}「${g.pattern}」${g.path ? ' @' + g.path : ''} → ${g.capped ? '被护栏拦下' : g.count ?? '?'}`)
    if (!s.searches.length && !s.reads.length && !s.scans.length) L.push('- （没有任何工具调用）')
    L.push('')
    if (s.type !== 'trap') {
      L.push(`**应命中**：${s.expectedCount} 份 → 摆到面前 ${s.hitShown}，读到 ${s.hitRead}`)
      L.push('')
    }
    L.push('**回答**：')
    L.push('')
    L.push('> ' + s.answer.replace(/\n/g, '\n> '))
    L.push('')
    if (s.citationsTotal) {
      L.push(`**引用**：解析到文件 ${s.citationsResolved} / 解析不到 ${s.citationsUnresolved}；集合内 ${s.citationsCorrect}，集合外 ${s.citationsOffTarget}（错位 ${s.citationsMisplaced}${s.citationsUnjudged ? `，未判 ${s.citationsUnjudged}` : ''}）${s.unverifiedCitations.length ? `；产品自己标为"存疑"的：${s.unverifiedCitations.join('、')}` : ''}`)
      for (const c of s.citationJudgments) L.push(`- [[${c.name}]] ${c.relevant ? '相关' : '**不相关（错位）**'} —— ${String(c.basis ?? '').replace(/\n/g, ' ')}`)
      L.push('')
    }
    if (s.judged) {
      if (s.type === 'trap') {
        L.push(`**判分（陷阱）**：${s.trapOk ? '✅ 敢说没有' : '❌ 没有拒答'} —— 说了没有=${s.refusal?.says_not_found}，编造=${s.refusal?.fabricated}。${s.refusal?.reason ?? ''}`)
      } else {
        L.push(`**判分**：覆盖率 ${pct(s.coverage)}${s.falseNotFound ? '（⚠️ 回答自称"库里没有"）' : ''}`)
        L.push('')
        L.push('| # | 判定 | 理由 | 证据（回答原文） |')
        L.push('|---|---|---|---|')
        for (const p of s.points) L.push(`| ${p.idx} | ${p.verdict} | ${String(p.reason ?? '').replace(/\|/g, '/')} | ${String(p.evidence ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`)
      }
    } else {
      L.push(`**判分**：未判分${s.judgeError ? '（' + s.judgeError + '）' : ''}`)
    }
    L.push('')
  }
  return L.join('\n')
}

// ---------------- 主流程 ----------------
async function run() {
  const all = loadQuestions()
  const qs = filterQuestions(all)
  if (!qs.length) throw new Error('筛选后没有题目')
  const byType = {}
  for (const q of qs) byType[q.type] = (byType[q.type] ?? 0) + 1

  if (FROM) {
    const ids = new Set(qs.map((q) => q.id))
    const rows = readFileSync(FROM, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => ids.has(r.id))
    if (SPLIT) console.log(`（只汇总 ${SPLIT} 集：${rows.length} 题）`)
    const metaPath = FROM.replace(/\.jsonl$/, '') + '.meta.json'
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : null
    const agg = aggregate(rows)
    emit(agg, meta, dirname(FROM))
    return
  }

  const est = REREPLAY ? 0 : qs.length * EST_PER_Q_CNY + (NO_JUDGE ? 0 : qs.length * EST_JUDGE_CNY)
  console.log(`题目 ${qs.length} 道：${Object.entries(byType).map(([t, n]) => `${TYPE_LABEL[t]} ${n}`).join('、')}`)
  if (REREPLAY) console.log(`（只重放检索：零 LLM 调用，合并方式 ${MERGE || 'channel'}）`)
  else console.log(`预算（估）：对话 ≈ ¥${(qs.length * EST_PER_Q_CNY).toFixed(2)} + 判分 ≈ ¥${(NO_JUDGE ? 0 : qs.length * EST_JUDGE_CNY).toFixed(2)} = ¥${est.toFixed(2)}（标准档 deepseek-v4-pro；实花以账本为准，跑完汇总里给）`)
  if (DRY) {
    if (!NO_COPY) console.log(`（dry-run 不建库副本、不发请求）库源：maggie=${SRC_MAGGIE} jerry=${SRC_JERRY}`)
    return
  }

  if (!NO_BUILD) {
    console.log('[build] electron-vite build …')
    const b = spawnSync('npx', ['electron-vite', 'build'], { cwd: ROOT, stdio: 'inherit' })
    if (b.status !== 0) throw new Error('构建失败')
  }
  if (!existsSync(join(ROOT, 'out', 'main', 'retrieval-bench.js'))) throw new Error('out/main/retrieval-bench.js 不存在，先 build')

  prepareVaults(qs)
  checkExpectedFiles(qs)

  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  const jobPath = join(OUT_DIR, 'job.json')
  const outPath = join(OUT_DIR, 'results.jsonl')
  const job = {
    out: outPath,
    questions: qs,
    vaults: VAULTS,
    judge: !NO_JUDGE,
    perQuestionTimeoutMs: TIMEOUT_MS,
    ...(MERGE ? { merge: MERGE } : {}),
    semantic: !NO_SEMANTIC,
    ...(process.env.BENCH_API_KEY
      ? { apiKey: process.env.BENCH_API_KEY, baseUrl: process.env.BENCH_BASE_URL || 'https://api.deepseek.com/anthropic' }
      : { login: TEST_LOGIN }),
    ...(REJUDGE ? { rejudgeFrom: resolve(REJUDGE), rejudgeFailedOnly: REJUDGE_FAILED } : {}),
    ...(REREPLAY ? { rereplayFrom: resolve(REREPLAY) } : {}),
  }
  writeFileSync(jobPath, JSON.stringify(job, null, 2))
  console.log(`[run] 结果目录 ${OUT_DIR}`)

  const electron = join(ROOT, 'node_modules', '.bin', 'electron')
  const t0 = Date.now()
  await new Promise((res, rej) => {
    const child = spawn(electron, [join(ROOT, 'out', 'main', 'retrieval-bench.js'), jobPath], {
      cwd: ROOT,
      env: { ...process.env, MCNAI_USER_DATA: USER_DATA, ELECTRON_ENABLE_LOGGING: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) if (line.startsWith('[bench]')) console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s ${line}`)
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      if (/BENCH|Error|错误|失败/.test(s)) process.stderr.write(s)
    })
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`执行端退出码 ${code}`))))
    child.on('error', rej)
  })

  const rows = readFileSync(outPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const metaPath = outPath.replace(/\.jsonl$/, '') + '.meta.json'
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : null
  const agg = aggregate(rows)
  emit(agg, meta, OUT_DIR)
}

function emit(agg, meta, dir) {
  let md = renderMarkdown(agg, meta)
  if (BASELINE) {
    const ids = new Set(agg.scored.map((s) => s.id))
    const baseRows = readFileSync(BASELINE, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => ids.has(r.id))
    md += '\n\n' + renderDiff(agg, aggregate(baseRows), BASELINE)
  }
  const details = renderDetails(agg)
  writeFileSync(join(dir, 'summary.md'), md + '\n\n' + details)
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ meta, groups: agg.groups, totals: agg.totals, questions: agg.scored }, null, 2))
  if (JSON_OUT) {
    console.log(JSON.stringify({ meta, groups: agg.groups, totals: agg.totals }, null, 2))
  } else {
    console.log('\n' + md)
    console.log(`\n明细（含逐题判分理由）：${join(dir, 'summary.md')}\nJSON：${join(dir, 'summary.json')}`)
  }
}

run().catch((e) => {
  console.error(`❌ ${e.message}`)
  process.exit(1)
})
