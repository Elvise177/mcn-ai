import { spawnSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { tokensOf, type UsageRecord } from './usage'
import { buildIngestUsageRecords } from './usage/ingest'
import { costCny, routeOf, DEFAULT_PRICING, PRICING_REV } from './usage/pricing'

/**
 * 账本的零花费验收（`npm run smoke:usage`，PLAN-v2 批 5 R8/S2）。
 *
 * 这里验的每一条，靠"真跑一轮"来验都要**花钱 + 等几分钟**：打标一轮几十篇、
 * 缓存命中要攒够才看得出计价差、老冻结产物那条兜底分支根本没法在本机复现。
 * desktop/CLAUDE.md 的铁律：花钱才触发的逻辑必须抽成纯函数，否则它就是没人测——
 * `computeProgress` 那行死判据在线上活了几个月，就是这么活下来的。
 *
 * 最后一节是**跨实现对账**：`scripts/usage-report.mjs` 里的归一化与计价是应用里
 * 那份的手抄镜像，两边长歪过一次（`pricing.usd` 判据留在旧形状，脚本从那天起
 * 一直在用内置兜底，而兜底值恰好等于出厂价，完全看不出来）。所以拿同一份桩数据
 * 同时喂两边、逐项比对——**验「界面的 X = 系统的 X」时，X 必须从另一侧取**。
 */

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n【1】tokensOf：两家相反的缓存口径（R8 接打标用量时才撞上的坑）')
{
  // Anthropic（对话链路）：input 与 cache_read **互斥**，直接相加
  const a = tokensOf({ usage: { input_tokens: 900, cache_read_input_tokens: 100_000, output_tokens: 300 } })
  check('Anthropic 口径：input 与缓存读各归各的', a.input === 900 && a.cacheRead === 100_000 && a.output === 300, JSON.stringify(a))

  // OpenAI 兼容（DeepSeek，打标链路）：prompt_tokens **含**缓存命中，必须挪出来
  const d = tokensOf({ prompt_tokens: 2000, completion_tokens: 400, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 1200, total_tokens: 2400 })
  check('DeepSeek 口径：缓存命中从 input 里挪出来', d.input === 1200 && d.cacheRead === 800 && d.output === 400, JSON.stringify(d))
  check('总量守恒（挪不是加）', d.input + d.cacheRead === 2000, JSON.stringify(d))
  check('prompt_cache_miss_tokens 不认（认了就是同一笔加三遍）', d.input + d.cacheRead + d.output === 2400, JSON.stringify(d))
  check('total_tokens 不认（它是 prompt+completion 的合计）', d.input + d.cacheRead + d.output === 2400)

  // OpenAI 自己的形状：cached_tokens 藏在 prompt_tokens_details 里
  const o = tokensOf({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 } })
  check('OpenAI 口径：prompt_tokens_details.cached_tokens 同样挪出来', o.input === 400 && o.cacheRead === 600, JSON.stringify(o))

  /**
   * **DeepSeek 真实回包**（2026-09-04 真跑一轮打标抄回来的原样字段，别改数字）。
   * 它把同一个缓存命中数报了**两遍**：`prompt_cache_hit_tokens` 与
   * `prompt_tokens_details.cached_tokens` 都是 17920。求和的写法会得到 35840 > prompt，
   * 被钳成"整段 prompt 都是缓存" → input 0 / 缓存读 26274。总量守恒，所以
   * **页面上的 tokens 看着完全正常**，错的是拆分，而缓存读按 1/30 计价 → 花费低估约 10%。
   * 合成桩发现不了这条（我自己编的桩只带一个别名），所以把真回包钉在这里。
   */
  const real = tokensOf({
    prompt_tokens: 26_274, completion_tokens: 23_515, total_tokens: 49_789,
    prompt_tokens_details: { cached_tokens: 17_920 },
    completion_tokens_details: { reasoning_tokens: 22_037 },
    prompt_cache_hit_tokens: 17_920, prompt_cache_miss_tokens: 8_354,
  })
  check('真回包：缓存命中的两个别名取最大值，不求和', real.input === 8_354 && real.cacheRead === 17_920, JSON.stringify(real))
  check('真回包：reasoning_tokens 不重复计入输出（它含在 completion_tokens 里）', real.output === 23_515, String(real.output))
  check('真回包：总量 = prompt + completion', real.input + real.cacheRead + real.output === 49_789, String(real.input + real.cacheRead + real.output))
  // 拆分错了，花费就会低估——缓存读只按 1/30 计价
  const cRight = costCny('deepseek', 'deepseek-v4-flash', real, DEFAULT_PRICING)
  const cWrong = costCny('deepseek', 'deepseek-v4-flash', { input: 0, cacheRead: 26_274, cacheWrite: 0, output: 23_515 }, DEFAULT_PRICING)
  check('拆分对了花费才对（¥0.119 而不是低估的 ¥0.107）', Math.abs(cRight - 0.1192) < 0.001 && cWrong < cRight, `${cRight.toFixed(4)} vs ${cWrong.toFixed(4)}`)

  // 自相矛盾的数据不许把总量算大
  const bad = tokensOf({ prompt_tokens: 100, prompt_cache_hit_tokens: 999_999, completion_tokens: 10 })
  check('hit > prompt 时钳住，input 不为负、总量不膨胀', bad.input === 0 && bad.cacheRead === 100 && bad.output === 10, JSON.stringify(bad))

  check('没有缓存字段时行为不变', JSON.stringify(tokensOf({ prompt_tokens: 500, completion_tokens: 50 })) === JSON.stringify({ input: 500, cacheRead: 0, cacheWrite: 0, output: 50 }))
  check('usage 为 null / 垃圾值 → 全 0', tokensOf(null).input === 0 && tokensOf('x').output === 0 && tokensOf(undefined).cacheRead === 0)
  // modelUsage 与 usage 说的是同一批 token，递归求和会翻倍——优先取 modelUsage
  const both = tokensOf({ usage: { input_tokens: 100, output_tokens: 10 }, modelUsage: { m: { inputTokens: 100, outputTokens: 10 } } })
  check('modelUsage 与 usage 并存时只取一棵（不翻倍）', both.input === 100 && both.output === 10, JSON.stringify(both))
}

