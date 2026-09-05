/**
 * 检索准确率基准 —— 无头驱动（跑在 Electron 主进程里，不开窗口）。
 *
 * 它是 `scripts/retrieval-bench.mjs` 的执行端：编排脚本准备好隔离库与题目（job.json），
 * 这里用**产品自己的对话链路**（`agentManager.send`，与用户点「发送」走的是同一个函数）
 * 逐题跑，把可观测的一切原样落成 jsonl，再由编排脚本汇总成表。
 *
 * 为什么另开一个 smoke 入口而不是外挂脚本：主进程代码被 electron-vite 打成带 hash 的 chunk，
 * 外部脚本无法稳定 import `vaultManager` / `agentManager`；照 `smoke-chat.ts` 的先例在
 * 构建入口表里加一项，是唯一不改产品逻辑就能拿到这两个对象的方式。**本文件不会被应用引用。**
 *
 * 每题记录的东西（判分口径见 e2e/retrieval-bench/README.md）：
 *  - 答案正文、耗时、模型、是否超时/出错
 *  - 步骤流：search_knowledge 的检索词、Read 过的文件、Grep/Glob 次数（来自 `agentManager.tap`，
 *    与界面步骤流是同一份事件）
 *  - **被摆到模型面前的文件**：检索词逐条**重放** `vaultManager.search()` 拿命中路径（工具返回给模型的
 *    就是前 SEARCH_SHOWN_LIMIT 条，重放是确定性的），加上 Read 的入参——这与 agent/index.ts 里 B-6 的 `surfaced` 同一口径
 *  - 回答里的 `[[引用]]` 解析成路径（`vaultManager.resolveLink`，与产品校验引用用的同一函数）
 *  - 用量：读隔离 userData 的账本 jsonl 增量，花费用产品自己的 `tokensOf` + `costCny` 算，与用量页同口径
 *  - 判分：标准档同一线路（`resolveTierForRequest('standard')`），直接打 Anthropic 兼容的 /v1/messages，
 *    逐条要点给 covered / partial / missing + 理由 + 证据原文；陷阱题另判「是否敢说没有」
 *
 * key 两条路（都不碰 Keychain 落盘）：
 *  - 默认：用测试账号登录，服务端按契约 v2 下发标准档线路与 key（与真实客户机同一条路）
 *  - 备选：job.apiKey + job.baseUrl → `keyVault.preload` 只进内存（同 smoke-provider 的做法）
 *
 * 用法（由编排脚本调用）：MCNAI_USER_DATA=<隔离目录> electron out/main/retrieval-bench.js <job.json>
 */
import { app } from 'electron'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
// 只引类型：类型导入编译后消失，不会把 store 提前到 MCNAI_USER_DATA 生效之前初始化
import type { AgentStreamPayload } from './agent'

process.env.MCNAI_USER_DATA = process.env.MCNAI_USER_DATA || '/tmp/mcnai-bench-userdata'
// 与 smoke-chat 一样**显式**改 userData：env-hooks 只在 store 被 import 时才生效，而本文件在动态 import
// 之前就要用 app.getPath('userData') 找账本——第一版就是这么把账本读到真实 userData 上去的（读到 0 条）
app.setPath('userData', process.env.MCNAI_USER_DATA)

process.on('uncaughtException', (e) => {
  console.error('BENCH 崩溃（uncaughtException）:', e)
  process.exitCode = 1
})
process.on('unhandledRejection', (e) => {
  console.error('BENCH 崩溃（unhandledRejection）:', e)
  process.exitCode = 1
})

interface BenchQuestion {
  id: string
  type: 'keyword' | 'semantic' | 'multi' | 'sensitive' | 'trap'
  vault: string
  question: string
  gold_points: string[]
  expected_files: string[]
  sensitive?: boolean
  notes?: string
}

