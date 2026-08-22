/**
 * 0.2.0 批 3 验收：**用第二个客户（Jerry）的真实文件包走完整流程**。
 *
 * 全新机器 → 登录 → 用「通用」模板建库 → 投 166 个真实文件 → 真打标 → 看结果。
 *
 * 验收标准（用户定的三条）：
 *   ① 客户目录结构成为一级分类、不再全埋在资料库下面
 *   ② 没有 MCN 噪音目录
 *   ③ 打标口吻中性——摘要不能是"美妆带货MCN资料管理员"写的
 *
 * **①在这一批做不到，这是已经报备过的预期落差**：批 3 只改了"建库不预建目录"，
 * 落位规则没动，转换产出仍落在 `<library>/管理/…`。这个脚本如实把实际结构打出来，
 * 供用户判断要不要为它单开一批。**不许因为标准没达成就悄悄改标准。**
 *
 * 花费：≈¥0.85（166 个文件 × ¥0.0051，按 Maggie 库 164 篇 ¥0.84 折算）。
 * 跑法：`node e2e/jerry-acceptance.mjs`
 */
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync, cpSync, readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC =
  '/Users/tansenpeng/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/' +
  'com.tencent.xinWeChat/2.0b4.0.9/695911b04faff33f5af3c0ca5973e2c2/Message/MessageTemp/' +
  '92f1f177ca4b9dceb791a60936db2c4f/File/知识库搭建【Jerry】'
const VAULT = '/tmp/samepage-jerry-vault'
const UD = '/tmp/samepage-jerry-ud'
const shots = new URL('./shots/', import.meta.url).pathname

let bad = 0
const check = (name, ok, extra = '') => {
  if (!ok) bad++
  console.log(`   ${ok ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`)
}
const step = (t) => console.log(`\n${t}`)

if (!existsSync(SRC)) {
  console.log(`❌ 找不到 Jerry 资料包：${SRC}`)
  process.exit(1)
}

rmSync(VAULT, { recursive: true, force: true })
rmSync(UD, { recursive: true, force: true })
mkdirSync(UD, { recursive: true })

const env = { ...process.env, MCNAI_USER_DATA: UD, MCNAI_E2E_NEW_VAULT: VAULT }
delete env.MCNAI_VAULT
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()