console.log('\n【2】buildIngestUsageRecords：三条分支（R8 —— 账本 98.7% 缺口那条链）')
{
  const base = {
    ts: 1_700_000_000_000,
    taskId: 'inbox:/tmp/v',
    vault: '/tmp/v',
    startedAt: 1_000,
    endedAt: 91_000,
    baseUrl: 'https://api.deepseek.com',
    expectedModel: 'deepseek-v4-flash',
  }
  const tagUsage = { prompt_tokens: 2000, completion_tokens: 400, prompt_cache_hit_tokens: 800 }

  // 分支 1：pipeline 报了用量 —— 它说了算
  const r1 = buildIngestUsageRecords({ ...base, tagRan: true, events: [{ stage: 'tag_llm', usage: tagUsage, calls: 2, model: 'deepseek-v4-flash' }] })
  check('报了用量 → 一条记录', r1.length === 1, String(r1.length))
  check('token 真的进了账（不再是 usage:null）', tokensOf(r1[0].usage).input === 1200 && tokensOf(r1[0].usage).cacheRead === 800)
  check('calls = pipeline 报的篇数，不是恒 1', r1[0].calls === 2, String(r1[0].calls))
  check('route 按 llmBaseUrl 取（计价按线路，不按档位）', r1[0].route === 'deepseek', String(r1[0].route))
  check('tier 恒 null（打标不经档位层）', r1[0].tier === null)
  check('resolved_model 取 pipeline 报的那个（从另一侧取）', r1[0].resolved_model === 'deepseek-v4-flash')
  check('归因带上任务/库/阶段，template 留 null', r1[0].attribution?.stage === 'tag_llm' && r1[0].attribution?.vault === '/tmp/v' && r1[0].attribution?.template === null, JSON.stringify(r1[0].attribution))
  check('durationMs = 这一轮的墙钟', r1[0].durationMs === 90_000, String(r1[0].durationMs))

  // 分流轻管线的主题打标是另一笔钱，要单独一条（归因才分得开）
  const r2 = buildIngestUsageRecords({
    ...base, tagRan: true,
    events: [
      { stage: 'tag_llm', usage: tagUsage, calls: 2, model: 'deepseek-v4-flash' },
      { stage: 'route_参考资料', usage: { prompt_tokens: 500, completion_tokens: 50 }, calls: 1, model: 'deepseek-v4-flash' },
    ],
  })
  check('两个阶段各记一条', r2.length === 2 && r2[1].attribution?.stage === 'route_参考资料', String(r2.length))

  // **最容易记成假账的一轮**：新产物报了 calls:0（这一轮真的一次没调）
  const r3 = buildIngestUsageRecords({ ...base, tagRan: true, events: [{ stage: 'tag_llm', usage: {}, calls: 0, model: 'deepseek-v4-flash' }] })
  check('报了 calls:0 → 一条都不记（不许凭空记一笔没花的钱）', r3.length === 0, JSON.stringify(r3))

  // 分支 2：老冻结产物一条都不报 —— 退回「只记次数」，不能变成完全不记（那是倒退）
  const r4 = buildIngestUsageRecords({ ...base, tagRan: true, events: [] })
  check('老产物不报用量 → 兜底记一条次数', r4.length === 1 && r4[0].calls === 1 && r4[0].usage === null)
  check('兜底记录的 resolved_model 是 null（没人报过，不许抄 expected）', r4[0].resolved_model === null)

  // 分支 3：打标压根没跑
  check('打标跳过 → 一条都不记', buildIngestUsageRecords({ ...base, tagRan: false, events: [] }).length === 0)

  // 模型被换掉要看得见（env 没传进去就是这个形状）
  const r5 = buildIngestUsageRecords({ ...base, tagRan: true, events: [{ stage: 'tag_llm', usage: tagUsage, calls: 1, model: 'deepseek-v4-pro' }] })
  check('pipeline 报的模型 ≠ 要的模型 → degraded', r5[0].degraded === true && r5[0].resolved_model === 'deepseek-v4-pro')
  check('模型一致时不报 degraded', r1[0].degraded === false)
}