interface Job {
  out: string
  /** 进度日志（每题一行，编排脚本 tail 它） */
  questions: BenchQuestion[]
  /** vault 名 → 库根 */
  vaults: Record<string, string>
  login?: { email: string; password: string }
  apiKey?: string
  baseUrl?: string
  judge: boolean
  perQuestionTimeoutMs: number
  /** 只判分不跑（重判一份已有结果）：给了就跳过对话，直接读这个 jsonl 重判 */
  rejudgeFrom?: string
  /** 配合 rejudgeFrom：只补判上次判分失败的题，判成功的原样保留（省钱，也别让同一题的分数无故漂移） */
  rejudgeFailedOnly?: boolean
}

interface StepRec {
  id: string
  tool: string
  args?: Record<string, string>
  count?: number
  unit?: string
  failed?: boolean
  capped?: boolean
}

interface JudgePoint {
  idx: number
  verdict: 'covered' | 'partial' | 'missing'
  reason: string
  evidence: string
}
/** 预期集合之外的引用：判分要说它跟问题相关不相关，以及**依据什么**（文件摘要/正文里的哪句话） */
interface JudgeCitation {
  name: string
  relevant: boolean
  basis: string
}
/** 交给判分的引用上下文：文件标题、frontmatter 摘要、正文开头，以及回答里引用它的那句话 */
interface CitationContext {
  name: string
  path: string
  summary: string
  excerpt: string
  citedIn: string
}
interface JudgeResult {
  points: JudgePoint[]
  refusal: { says_not_found: boolean; fabricated: boolean; reason: string }
  citations?: JudgeCitation[]
  raw?: string
  error?: string
  model?: string
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  costCny?: number
}

const noteKey = (p: string): string => p.replace(/\.md$/i, '').toLowerCase()

/** 账本按月分文件；跑一题前后各数一次行数，差集就是这一题的记录 */
function ledgerLines(userData: string): string[] {
  const dir = join(userData, 'usage')
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const f of readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
    out.push(...readFileSync(join(dir, f), 'utf-8').split('\n').filter(Boolean))
  }
  return out
}

function extractJson(text: string): unknown {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s < 0 || e < 0) throw new Error('判分回复里没有 JSON')
  return JSON.parse(text.slice(s, e + 1))
}

/**
 * 「引用错位率」的素材（尺子第二版，2026-09-05 用户拍板）：预期集合**之外**的引用不再一律算错，
 * 由判分看它跟问题相关不相关。判分看不到库，所以把文件的 frontmatter 摘要 + 正文开头
 * + 回答里引用它的那句话一起递过去，并要求判分把「相关性依据」写出来。
 * 预期集合之内的引用天然相关，不送判。
 */
