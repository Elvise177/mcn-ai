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
 * 单价与汇率（单价 / 100 万 token，按**线路 × 模型**配）。**这是估算口径，不是账单**。
 *
 * **真相源是应用的配置文件**（`userData/config.json` 的 `pricing`，由管理员区维护）——
 * 脚本优先读它，读不到才用下面这份兜底。这样"页面一个价、脚本另一个价"就不可能发生了。
 * 兜底值必须与 `src/main/usage/pricing.ts` 的 DEFAULT_PRICING 一致。
 *
 * 币种跟着线路走（`currency`）：DeepSeek 官方原生人民币计费，不过汇率。
 */
const FALLBACK_PRICING = {
  routes: {
    deepseek: {
      currency: 'CNY', // 人民币原生，数值抄自 2026-08-17 官方账单
      models: { 'deepseek-v4-pro': { in: 4.5, out: 13.5 }, 'deepseek-v4-flash': { in: 1.5, out: 4.5 } },
      default: { in: 4.5, out: 13.5 },
      cacheRead: 1 / 30, // 三个价位档全部精确成立
      cacheWrite: 1.0,
    },
    aihubmix: {
      currency: 'USD',
      models: {
        // 缓存倍率挂在**模型**上：同一条线路，opus 打 0.1、deepseek 不打折（账单反解）
        'claude-opus-5': { in: 5, out: 25, cacheRead: 0.1 },
        'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.1 },
        'claude-haiku-4-5': { in: 1.1, out: 5.5, cacheRead: 0.1 },
        'claude-sonnet-4-5-20250929': { in: 3.3, out: 16.5, cacheRead: 0.1 },
        'deepseek-v4-pro': { in: 1.69, out: 3.38, cacheRead: 1.0 },
        'deepseek-v4-flash': { in: 0.142, out: 0.381, cacheRead: 1.0 },
        'text-embedding-3-small': { in: 0.02, out: 0.02 },
      },
      default: { in: 5, out: 25 },
      cacheRead: 1.0,
      cacheWrite: 1.0,
    },
  },
  usdCny: 7.2,
}

/** baseUrl → 线路键（与 usage/pricing.ts 的 routeOf 同一套） */
const routeOf = (baseUrl) => {
  const h = String(baseUrl ?? '').toLowerCase()
  if (h.includes('api.deepseek.com')) return 'deepseek'
  if (h.includes('aihubmix.com') || h.includes('inferera.com')) return 'aihubmix'
  return 'custom'
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
  const p = cfg?.pricing
  /**
   * 判据认的是**改版后的形状**（`routes`）。
   *
   * 这里踩过一次：B-2 把配置从「按档位」换成「按线路」之后，判据还留在旧形状
   * （`pricing.usd.standard`），条件永远为假 —— 脚本从那天起一直在用内置兜底，
   * 而兜底值恰好跟出厂价一样，所以完全看不出来。真正的后果是**管理员区改过的单价，
   * 脚本一概不认**，"单一真相源"就成了句空话。
   * 所以判据只认关键结构在不在，不要再去枚举具体字段。
   */
  if (p?.routes && typeof p.routes === 'object' && Object.keys(p.routes).length && p.usdCny) {
    PRICING = p
    pricingFrom = `${configPath}（rev ${p.rev ?? '未标'}）`
  } else if (p) {
    pricingFrom = `内置兜底（${configPath} 里的 pricing 结构不认识，可能是更老的版本）`
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
// B-2：缓存 token 分开计——并进 input 按全价算会高估 3 倍（实测 ¥153.83 vs 真实 ¥49.79）
const INPUT_KEYS = /^(input_tokens|inputTokens|prompt_tokens|promptTokens)$/
const CACHE_READ_KEYS = /^(cache_read_input_tokens|cacheReadInputTokens)$/
const CACHE_WRITE_KEYS = /^(cache_creation_input_tokens|cacheCreationInputTokens)$/
const OUTPUT_KEYS = /^(output_tokens|outputTokens|completion_tokens|completionTokens)$/

function tokensOf(raw) {
  let node = raw
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if (node.modelUsage && typeof node.modelUsage === 'object') node = node.modelUsage
    else if (node.usage && typeof node.usage === 'object') node = node.usage
  }
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4) return
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number') {
        if (INPUT_KEYS.test(k)) input += val
        else if (CACHE_READ_KEYS.test(k)) cacheRead += val
        else if (CACHE_WRITE_KEYS.test(k)) cacheWrite += val
        else if (OUTPUT_KEYS.test(k)) output += val
      } else walk(val, depth + 1)
    }
  }
  walk(node, 0)
  return { input, cacheRead, cacheWrite, output }
}

/**
 * 按**线路 × 模型**计价（与应用里 usage/pricing.ts 的 costCny 同一套口径）。
 * 钱是按线路收的：同一个 deepseek-v4-pro，官方 ¥4.5/¥13.5、中转站 $1.69/$3.38 ≈ ¥12.2/¥24.3。
 * 缓存读的折扣率挂在模型上，币种挂在线路上（人民币原生的线路不乘汇率）。
 */
