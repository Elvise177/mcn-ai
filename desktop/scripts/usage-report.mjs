#!/usr/bin/env node
/**
 * 开发者用量汇总（不进 UI，只在终端看）。
 *
 * 读 userData/usage/ 下的全部 YYYY-MM.jsonl，按 月 / 任务类型 / 档位 / 实际模型
 * 汇总 token 并估算成本。
 *
 * 用法（在 desktop/ 下）：
 *   node scripts/usage-report.mjs                 # 默认读本机 userData
 *   node scripts/usage-report.mjs --dir /tmp/mcnai-e2e-userdata/usage
 *   MCNAI_USER_DATA=/tmp/mcnai-e2e-userdata node scripts/usage-report.mjs
 *   node scripts/usage-report.mjs --month 2026-08
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * 单价与汇率（美元 / 100 万 token，按**档位**配）。**这是估算口径，不是账单**。
 *
 * **真相源是应用的配置文件**（`userData/config.json` 的 `pricing`，由管理员区维护）——
 * 脚本优先读它，读不到才用下面这份兜底。这样"页面一个价、脚本另一个价"就不可能发生了。
 * 兜底值必须与 `src/main/usage/pricing.ts` 的 DEFAULT_PRICING 一致。
 */
const FALLBACK_PRICING = {
  usd: {
    standard: { in: 0.28, out: 1.1 },
    enhanced: { in: 15, out: 75 },
  },
  usdCny: 7.2,
}

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const dir =
  arg('--dir') ||
  join(
    process.env.MCNAI_USER_DATA || join(homedir(), 'Library', 'Application Support', 'mcn-ai-desktop'),
    'usage'
  )

if (!existsSync(dir)) {
  console.error(`没有找到用量目录：${dir}\n（还没产生过记录，或用 --dir 指定别的位置）`)
  process.exit(1)
}

// 计价：从应用配置里读（单一真相源），读不到才兜底
const configPath = join(dir, '..', 'config.json')
let PRICING = FALLBACK_PRICING
let pricingFrom = `内置兜底（没读到 ${configPath} 的 pricing）`
try {
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
  if (cfg?.pricing?.usd?.standard && cfg?.pricing?.usd?.enhanced && cfg?.pricing?.usdCny) {
    PRICING = cfg.pricing
    pricingFrom = configPath
  }
} catch {
  /* 没有配置文件：用兜底 */
}

const onlyMonth = arg('--month')
const files = readdirSync(dir)
  .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
  .filter((f) => !onlyMonth || f.startsWith(onlyMonth))
  .sort()

if (!files.length) {
  console.error(`${dir} 下没有匹配的月份文件`)
  process.exit(1)
}

const records = []
for (const f of files) {
  for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      records.push(JSON.parse(s))
    } catch {
      /* 坏行跳过：一条脏数据不该废掉整月 */
    }
  }
}

// ---- 归一化：与 src/main/usage/index.ts 的 tokensOf 同一套口径 ----
const INPUT_KEYS =
  /^(input_tokens|inputTokens|prompt_tokens|promptTokens|cache_creation_input_tokens|cacheCreationInputTokens|cache_read_input_tokens|cacheReadInputTokens)$/
const OUTPUT_KEYS = /^(output_tokens|outputTokens|completion_tokens|completionTokens)$/

function tokensOf(raw) {
  let node = raw
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if (node.modelUsage && typeof node.modelUsage === 'object') node = node.modelUsage
    else if (node.usage && typeof node.usage === 'object') node = node.usage
  }
  let input = 0
  let output = 0
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4) return
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number') {
        if (INPUT_KEYS.test(k)) input += val
        else if (OUTPUT_KEYS.test(k)) output += val
      } else walk(val, depth + 1)
    }
  }
  walk(node, 0)
  return { input, output }
}

/** 按**档位**计价（与应用里 usage/pricing.ts 的 costCny 同一套口径）。
    入库打标不经档位（tier=null），没有 token 也就没有花费 */
const costUsd = (tier, input, output) => {
  if (!tier) return 0
  const p = PRICING.usd[tier] ?? FALLBACK_PRICING.usd.standard
  return (input / 1e6) * p.in + (output / 1e6) * p.out
}
const costCny = (tier, input, output) => costUsd(tier, input, output) * PRICING.usdCny

const monthOf = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 按 keyFn 分组求和；花费按每条记录**自己的档位**算再累加——两档单价差几十倍，不能混一个均价 */
function group(keyFn) {
  const map = new Map()
  for (const r of records) {
    const key = keyFn(r)
    const t = tokensOf(r.usage)
    const row = map.get(key) ?? { 次数: 0, 输入tokens: 0, 输出tokens: 0, '估算$': 0, '估算¥': 0, 降级次数: 0 }
    row.次数 += r.calls ?? 1
    row.输入tokens += t.input
    row.输出tokens += t.output
    row['估算$'] += costUsd(r.tier, t.input, t.output)
    row['估算¥'] += costCny(r.tier, t.input, t.output)
    if (r.degraded) row.降级次数 += 1
    map.set(key, row)
  }
  return Object.fromEntries(
    [...map.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([k, v]) => [
        k,
        { ...v, '估算$': Number(v['估算$'].toFixed(4)), '估算¥': Number(v['估算¥'].toFixed(4)) },
      ])
  )
}

const TIER_LABEL = { standard: '标准', enhanced: '增强' }

console.log(`\n用量汇总　目录 ${dir}　文件 ${files.join('、')}　共 ${records.length} 条`)
console.log(
  `计价来源：${pricingFrom}　标准 $${PRICING.usd.standard.in}/$${PRICING.usd.standard.out}　` +
    `增强 $${PRICING.usd.enhanced.in}/$${PRICING.usd.enhanced.out}　汇率 ${PRICING.usdCny}\n`
)

console.log('— 按月 —')
console.table(group((r) => monthOf(r.ts)))

console.log('— 按任务类型 —')
console.table(group((r) => r.taskType ?? '(未知)'))

console.log('— 按档位 —')
console.table(group((r) => (r.tier ? TIER_LABEL[r.tier] ?? r.tier : '（不经档位：入库打标）')))

console.log('— 按实际模型 —')
console.table(group((r) => r.resolved_model || `${r.expected_model || '(未知)'}（未上报实际模型）`))

const totalUsd = records.reduce((n, r) => {
  const t = tokensOf(r.usage)
  return n + costUsd(r.tier, t.input, t.output)
}, 0)
const degraded = records.filter((r) => r.degraded)
console.log(
  `估算总成本：$${totalUsd.toFixed(4)} ≈ ¥${(totalUsd * PRICING.usdCny).toFixed(2)}　费用为估算值，以实际账单为准`
)
if (degraded.length) {
  console.log(`\n⚠️  有 ${degraded.length} 条记录的实际模型与档位期望不符（线路静默降级）：`)
  for (const r of degraded.slice(0, 10)) {
    console.log(`   ${new Date(r.ts).toLocaleString('zh-CN')} 期望 ${r.expected_model} → 实际 ${r.models?.join('/') ?? r.resolved_model}`)
  }
}
const noUsage = records.filter((r) => !r.usage).length
if (noUsage) console.log(`\nℹ️  ${noUsage} 条记录没有 usage（只记了次数，多为入库打标），其 token 计为 0`)
console.log('')