function buildCitationContext(
  root: string,
  expectedFiles: string[],
  citations: Array<{ name: string; resolved: string | null }>,
  answer: string
): CitationContext[] {
  const expected = new Set(expectedFiles.map(noteKey))
  const out: CitationContext[] = []
  for (const c of citations) {
    if (!c.resolved || expected.has(noteKey(c.resolved))) continue
    let summary = ''
    let excerpt = ''
    try {
      const raw = readFileSync(join(root, c.resolved), 'utf-8')
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      const body = fm ? raw.slice(fm[0].length) : raw
      summary = fm?.[1].match(/^summary:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') ?? ''
      excerpt = body.replace(/\s+/g, ' ').trim().slice(0, 400)
    } catch {
      excerpt = '（文件读不到）'
    }
    const esc = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = answer.match(new RegExp(`[^。\\n]{0,160}\\[\\[${esc}(?:[|#][^\\]]*)?\\]\\][^。\\n]{0,40}`))
    out.push({ name: c.name, path: c.resolved, summary, excerpt, citedIn: m ? m[0].trim() : '（未定位到引用句）' })
  }
  return out
}

const JUDGE_SYSTEM =
  '你是检索问答系统的评分员。只依据给你的「标准答案要点」与「系统回答」做判断，' +
  '不用自己的知识补充或推断事实。判分要保守：要点里的具体数字、名称、结论在回答里没有明确出现，就不算 covered。' +
  '输出严格 JSON，不要任何多余文字。'

function judgePrompt(q: BenchQuestion, answer: string, cites: CitationContext[] = []): string {
  const pts = q.gold_points.map((p, i) => `${i + 1}. ${p}`).join('\n')
  const citeBlock = cites.length
    ? '\n\n【引用相关性判定】下面这些是回答里引用了、但不在标准答案文件集合里的库内文件。请逐个判断它**与这个问题是否相关**' +
      '（相关 = 文件内容确实是这个问题的一部分答案或直接背景；不相关 = 只是词面沾边、或与问题无关）。' +
      'basis 必须写明依据：引用文件摘要/正文里的哪句话、以及回答里用它支撑了什么。\n' +
      cites
        .map(
          (c, i) =>
            `${i + 1}. [[${c.name}]]（${c.path}）\n   文件摘要：${c.summary || '（无）'}\n   正文开头：${c.excerpt}\n   回答里引用它的句子：${c.citedIn}`
        )
        .join('\n')
    : ''
  const trapNote =
    q.type === 'trap'
      ? '\n【说明】这是一道陷阱题：知识库里**没有**能回答这个问题的资料。正确行为是明确告诉用户没有找到/库里没有相关记录，不编造。' +
        '标准要点为空，只需判断 refusal。注意：回答在说明"没有"之后，顺带交代检索到的**相近内容**（并标了来源）属于正确行为，**不算编造**；' +
        '只有把不存在的东西当成存在来正面回答（编出名称、数字、日期、名单，或含糊地暗示"有"）才算 fabricated。'
      : ''
  return (
    `【问题】${q.question}\n【题型】${q.type}${trapNote}\n\n【标准答案要点】\n${pts || '（无）'}\n\n` +
    `【系统回答】\n<<<\n${answer || '（空回答）'}\n>>>${citeBlock}\n\n` +
    '请逐条判断标准要点是否被回答覆盖：\n' +
    '- covered：要点的核心事实（数字 / 名称 / 结论）在回答中明确出现且不矛盾；要点含多个数字时全部对上才算\n' +
    '- partial：只答到一部分，或数字 / 名称有出入但方向一致\n' +
    '- missing：没有答到，或答错\n' +
    '每条给 reason（一句话说清为什么这样判）和 evidence（从系统回答里**逐字**摘一段能支撑你判断的原文，最多 60 字；没有就写"无"）。\n\n' +
    '另外判断 refusal：\n' +
    '- says_not_found：回答是否明确表示库里没有 / 未找到 / 无相关资料（true/false）\n' +
    '- fabricated：回答是否**针对问题本身**给出了没有依据的正面事实（编出的名称、数字、日期、名单、结论），或把"没有"说成"有"（true/false）。' +
    '回答里多提到一些相关但不属于标准要点、且标注了来源的事实，不算编造\n' +
    '- reason：一句话\n\n' +
    '只输出一个 JSON 对象：{"points":[{"idx":1,"verdict":"covered|partial|missing","reason":"...","evidence":"..."}],' +
    '"refusal":{"says_not_found":false,"fabricated":false,"reason":"..."}' +
    (cites.length ? ',"citations":[{"name":"文件名","relevant":true,"basis":"..."}]' : '') +
    '}'
  )
}

async function callJudge(
  provider: { baseUrl: string; model: string; apiKey: string },
  q: BenchQuestion,
  answer: string,
  cites: CitationContext[] = []
): Promise<JudgeResult> {
  const { tokensOf } = await import('./usage')
  const { costCny, routeOf } = await import('./usage/pricing')
  // max_tokens 给足：deepseek-v4-pro 在 Anthropic 兼容端点上会先吐推理块再吐正文，
  // 1800 会在推理里就耗光（第一轮基线 45 题里 2 题"回复里没有 JSON"，就是这么来的）
  const body = {
    model: provider.model,
    max_tokens: 8000,
    temperature: 0,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: judgePrompt(q, answer, cites) }],
  }
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': provider.apiKey,
          authorization: `Bearer ${provider.apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      const data = JSON.parse(text) as {
        content?: Array<{ type: string; text?: string }>
        usage?: unknown
        model?: string
        stop_reason?: string
      }
      const reply = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
      let parsed: Partial<JudgeResult>
      try {
        parsed = extractJson(reply) as Partial<JudgeResult>
      } catch (e) {
        // 把原文带出来，别只留一句"没有 JSON"——下次排查才知道是推理块吃光了 token 还是格式漂了
        throw new Error(
          `${e instanceof Error ? e.message : String(e)}（stop_reason=${data.stop_reason ?? '?'}，块类型=${(data.content ?? []).map((c) => c.type).join('/') || '无'}，正文前 200 字：${reply.slice(0, 200).replace(/\n/g, ' ')}）`
        )
      }
      const tokens = tokensOf({ usage: data.usage })
      return {
        points: Array.isArray(parsed.points) ? parsed.points : [],
        refusal: parsed.refusal ?? { says_not_found: false, fabricated: false, reason: '（判分未给出）' },
        citations: cites.length ? (Array.isArray(parsed.citations) ? parsed.citations : []) : undefined,
        raw: reply,
        model: data.model ?? provider.model,
        tokens,
        costCny: costCny(routeOf(provider.baseUrl), data.model ?? provider.model, tokens),
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  return { points: [], refusal: { says_not_found: false, fabricated: false, reason: '' }, error: lastErr }
}

async function main(): Promise<void> {
  const jobPath = process.argv[2]
  if (!jobPath || !existsSync(jobPath)) {
    console.error('用法: retrieval-bench.js <job.json>')
    app.exit(2)
    return
  }
  const job = JSON.parse(readFileSync(jobPath, 'utf-8')) as Job
  const progress = (m: string): void => console.log(`[bench] ${m}`)

  const { vaultManager } = await import('./vault')
  // 账本目录必须在 store 初始化（env-hooks 生效）之后取，并与 usage/index.ts 的 usageDir() 同源
  const userData = app.getPath('userData')
  const { agentManager, SEARCH_SHOWN_LIMIT } = await import('./agent')
  const { resolveTierForRequest, describeTier, setTierConfig } = await import('./ai/tiers')
  const { keyVault } = await import('./store')
  const { tokensOf } = await import('./usage')
  const { costCny } = await import('./usage/pricing')

  // ---- 线路与 key ----
  if (job.apiKey) {
    if (!job.baseUrl) throw new Error('给了 apiKey 就必须给 baseUrl')
    setTierConfig('standard', { baseUrl: job.baseUrl })
    keyVault.preload('encryptedLlmKey', job.apiKey)
    progress(`标准档线路来自 job：${job.baseUrl}`)
  } else if (job.login) {
    const { login } = await import('./auth')
    progress(`登录 ${job.login.email} …`)
    const r = await login(job.login.email, job.login.password)
    if (!r.ok) throw new Error(`登录失败（${r.kind}）：${r.error ?? ''}`)
    const t0 = Date.now()
    while (Date.now() - t0 < 90_000) {
      if (describeTier('standard').configured) break
      await new Promise((res) => setTimeout(res, 1000))
    }
  }
  const tier = resolveTierForRequest('standard')
  if (!tier.configured || !tier.apiKey) throw new Error(`标准档未配置（${tier.unavailableReason ?? '无 key'}），无法跑基准`)
  const provider = { baseUrl: tier.baseUrl, model: tier.model, apiKey: tier.apiKey }
  progress(`标准档：${provider.baseUrl} / ${provider.model}（key 不打印）`)

  // ---- 只重判 ----
  if (job.rejudgeFrom) {
    const rows = readFileSync(job.rejudgeFrom, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    writeFileSync(job.out, '')
    for (const row of rows) {
      const q = job.questions.find((x) => x.id === row.id)
      // 不在本次筛选范围（--type / --only）的题原样保留：重判语义题不能把别的题弄丢
      if (!q || (job.rejudgeFailedOnly && row.judge && !row.judge.error)) {
        appendFileSync(job.out, JSON.stringify(row) + '\n')
        continue
      }
      const root = job.vaults[row.vault as string] ?? ''
      const ctx = buildCitationContext(root, q.expected_files, (row.citations as CitationContext[] & Array<{ name: string; resolved: string | null }>) ?? [], row.answer ?? '')
      row.citationContext = ctx
      row.judge = await callJudge(provider, q, row.answer ?? '', ctx)
      appendFileSync(job.out, JSON.stringify(row) + '\n')
      progress(`重判 ${row.id} ${row.judge.error ? '❌ ' + row.judge.error.slice(0, 120) : '✓'}`)
    }
    app.exit(0)
    return
  }

  writeFileSync(job.out, '')
  let openRoot = ''
  const meta: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    provider: { baseUrl: provider.baseUrl, model: provider.model },
    userData,
    vaults: job.vaults,
  }
  writeFileSync(job.out.replace(/\.jsonl$/, '') + '.meta.json', JSON.stringify(meta, null, 2))

  for (const q of job.questions) {
    const root = job.vaults[q.vault]
    if (!root) throw new Error(`题 ${q.id} 的库 "${q.vault}" 没有在 job.vaults 里给路径`)
    if (root !== openRoot) {
      const { noteCount } = await vaultManager.open(root)
      openRoot = root
      progress(`打开库 ${q.vault}（${noteCount} 篇）：${root}`)
      // 索引就绪闸门在 searcher 里；再用一次真实检索确认它真的回结果了，别拿空索引跑第一题
      const warm = await vaultManager.search('复盘')
      progress(`索引预热：「复盘」命中 ${warm.total} 条`)
    }

    const sessionId = `bench-${q.id}-${Date.now().toString(36)}`
    const steps = new Map<string, StepRec>()
    let answer = ''
    let error = ''
    let stopped = false
    let unverified: string[] = []
    let models: string[] = []
    let degraded = false
    let costUsd: number | undefined
    agentManager.tap = (p: AgentStreamPayload) => {
      if (p.sessionId !== sessionId) return
      if (p.kind === 'tool' && p.step) {
        const cur = steps.get(p.step.id) ?? { id: p.step.id, tool: p.step.tool }
        if (p.step.args) cur.args = p.step.args
        if (p.step.count != null) cur.count = p.step.count
        if (p.step.unit) cur.unit = p.step.unit
        if (p.step.failed) cur.failed = true
        if (p.step.capped) cur.capped = true
        steps.set(p.step.id, cur)
      } else if (p.kind === 'assistant' && p.text) {
        answer = p.text
        unverified = p.unverifiedCitations ?? []
        models = p.models ?? []
        degraded = !!p.degraded
        costUsd = p.costUsd
      } else if (p.kind === 'error') {
        error = p.text ?? '未知错误'
      }
    }

    const ledgerBefore = ledgerLines(userData).length
    const t0 = Date.now()
    const killer = setTimeout(() => {
      stopped = true
      progress(`${q.id} 超过 ${job.perQuestionTimeoutMs}ms，停止生成`)
      agentManager.stop(sessionId)
    }, job.perQuestionTimeoutMs)
    try {
      await agentManager.send(sessionId, q.question)
    } catch (e) {
      error = error || (e instanceof Error ? e.message : String(e))
    } finally {
      clearTimeout(killer)
      agentManager.tap = null
    }
    const durationMs = Date.now() - t0

    // ---- 重放检索，拿到模型看到的路径 ----
    const stepList = [...steps.values()]
    const searches: Array<{ query: string; total: number; fuzzy: boolean; shown: string[]; all: string[] }> = []
    for (const s of stepList) {
      if (s.tool !== 'search_knowledge' || !s.args?.query) continue
      const r = await vaultManager.search(s.args.query)
      searches.push({
        query: s.args.query,
        total: r.total,
        fuzzy: !!r.fuzzy,
        shown: r.hits.slice(0, SEARCH_SHOWN_LIMIT).map((h) => h.path),
        all: r.hits.map((h) => h.path),
      })
    }
    const reads = stepList.filter((s) => s.tool === 'Read' && s.args?.file).map((s) => s.args!.file)
    const scans = stepList
      .filter((s) => s.tool === 'Grep' || s.tool === 'Glob')
      .map((s) => ({ tool: s.tool, pattern: s.args?.pattern ?? '', path: s.args?.path ?? '', count: s.count, capped: !!s.capped }))
    const surfacedShown = [...new Set([...searches.flatMap((s) => s.shown), ...reads])]
    const surfacedAll = [...new Set([...searches.flatMap((s) => s.all), ...reads])]

    // ---- 引用解析（与产品校验引用同一函数） ----
    const cited = [...new Set([...answer.matchAll(/\[\[([^\]\[]+?)\]\]/g)].map((m) => m[1].split('|')[0].split('#')[0].trim()))]
    const citations = cited.map((name) => ({ name, resolved: vaultManager.resolveLink(name) }))

    // ---- 用量：账本增量 ----
    const newLines = ledgerLines(userData).slice(ledgerBefore)
    let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let cny = 0
    for (const l of newLines) {
      try {
        const rec = JSON.parse(l) as { route?: string; resolved_model?: string; expected_model?: string; usage?: unknown }
        const t = tokensOf(rec.usage)
        tokens = {
          input: tokens.input + t.input,
          output: tokens.output + t.output,
          cacheRead: tokens.cacheRead + t.cacheRead,
          cacheWrite: tokens.cacheWrite + t.cacheWrite,
        }
        cny += costCny(rec.route, rec.resolved_model ?? rec.expected_model, t)
      } catch {
        /* 账本里不该有坏行；有就跳过，别让基准因为一行坏账中断 */
      }
    }

    const row: Record<string, unknown> = {
      id: q.id,
      type: q.type,
      vault: q.vault,
      sensitive: !!q.sensitive || q.type === 'sensitive',
      question: q.question,
      expected_files: q.expected_files,
      gold_points: q.gold_points,
      ok: !error && !!answer,
      error: error || undefined,
      stopped,
      durationMs,
      models,
      degraded,
      sdkCostUsd: costUsd ?? null,
      answer,
      steps: stepList,
      searches,
      reads,
      scans,
      surfacedShown,
      surfacedAll,
      citations,
      unverifiedCitations: unverified,
      usage: { tokens, costCny: cny, ledgerRecords: newLines.length },
    }
    if (job.judge) {
      const ctx = buildCitationContext(root, q.expected_files, citations, answer)
      row.citationContext = ctx
      row.judge = await callJudge(provider, q, answer, ctx)
    }
    appendFileSync(job.out, JSON.stringify(row) + '\n')
    const hitExpected = q.expected_files.filter((f) => surfacedShown.some((s) => noteKey(s) === noteKey(f))).length
    progress(
      `${q.id} ${error ? '❌ ' + error.slice(0, 80) : '✓'} ${(durationMs / 1000).toFixed(1)}s · 检索${searches.length}/读${reads.length}/扫${scans.length}` +
        ` · 应命中 ${hitExpected}/${q.expected_files.length} · ¥${cny.toFixed(3)}` +
        (row.judge && (row.judge as JudgeResult).error ? ` · 判分失败：${(row.judge as JudgeResult).error}` : '')
    )
  }

  meta.finishedAt = new Date().toISOString()
  writeFileSync(job.out.replace(/\.jsonl$/, '') + '.meta.json', JSON.stringify(meta, null, 2))
  progress('全部完成')
  // 与 smoke-provider 同一个教训：Electron 43 的 chokidar watcher 不关退不掉进程
  await vaultManager.close()
  app.exit(0)
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('BENCH 失败：', e)
    app.exit(1)
  })
)