const costCny = (route, model, t) => {
  const r = PRICING.routes?.[route] ?? PRICING.routes?.aihubmix ?? FALLBACK_PRICING.routes.aihubmix
  const p = (model && r.models?.[model]) || r.default
  const cr = p.cacheRead ?? r.cacheRead
  const cw = p.cacheWrite ?? r.cacheWrite
  const raw =
    (t.input * p.in + t.cacheRead * p.in * cr + t.cacheWrite * p.in * cw + t.output * p.out) / 1e6
  return r.currency === 'CNY' ? raw : raw * PRICING.usdCny
}

/** 一条记录的花费：route 缺失（改版前写的老记录）时按档位猜一次，并在表头提示 */
const recCost = (r) => {
  // 注意：这里**不能**用自增计数器统计"猜了几条"——`recCost` 每张分组表都会把
  // 全部记录再算一遍（5 张表 + 总计 = 6 遍），自增出来的是 条数×6。
  // 2026-08-18 实测：10 条无 route 的记录被报成「60 条」。计数改在下面对记录集直接数。
  const route = r.route ?? (r.tier === 'enhanced' ? 'aihubmix' : 'deepseek')
  return costCny(route, r.resolved_model ?? r.expected_model, tokensOf(r.usage))
}

const monthOf = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 按 keyFn 分组求和；花费按每条记录**自己的线路×模型**算再累加——不能混一个均价 */
function group(keyFn) {
  const map = new Map()
  for (const r of records) {
    const key = keyFn(r)
    const t = tokensOf(r.usage)
    const row = map.get(key) ?? {
      次数: 0, 输入tokens: 0, 缓存读tokens: 0, 输出tokens: 0, '估算¥': 0, 降级次数: 0,
    }
    row.次数 += r.calls ?? 1
    row.输入tokens += t.input
    row.缓存读tokens += t.cacheRead
    row.输出tokens += t.output
    row['估算¥'] += recCost(r)
    if (r.degraded) row.降级次数 += 1
    map.set(key, row)
  }
  return Object.fromEntries(
    [...map.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([k, v]) => [k, { ...v, '估算¥': Number(v['估算¥'].toFixed(4)) }])
  )
}

const TIER_LABEL = { standard: '标准', enhanced: '增强' }

console.log(`\n用量汇总　目录 ${dir}　文件 ${files.join('、')}　共 ${records.length} 条`)
const routeLine = Object.entries(PRICING.routes ?? {})
  .map(([k, v]) => {
    const s = v.currency === 'CNY' ? '¥' : '$'
    return `${k} 默认 ${s}${v.default.in}/${s}${v.default.out}（缓存读 ×${Number(v.cacheRead.toFixed(4))}）`
  })
  .join('　')
console.log(`计价来源：${pricingFrom}　${routeLine}　汇率 ${PRICING.usdCny}`)
console.log('口径：缓存 token 按线路的折扣率单独计价，不再当成全价输入\n')

console.log('— 按月 —')
console.table(group((r) => monthOf(r.ts)))

console.log('— 按线路 —')
console.table(group((r) => r.route ?? `(未记录·按${r.tier === 'enhanced' ? '增强' : '标准'}档推断)`))

console.log('— 按任务类型 —')
console.table(group((r) => r.taskType ?? '(未知)'))

console.log('— 按档位 —')
console.table(group((r) => (r.tier ? TIER_LABEL[r.tier] ?? r.tier : '（不经档位：入库打标）')))

console.log('— 按实际模型 —')
console.table(group((r) => r.resolved_model || `${r.expected_model || '(未知)'}（未上报实际模型）`))

const totalCny = records.reduce((n, r) => n + recCost(r), 0)
const legacyRouteGuesses = records.filter((r) => !r.route).length
const degraded = records.filter((r) => r.degraded)
console.log(`估算总成本：¥${totalCny.toFixed(2)}　费用为估算值，以实际账单为准`)
if (legacyRouteGuesses) {
  console.log(
    `ℹ️  ${legacyRouteGuesses} 条记录没有 route 字段（B-2 改版前写的），已按档位推断线路——` +
      `老用户被迁移到中转站的那段时间，推断值会偏低`
  )
}
if (degraded.length) {
  console.log(`\n⚠️  有 ${degraded.length} 条记录的实际模型与档位期望不符（线路静默降级）：`)
  for (const r of degraded.slice(0, 10)) {
    console.log(`   ${new Date(r.ts).toLocaleString('zh-CN')} 期望 ${r.expected_model} → 实际 ${r.models?.join('/') ?? r.resolved_model}`)
  }
}
const noUsage = records.filter((r) => !r.usage).length
if (noUsage) console.log(`\nℹ️  ${noUsage} 条记录没有 usage（只记了次数，多为入库打标），其 token 计为 0`)
console.log('')