try {
  step('【1】登录（打标 key 要靠它下发）')
  await win.waitForSelector('input[placeholder="邮箱"]', { timeout: 20000 })
  await win.fill('input[placeholder="邮箱"]', 'mcnai-test-a@example.com')
  await win.fill('input[placeholder="密码"]', 'McnAi-Test-2026!')
  await win.click('button:has-text("登录")')
  await win.waitForSelector('button:has-text("新建库")', { timeout: 90000 })
  let s = {}
  for (let i = 0; i < 60; i++) {
    s = await win.evaluate(() => window.api.settings.get())
    if (s.hasLlmKey) break
    await win.waitForTimeout(1000)
  }
  check('打标 key 已下发（没有它这轮就是空跑）', !!s.hasLlmKey)
  if (!s.hasLlmKey) throw new Error('没拿到打标 key，中止——不要跑一轮假的')

  step('【2】用「通用」模板建库')
  await win.click('[data-testid="wizard-create"]')
  await win.click('[data-testid="wizard-template-general"]')
  await win.waitForTimeout(6000)
  const cfg = JSON.parse(readFileSync(join(VAULT, '.mcnai/layout.json'), 'utf-8'))
  check('persona = general', cfg.persona.id === 'general', cfg.persona.id)
  const top0 = readdirSync(VAULT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  check('干净新库（只有投递箱+资料库+配置）', JSON.stringify(top0) === JSON.stringify(['.mcnai', '00_投递箱', '80_资料库']),
    JSON.stringify(top0))

  step('【3】投入 Jerry 的 166 个真实文件（保留他自己的目录结构）')
  cpSync(SRC, join(VAULT, cfg.inbox), { recursive: true })
  const dropped = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.DS_Store') continue
      const p = join(d, e.name)
      e.isDirectory() ? walk(p) : dropped.push(relative(join(VAULT, cfg.inbox), p))
    }
  }
  walk(join(VAULT, cfg.inbox))
  console.log(`   投入 ${dropped.length} 个文件（含 8 个不支持格式）`)
  await win.evaluate((root) => window.api.inbox.enqueue([root]), join(VAULT, cfg.inbox))

  step('【4】等它跑完（真打标，几分钟）')
  const t0 = Date.now()
  for (let i = 0; i < 2400; i++) {
    const st = await win.evaluate(async () => {
      const s = await window.api.tasks.list()
      const t = s.tasks.find((x) => x.kind === 'inbox')
      return t ? { status: t.status, label: t.progress?.label, done: t.progress?.done, total: t.progress?.total } : null
    })
    if (st && (st.status === 'succeeded' || st.status === 'failed' || st.status === 'canceled')) {
      console.log(`   跑完：${st.status}，用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`)
      break
    }
    if (i % 20 === 0 && st) console.log(`   … ${st.label ?? ''} ${st.done ?? '?'}/${st.total ?? '?'}`)
    await win.waitForTimeout(3000)
  }

  step('【5】验收标准 ②：没有 MCN 噪音目录')
  const top = readdirSync(VAULT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  console.log(`   顶层目录：${JSON.stringify(top)}`)
  for (const noise of ['20_公司管理', '30_课程', '40_带货']) {
    check(`没有 ${noise}`, !top.includes(noise))
  }

  step('【6】验收标准 ①：客户目录结构在哪一层（如实报，不粉饰）')
  const lib = join(VAULT, cfg.library)
  const libTop = existsSync(lib)
    ? readdirSync(lib, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : []
  console.log(`   ${cfg.library}/ 下的一级目录：${JSON.stringify(libTop)}`)
  console.log(`   库根一级目录：${JSON.stringify(top)}`)
  const atRoot = ['管理', '业务'].every((n) => top.includes(n))
  check('客户分类在库根一级（本批预期做不到，如实记）', atRoot,
    atRoot ? '' : `实际埋在 ${cfg.library}/ 下面 —— 落位规则未改，需单开一批`)

  step('【7】验收标准 ③：打标口吻中性')
  const mds = []
  const walkMd = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walkMd(p)
      else if (e.name.endsWith('.md')) mds.push(p)
    }
  }
  if (existsSync(lib)) walkMd(lib)
  console.log(`   产出笔记 ${mds.length} 篇`)
  const MCN_WORDS = ['达人', '种草', '带货', 'MCN', '美妆', 'OMG']
  const leaked = []
  const samples = []
  for (const p of mds) {
    const t = readFileSync(p, 'utf-8')
    const m = /^summary:\s*"?(.+?)"?\s*$/m.exec(t)
    const cat = /^category:\s*(.+)$/m.exec(t)
    if (m && samples.length < 6) samples.push({ 文件: relative(lib, p), 摘要: m[1], 分类: cat?.[1] })
    // 只看**模型写的字段**（摘要/标签），正文里出现这些词是客户资料本身的内容，不算漏
    const fm = t.split('---')[1] ?? ''
    const hit = MCN_WORDS.filter((w) => fm.includes(w))
    if (hit.length) leaked.push({ 文件: relative(lib, p), 命中: hit })
  }
  console.log('   摘要抽样：')
  for (const s of samples) console.log(`     · ${s.文件}\n       ${s.摘要}  ［${s.分类 ?? '无分类'}］`)
  check(`打标字段里没有 MCN 词汇（扫了 ${mds.length} 篇）`, leaked.length === 0,
    leaked.length ? JSON.stringify(leaked.slice(0, 5)) : '')

  step('【8】花费')
  const ck = join(lib, '.checkpoint.jsonl')
  if (existsSync(ck)) {
    const rows = readFileSync(ck, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const cost = rows.reduce((n, r) => n + (Number(r.cost) || 0), 0)
    console.log(`   实际花费 ¥${cost.toFixed(2)}（打标 ${rows.length} 篇）`)
  }

  await win.click('text=个人知识库').catch(() => {})
  await win.waitForTimeout(3000)
  await win.screenshot({ path: join(shots, 'B3-05-Jerry包-通用模板入库后.png') })
  console.log(`\n   截图 → ${join(shots, 'B3-05-Jerry包-通用模板入库后.png')}`)
} finally {
  await app.close()
}
console.log(bad ? `\n❌ ${bad} 条不通过\n` : '\n✅ 全部通过\n')
process.exit(bad ? 1 : 0)
