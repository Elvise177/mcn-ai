#!/usr/bin/env node
/**
 * 只读调研脚本 —— 统计 desktop/src/renderer/src 下 UI 硬编码数值的分布。
 * 不修改任何产品代码，不进 e2e 走查，不进 package.json。
 * 用法：node desktop/scripts/audit/ui-hardcode-stats.mjs
 *
 * 局限（先说清楚，避免过度解读输出）：
 * - 基于正则的静态扫描，不做 AST 解析；极少数跨多行拼接的 className 表达式可能漏检或错位。
 * - Tailwind 任意值 `p-[13px]` 与 `calc(...)` 内的嵌套逗号未做括号平衡，极端写法可能截断。
 * - "token 化"的判定基于 tailwind.config.js 当前的 extend 映射表，人工同步，配置改了这里也要改。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '../../src/renderer/src')
const EXTS = new Set(['.tsx', '.ts', '.css'])

// ---------- Tailwind 默认刻度表（仅用于把 class 换算成 px，供分布统计用） ----------
const TW_SPACING_PX = {
  '0': 0, px: 1, '0.5': 2, '1': 4, '1.5': 6, '2': 8, '2.5': 10, '3': 12, '3.5': 14,
  '4': 16, '5': 20, '6': 24, '7': 28, '8': 32, '9': 36, '10': 40, '11': 44, '12': 48,
  '14': 56, '16': 64, '20': 80, '24': 96, '28': 112, '32': 128, '36': 144, '40': 160,
  '44': 176, '48': 192, '52': 208, '56': 224, '60': 240, '64': 256, '72': 288, '80': 320,
  '96': 384,
}
const TW_DEFAULT_FONT_PX = { '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 }
const TW_DEFAULT_RADIUS_PX = { '2xl': 16, '3xl': 24, none: 0 }
const TW_DEFAULT_SHADOW = new Set(['sm', '', 'md', 'lg', 'xl', '2xl', 'inner', 'none'])
const TW_DEFAULT_FONT_WEIGHT = {
  thin: 100, extralight: 200, light: 300, normal: 400, medium: 500,
  semibold: 600, bold: 700, extrabold: 800, black: 900,
}
const TW_DEFAULT_DURATION_MS = {
  '75': 75, '100': 100, '150': 150, '200': 200, '300': 300, '500': 500, '700': 700, '1000': 1000,
}

// tailwind.config.js 里 extend 出的、指向 theme.css 变量的语义 key —— 命中这些 = 走 token
const TOKEN_FONT_SIZE_KEYS = new Set(['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl', 'display'])
const TOKEN_RADIUS_KEYS = new Set(['', 'sm', 'md', 'lg', 'xl', 'input', 'full'])
const TOKEN_SHADOW_KEYS = new Set(['card', 'pop'])
const TOKEN_SPACING_KEYS = new Set([
  'sidebar', 'artifact-panel', 'tree', 'input', 'modal', 'toast', 'modal-wide',
  'graph-panel', 'home-top', 'divider',
])
const TOKEN_LEADING_KEYS = new Set(['base', 'tight']) // tailwind.config lineHeight extend

// ---------- 文件收集 ----------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (EXTS.has(extname(name))) out.push(p)
  }
  return out
}

const files = walk(ROOT)
const fileTexts = new Map()
const fileLines = new Map()
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  fileTexts.set(f, text)
  fileLines.set(f, text.split('\n'))
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function relPath(f) {
  return relative(join(__dirname, '../../..'), f)
}

// ---------- 通用记录结构 ----------
// bucket: category -> Map(rawValue -> { count, files:Set, examples:[{file,line}], isToken, px })
const buckets = {
  spacing: new Map(),
  fontSize: new Map(),
  radius: new Map(),
  shadow: new Map(),
  lineHeight: new Map(),
  fontWeight: new Map(),
  duration: new Map(),
  easing: new Map(),
}
const fileHardcodeCount = new Map() // file -> count (硬编码数值命中次数，跨五类 + 附加)
const extra = {
  inlineStyle: new Map(), // file -> count
  important: new Map(),
  hexColor: new Map(), // value -> {count, files, examples}
  rgbColor: new Map(),
}

function bump(map, key) {
  fileHardcodeCount.set(key, (fileHardcodeCount.get(key) || 0) + 1)
}

function record(bucketMap, raw, file, line, isToken, px) {
  let e = bucketMap.get(raw)
  if (!e) {
    e = { count: 0, files: new Set(), examples: [], isToken, px }
    bucketMap.set(raw, e)
  }
  e.count++
  e.files.add(file)
  if (e.examples.length < 3) e.examples.push(`${relPath(file)}:${line}`)
  if (!isToken) bump(fileHardcodeCount, file)
}

// ---------- 各文件扫描 ----------
for (const f of files) {
  const text = fileTexts.get(f)
  const isCss = extname(f) === '.css'

  // ===== 1) Tailwind class 扫描（.tsx/.ts 的 className / class 字符串，也顺带扫 .css 里出现的 @apply）=====
  // 间距：p/px/py/pt/pr/pb/pl, m/mx/my/mt/mr/mb/ml, gap/gap-x/gap-y, space-x/space-y
  {
    const re = /(?<![\w-])(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap-x|gap-y|gap|space-x|space-y)-(\[[^\]]+\]|-?[0-9]+(?:\.[0-9]+)?|px|auto|full)(?![\w-])/g
    let m
    while ((m = re.exec(text))) {
      const [full, prefix, val] = m
      const line = lineOf(text, m.index)
      let isToken = false
      let px = null
      let raw = full
      if (val.startsWith('[')) {
        const inner = val.slice(1, -1)
        isToken = /var\(--/.test(inner)
        const pxm = inner.match(/(-?[\d.]+)px/)
        px = pxm ? Number(pxm[1]) : null
      } else if (val === 'auto') {
        continue // 不计入硬编码数值统计
      } else if (val === 'px') {
        px = 1
      } else if (val === 'full') {
        continue
      } else if (TOKEN_SPACING_KEYS.has(val)) {
        isToken = true
      } else if (TW_SPACING_PX[val] !== undefined) {
        px = TW_SPACING_PX[val]
      } else {
        continue
      }
      record(buckets.spacing, raw, f, line, isToken, px)
    }
  }

  // 字号：text-<key>（要排除颜色/对齐等非尺寸的 text-* 用法）
  {
    const re = /(?<![\w-])text-(\[[^\]]+\]|2xs|xs|sm|base|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl|display)(?![\w-])/g
    let m
    while ((m = re.exec(text))) {
      const key = m[1]
      const line = lineOf(text, m.index)
      const raw = m[0]
      let isToken = false
      let px = null
      if (key.startsWith('[')) {
        const inner = key.slice(1, -1)
        isToken = /var\(--/.test(inner)
        const pxm = inner.match(/(-?[\d.]+)px/)
        px = pxm ? Number(pxm[1]) : null
      } else if (TOKEN_FONT_SIZE_KEYS.has(key)) {
        isToken = true
      } else if (TW_DEFAULT_FONT_PX[key] !== undefined) {
        px = TW_DEFAULT_FONT_PX[key]
      }
      record(buckets.fontSize, raw, f, line, isToken, px)
    }
  }

  // 圆角：rounded / rounded-{t|r|b|l|tl|tr|br|bl}?-{key}?
  {
    const re = /(?<![\w-])rounded(?:-(t|r|b|l|tl|tr|br|bl))?(?:-(\[[^\]]+\]|sm|md|lg|xl|2xl|3xl|full|none|input))?(?![\w-])/g
    let m
    while ((m = re.exec(text))) {
      const size = m[2]
      const line = lineOf(text, m.index)
      const raw = m[0]
      let isToken = false
      let px = null
      if (!size) {
        isToken = true // 裸 rounded = radius-xs token
      } else if (size.startsWith('[')) {
        const inner = size.slice(1, -1)
        isToken = /var\(--/.test(inner)
        const pxm = inner.match(/(-?[\d.]+)px/)
        px = pxm ? Number(pxm[1]) : null
      } else if (TOKEN_RADIUS_KEYS.has(size)) {
        isToken = true
      } else if (TW_DEFAULT_RADIUS_PX[size] !== undefined) {
        px = TW_DEFAULT_RADIUS_PX[size]
      } else {
        continue
      }
      record(buckets.radius, raw, f, line, isToken, px)
    }
  }

  // 阴影：shadow / shadow-{key}
  {
    const re = /(?<![\w-])shadow(?:-(\[[^\]]+\]|sm|md|lg|xl|2xl|inner|none|card|pop))?(?![\w-])/g
    let m
    while ((m = re.exec(text))) {
      const key = m[1] || ''
      const line = lineOf(text, m.index)
      const raw = m[0]
      let isToken = false
      let px = null
      if (key.startsWith('[')) {
        const inner = key.slice(1, -1)
        isToken = /var\(--/.test(inner)
      } else if (TOKEN_SHADOW_KEYS.has(key)) {
        isToken = true
      } else if (TW_DEFAULT_SHADOW.has(key)) {
        isToken = false
      } else {
        continue
      }
      record(buckets.shadow, raw, f, line, isToken, px)
    }
  }

  // 行高：leading-*
  {
    const re = /(?<![\w-])leading-(\[[^\]]+\]|none|tight|snug|normal|relaxed|loose|base|[3-9]|10)(?![\w-])/g
    let m
    while ((m = re.exec(text))) {
      const key = m[1]
      const line = lineOf(text, m.index)
      const raw = m[0]
      let isToken = false
      if (key.startsWith('[')) {
        isToken = /var\(--/.test(key.slice(1, -1))
      } else if (TOKEN_LEADING_KEYS.has(key)) {
        isToken = true
      }
      record(buckets.lineHeight, raw, f, line, isToken, null)
    }
  }

  // 字重：font-{weight}（注意排除 font-sans/serif/brand/mono 等字体族类）
  {
    const re = /(?<![\w-])font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[[^\]]+\])(?![\w-])/g
    let m
    while ((m = re.exec(text))) {
      const key = m[1]
      const line = lineOf(text, m.index)
      const raw = m[0]
      let isToken = false
      if (key.startsWith('[')) isToken = /var\(--/.test(key.slice(1, -1))
      record(buckets.fontWeight, raw, f, line, isToken, TW_DEFAULT_FONT_WEIGHT[key] ?? null)
    }
  }

  // 动效时长：duration-*（Tailwind 数值或任意值）
  {
    const re = /(?<![\w-])duration-(\[[^\]]+\]|[0-9]+)(?![\w-])/g
    let m
    while ((m = re.exec(text))) {
      const key = m[1]
      const line = lineOf(text, m.index)
      const raw = m[0]
      let isToken = false
      let ms = null
      if (key.startsWith('[')) {
        const inner = key.slice(1, -1)
        isToken = /var\(--/.test(inner)
        const msm = inner.match(/(-?[\d.]+)(ms|s)/)
        if (msm) ms = msm[2] === 's' ? Number(msm[1]) * 1000 : Number(msm[1])
      } else {
        ms = TW_DEFAULT_DURATION_MS[key] ?? Number(key)
      }
      record(buckets.duration, raw, f, line, isToken, ms)
    }
  }
  // 裸 transition-* / animation-* 无显式 duration（吃 Tailwind 隐式默认 150ms），单独计一类
  {
    const re = /(?<![\w-])transition(?:-(colors|opacity|shadow|transform|all|none|\[[^\]]+\]))?(?![\w-])/g
    let m
    while ((m = re.exec(text))) {
      const line = lineOf(text, m.index)
      record(buckets.duration, '(隐式默认 150ms) ' + m[0], f, line, false, 150)
    }
  }

  // ===== 2) CSS 属性 / inline style 字面量（.css 全量 + .tsx 的 style={{}}）=====
  {
    const re = /\b(padding|margin|gap)(-(top|right|bottom|left|inline|block))?\s*:\s*([^;,\n}]+)/g
    let m
    while ((m = re.exec(text))) {
      const prop = m[1] + (m[2] || '')
      const val = m[4].trim()
      const line = lineOf(text, m.index)
      const isToken = /var\(--/.test(val)
      let px = null
      const pxm = val.match(/(-?[\d.]+)px/)
      if (pxm) px = Number(pxm[1])
      record(buckets.spacing, `${prop}: ${val}`, f, line, isToken, px)
    }
  }
  {
    const re = /font-size\s*:\s*([^;,\n}]+)/g
    let m
    while ((m = re.exec(text))) {
      const val = m[1].trim()
      const line = lineOf(text, m.index)
      const isToken = /var\(--/.test(val)
      let px = null
      const pxm = val.match(/(-?[\d.]+)px/)
      if (pxm) px = Number(pxm[1])
      record(buckets.fontSize, `font-size: ${val}`, f, line, isToken, px)
    }
  }
  {
    const re = /border-radius\s*:\s*([^;,\n}]+)/g
    let m
    while ((m = re.exec(text))) {
      const val = m[1].trim()
      const line = lineOf(text, m.index)
      const isToken = /var\(--/.test(val)
      let px = null
      const pxm = val.match(/(-?[\d.]+)px/)
      if (pxm) px = Number(pxm[1])
      record(buckets.radius, `border-radius: ${val}`, f, line, isToken, px)
    }
  }
  {
    const re = /box-shadow\s*:\s*([^;\n}]+)/g
    let m
    while ((m = re.exec(text))) {
      const val = m[1].trim()
      const line = lineOf(text, m.index)
      const isToken = /var\(--/.test(val)
      record(buckets.shadow, `box-shadow: ${val}`, f, line, isToken, null)
    }
  }
  {
    const re = /\b(transition|animation)(-duration)?\s*:\s*([^;\n}]+)/g
    let m
    while ((m = re.exec(text))) {
      const val = m[3].trim()
      const line = lineOf(text, m.index)
      const isToken = /var\(--/.test(val)
      record(buckets.duration, `${m[1]}${m[2] || ''}: ${val}`, f, line, isToken, null)
      // 顺带把裸时长字面量（0.22s / 220ms）单独摘出来算一份
      const durMatches = val.matchAll(/(-?[\d.]+)(ms|s)\b/g)
      for (const dm of durMatches) {
        if (/var\(--/.test(val)) continue
        const msVal = dm[2] === 's' ? Number(dm[1]) * 1000 : Number(dm[1])
        record(buckets.duration, `字面量 ${dm[0]}`, f, line, false, msVal)
      }
      const easeMatches = val.matchAll(/cubic-bezier\([^)]*\)|ease-in-out|ease-in|ease-out|\bease\b|\blinear\b/g)
      for (const em of easeMatches) {
        if (/var\(--/.test(val)) continue
        record(buckets.easing, em[0], f, line, false, null)
      }
    }
  }
  {
    const re = /font-weight\s*:\s*(var\([^)]*\)|[0-9]{3}|[a-z-]+)/g
    let m
    while ((m = re.exec(text))) {
      const val = m[1].trim()
      const line = lineOf(text, m.index)
      const isToken = /var\(--/.test(val)
      record(buckets.fontWeight, `font-weight: ${val}`, f, line, isToken, isToken ? null : Number(val) || null)
    }
  }
  {
    const re = /line-height\s*:\s*([^;\n}]+)/g
    let m
    while ((m = re.exec(text))) {
      const val = m[1].trim()
      const line = lineOf(text, m.index)
      const isToken = /var\(--/.test(val)
      record(buckets.lineHeight, `line-height: ${val}`, f, line, isToken, null)
    }
  }

  // ===== 3) 附加扫描 =====
  // inline style={{ ... }}（仅 .tsx/.ts）
  if (!isCss) {
    const re = /style=\{\{/g
    let m
    let cnt = 0
    while ((m = re.exec(text))) cnt++
    if (cnt) extra.inlineStyle.set(f, cnt)
  }
  // !important
  {
    const re = /!important/g
    let m
    let cnt = 0
    while ((m = re.exec(text))) cnt++
    if (cnt) extra.important.set(f, cnt)
  }
  // hex 颜色字面量（排除 theme.css 自身 —— 那是 token 源头，不算"组件里的硬编码"）
  if (relPath(f) !== 'desktop/src/renderer/src/styles/theme.css') {
    const re = /#[0-9a-fA-F]{3,8}\b/g
    let m
    while ((m = re.exec(text))) {
      const line = lineOf(text, m.index)
      record2(extra.hexColor, m[0], f, line)
    }
    const re2 = /\brgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?[^)]*\)/g
    while ((m = re2.exec(text))) {
      const line = lineOf(text, m.index)
      record2(extra.rgbColor, m[0], f, line)
    }
  }
}

function record2(map, raw, file, line) {
  let e = map.get(raw)
  if (!e) {
    e = { count: 0, files: new Set(), examples: [] }
    map.set(raw, e)
  }
  e.count++
  e.files.add(file)
  if (e.examples.length < 3) e.examples.push(`${relPath(file)}:${line}`)
}

// ---------- 输出 ----------
const out = []
const p = (s = '') => out.push(s)

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1].count - a[1].count)
}

function tokenRatio(map) {
  let total = 0
  let tokenCnt = 0
  for (const [, e] of map) {
    total += e.count
    if (e.isToken) tokenCnt += e.count
  }
  return { total, tokenCnt, hardcodedCnt: total - tokenCnt, ratio: total ? (total - tokenCnt) / total : 0 }
}

function printCategory(title, map, unit) {
  p(`### ${title}`)
  p()
  const { total, tokenCnt, hardcodedCnt, ratio } = tokenRatio(map)
  p(`- 总命中：${total}　·　走 token：${tokenCnt}　·　裸值：${hardcodedCnt}　·　**裸值占比：${(ratio * 100).toFixed(1)}%**`)
  p()
  p('| 值 | 换算 | 走token | 次数 | 文件数 | 示例 |')
  p('|---|---|---|---|---|---|')
  for (const [raw, e] of sortedEntries(map)) {
    const conv = e.px != null ? `${e.px}${unit || 'px'}` : ''
    const convStr = title.includes('字重') ? (e.px != null ? `${e.px}` : '') : conv
    p(`| \`${raw}\` | ${convStr} | ${e.isToken ? '✓' : ''} | ${e.count} | ${e.files.size} | ${e.examples.join('; ')} |`)
  }
  p()
}

p('# A5 — UI 硬编码数值统计（脚本输出）')
p()
p(`扫描范围：\`desktop/src/renderer/src/\`，共 ${files.length} 个文件（.tsx/.ts/.css）`)
p()
p('> 判定口径：Tailwind 语义类（如 `text-sm`/`rounded-lg`/`shadow-card`，映射见 `tailwind.config.js`）与')
p('> `var(--...)` 计为"走 token"；Tailwind 默认数值刻度类（`p-4`/`shadow-lg`/`font-bold`/`rounded-2xl` 等，')
p('> 未在 config 里被 extend 覆盖）、任意值 `[...]`、CSS/inline 字面量数值计为"裸值"。')
p()

printCategory('1. 间距（padding / margin / gap / space-x,y）', buckets.spacing)
printCategory('2. 字号（font-size）', buckets.fontSize)
printCategory('3. 圆角（border-radius）', buckets.radius)
printCategory('4. 阴影（box-shadow）', buckets.shadow)
printCategory('5a. 行高（line-height）', buckets.lineHeight)
printCategory('5b. 字重（font-weight）', buckets.fontWeight)

p('## 每个文件的硬编码密度')
p()
p('| 文件 | 总行数 | 硬编码计数 | 每百行密度 |')
p('|---|---|---|---|')
const densityRows = [...fileHardcodeCount.entries()]
  .map(([f, cnt]) => {
    const lines = fileLines.get(f).length
    return { file: relPath(f), lines, cnt, density: lines ? (cnt / lines) * 100 : 0 }
  })
  .sort((a, b) => b.density - a.density)
for (const r of densityRows) {
  p(`| ${r.file} | ${r.lines} | ${r.cnt} | ${r.density.toFixed(1)} |`)
}
p()

p('## 附加扫描')
p()
p('### inline `style={{…}}`')
p()
p(`总计 ${[...extra.inlineStyle.values()].reduce((a, b) => a + b, 0)} 处，涉及 ${extra.inlineStyle.size} 个文件`)
p()
p('| 文件 | 次数 |')
p('|---|---|')
for (const [f, cnt] of [...extra.inlineStyle.entries()].sort((a, b) => b[1] - a[1])) {
  p(`| ${relPath(f)} | ${cnt} |`)
}
p()

p('### `!important`')
p()
p(`总计 ${[...extra.important.values()].reduce((a, b) => a + b, 0)} 处`)
if (extra.important.size) {
  p()
  p('| 文件 | 次数 |')
  p('|---|---|')
  for (const [f, cnt] of extra.important.entries()) p(`| ${relPath(f)} | ${cnt} |`)
}
p()

p('### 颜色字面量残留（#hex / rgb / rgba），验证 HANDOFF「组件里已无硬编码色值」')
p()
const hexTotal = [...extra.hexColor.values()].reduce((a, b) => a + b.count, 0)
const rgbTotal = [...extra.rgbColor.values()].reduce((a, b) => a + b.count, 0)
p(`hex 字面量：${hexTotal} 处（不含 theme.css 自身）　·　rgb/rgba 字面量：${rgbTotal} 处`)
p()
if (hexTotal) {
  p('**#hex：**')
  p()
  p('| 值 | 次数 | 文件数 | 示例 |')
  p('|---|---|---|---|')
  for (const [raw, e] of sortedEntries(extra.hexColor)) p(`| \`${raw}\` | ${e.count} | ${e.files.size} | ${e.examples.join('; ')} |`)
  p()
}
if (rgbTotal) {
  p('**rgb/rgba：**')
  p()
  p('| 值 | 次数 | 文件数 | 示例 |')
  p('|---|---|---|---|')
  for (const [raw, e] of sortedEntries(extra.rgbColor)) p(`| \`${raw}\` | ${e.count} | ${e.files.size} | ${e.examples.join('; ')} |`)
  p()
}
if (!hexTotal && !rgbTotal) p('**结论：未扫到组件层的颜色字面量残留（theme.css 自身除外）——HANDOFF 的说法核实为真。**')
p()

printCategory('6. 动效：时长与缓动', buckets.duration, 'ms')
printCategory('  （其中缓动函数另列）', buckets.easing, '')

process.stdout.write(out.join('\n') + '\n')