console.log('\n【3】打标那条线的计价（官方线路人民币原生 + 缓存读 1/30）')
{
  const t = tokensOf({ prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_cache_hit_tokens: 600_000 })
  // 纯 input 400,000 × ¥1.5/1M = 0.60；缓存读 600,000 × 1.5 × 1/30 = 0.03；输出 100,000 × ¥4.5/1M = 0.45
  const cny = costCny('deepseek', 'deepseek-v4-flash', t, DEFAULT_PRICING)
  check('flash 按官方人民币价 ≈ ¥1.08（不乘汇率）', Math.abs(cny - 1.08) < 0.001, cny.toFixed(4))
  // 缓存不挪出来的话（旧口径）会按全价 input 再算一遍：1.5 + 0.45 = ¥1.95，差 1.8 倍
  const wrong = costCny('deepseek', 'deepseek-v4-flash', { input: 1_000_000, cacheRead: 600_000, cacheWrite: 0, output: 100_000 }, DEFAULT_PRICING)
  check('若把缓存当成额外输入会高估到 ¥1.98（这就是要挪的理由）', wrong > cny * 1.8, wrong.toFixed(4))
  check('routeOf 认官方端点', routeOf('https://api.deepseek.com') === 'deepseek' && routeOf('https://api.inferera.com/v1') === 'aihubmix')
  check('routeOf 认不出的落 custom（宁可按中转站估高）', routeOf('https://example.com') === 'custom')
}

console.log('\n【4】跨实现对账：应用侧 vs scripts/usage-report.mjs（两份手抄镜像不许长歪）')
{
  const dir = join(tmpdir(), `mcnai-smoke-usage-${process.pid}`)
  const usageDir = join(dir, 'usage')
  try {
    mkdirSync(usageDir, { recursive: true })
    // 计价从**同一份**出厂价来：这样任何差异都只可能出在归一化/计算上，不会是价目不同
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ pricing: { ...DEFAULT_PRICING, rev: PRICING_REV } }), 'utf-8')

    const ts = Date.UTC(2026, 8, 3, 6, 0, 0)
    const recs: UsageRecord[] = [
      // 对话：Anthropic 口径（input 与 cache_read 互斥）
      { ts, sessionId: 'c1', taskType: 'chat', tier: 'enhanced', route: 'aihubmix', expected_model: 'claude-opus-5', resolved_model: 'claude-opus-5', models: ['claude-opus-5'], degraded: false, durationMs: 5000, usage: { usage: { input_tokens: 22_000, cache_read_input_tokens: 100_000, output_tokens: 4000 } } },
      // 入库打标：OpenAI 兼容口径（缓存含在 prompt 里）—— R8 之后的形状
      ...buildIngestUsageRecords({
        ts, taskId: 'inbox:/tmp/v', vault: '/tmp/v', startedAt: 0, endedAt: 90_000,
        baseUrl: 'https://api.deepseek.com', expectedModel: 'deepseek-v4-flash', tagRan: true,
        events: [{ stage: 'tag_llm', usage: { prompt_tokens: 500_000, completion_tokens: 80_000, prompt_cache_hit_tokens: 300_000, total_tokens: 580_000 }, calls: 37, model: 'deepseek-v4-flash' }],
      }),
      // 入库打标：R8 之前的老记录（只有次数）—— 两边都该把它算成 0 token
      { ts, sessionId: 'inbox:/tmp/v', taskType: 'ingest-tag', tier: null, route: 'deepseek', expected_model: 'deepseek-v4-flash', resolved_model: null, durationMs: 91_000, usage: null, calls: 1 },
    ]
    writeFileSync(join(usageDir, '2026-09.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')

    // 脚本侧：用 electron-as-node 跑，不依赖 PATH 上有没有 node
    const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'usage-report.mjs'), '--dir', usageDir, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    if (r.status !== 0) {
      check('usage-report.mjs --json 跑通', false, `${r.status}｜${(r.stderr || '').slice(0, 300)}`)
    } else {
      const script = JSON.parse(r.stdout)
      // 应用侧：同一份记录，用应用的归一化与计价再算一遍
      const app = recs.reduce(
        (acc, x) => {
          const t = tokensOf(x.usage)
          acc.input += t.input
          acc.cacheRead += t.cacheRead
          acc.cacheWrite += t.cacheWrite
          acc.output += t.output
          acc.costCny += costCny(x.route, x.resolved_model ?? x.expected_model, t, DEFAULT_PRICING)
          acc.calls += x.calls ?? 1
          return acc
        },
        { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costCny: 0, calls: 0 }
      )
      check('条数一致', script.records === recs.length, `${script.records} vs ${recs.length}`)
      for (const k of ['input', 'cacheRead', 'cacheWrite', 'output', 'calls'] as const) {
        check(`${k} 两侧一致`, script.total[k] === app[k], `脚本 ${script.total[k]} vs 应用 ${app[k]}`)
      }
      check('估算花费两侧一致（差 < 0.0001）', Math.abs(script.total.costCny - app.costCny) < 1e-4, `脚本 ¥${script.total.costCny.toFixed(4)} vs 应用 ¥${app.costCny.toFixed(4)}`)
      // 具体到打标那一类：这正是 R8 补的那条线，单独盯一眼
      const tag = script.byType['ingest-tag']
      check('打标那类在脚本侧有 token（补账真的到位了）', !!tag && tag.input === 200_000 && tag.cacheRead === 300_000 && tag.output === 80_000, JSON.stringify(tag))
      check('打标那类的花费 > 0（不再是 ¥0）', !!tag && tag.costCny > 0, tag ? String(tag.costCny) : '无')
      check('老记录仍按 0 token 计（不许猜）', !!tag && tag.calls === 38, tag ? String(tag.calls) : '无')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failed ? `\n❌ ${failed} 条不通过\n` : '\n✅ 全部通过\n')
process.exit(failed ? 1 : 0)
