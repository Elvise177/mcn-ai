/**
 * Maggie 源数据全量重跑 · A-3 验收（实体层 + 图片能力）。
 * 运行: node e2e/full-rerun.mjs
 *
 * **跑在冻结产物上**：`pipelineBin()` 在 dev app 形态解析到的就是
 * `resources/pipeline/mcn-ingest`（冻结二进制），入库链路与打包形态跑的是同一份。
 *
 * **打标 key 怎么来、又为什么不上云**：登录测试账号会 provision 出打标 key，
 * 但 QA 基线是**未登录**跑的（刻意不把 Maggie 的真实数据推到云端私人层）。
 * 所以这里「登录取 key → 登出 → 再入库」：`logout()` 只登出 Supabase、不清
 * `encryptedLlmKey`，于是既有真实打标线路，又保持 `cloud_sync: skipped 未登录`。
 *
 * 对照基线见 docs/QA-REPORT-diff.md：双链 旧 352 / 新 2，达人卡 老库 156。
 */
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { execSync } from 'child_process'

const root = '/Users/tansenpeng/Documents/AI/mcn-ai/desktop'
const SRC = process.env.A1_SRC || '/Users/tansenpeng/Documents/AI/maggie-personal-data'
const USERDATA = '/tmp/mcnai-full-userdata'
const VAULT = '/tmp/mcnai-full-vault'
const t0 = Date.now()
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)

if (!existsSync(SRC)) {
  console.error(`源数据不在：${SRC}`)
  process.exit(1)
}
// 别的实例不能盯着同一个库（HANDOFF §4-22b）
{
  const busy = execSync('ps -eo pid,command').toString().split('\n')
    .filter((l) => l.includes('mcn-ingest') && !l.includes('grep'))
  if (busy.length) {
    console.error('拒跑：已有 mcn-ingest 在跑\n' + busy.join('\n'))
    process.exit(1)
  }
}

rmSync(USERDATA, { recursive: true, force: true })
rmSync(VAULT, { recursive: true, force: true })
mkdirSync(USERDATA, { recursive: true })

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [root],
  env: { ...process.env, MCNAI_USER_DATA: USERDATA, MCNAI_VAULT: VAULT, NODE_ENV: 'production' },
  timeout: 60000,
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1440, height: 920 })
await win.waitForTimeout(2500)

// ---- ① 登录取打标 key，随即登出（保持不上云）----
const login = await win.evaluate(() =>
  window.api.auth.login('mcnai-test-a@example.com', 'McnAi-Test-2026!')
)
say(`登录：${JSON.stringify(login).slice(0, 120)}`)
for (let i = 0; i < 40; i++) {
  const s = await win.evaluate(() => window.api.settings.get())
  if (s.hasLlmKey) break
  await win.waitForTimeout(1500)
}
const afterLogin = await win.evaluate(() => window.api.settings.get())
if (!afterLogin.hasLlmKey) {
  console.error('❌ 登录后仍没有打标 key，不能跑真实打标')
  await app.close()
  process.exit(1)
}
say(`打标 key 已下发：线路 ${afterLogin.llmBaseUrl}`)
await win.evaluate(() => window.api.auth.logout())
await win.waitForTimeout(1500)
say('已登出（cloud_sync 应报 skipped 未登录，与 QA 基线同条件）')

// ---- ② 建库（走产品自己的向导，layout.json 带 entities 段）----
await app.evaluate(({ dialog }, target) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
}, VAULT)
await win.evaluate(() => window.api.vault.createNew())
say(`已建库 ${VAULT}`)

// ---- ③ 整包入库 ----
const r = await win.evaluate((p) => window.api.inbox.enqueue([p]), SRC)
say(`入箱：${JSON.stringify(r)}`)

// ---- ④ 等跑完（打标 55 篇，QA 基线墙钟 8.6 分钟）----
let stages = []
for (let i = 0; i < 360; i++) {
  await win.waitForTimeout(5000)
  const t = await win.evaluate(() => window.api.tasks.list())
  const inbox = (t.tasks ?? t).filter?.((x) => x.kind === 'inbox') ?? []
  if (inbox[0]?.stages) stages = inbox[0].stages
  if (i % 6 === 0) {
    const p = inbox[0]?.progress
    say(`  …${inbox.map((x) => x.status).join(',')} ${p ? `${p.done}/${p.total} ${p.label}` : ''}`)
  }
  if (inbox.length && !inbox.some((x) => x.status === 'queued' || x.status === 'running')) break
}
say('pipeline 结束')
for (const s of stages) {
  if (s.type === 'stage') console.log(`   · ${s.stage} ${s.status}${s.message ? ' — ' + s.message : ''}`)
}

// ---- ⑤ 量化对照 ----
const graph = await win.evaluate(() => window.api.vault.graph())
const cardDir = (k) => join(VAULT, '30_实体', k)
const cards = (k) => (existsSync(cardDir(k)) ? readdirSync(cardDir(k)).filter((f) => f.endsWith('.md')) : [])
const readFm = (p) => {
  const m = readFileSync(p, 'utf-8').match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  return Object.fromEntries(
    m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]).filter(([k]) => k)
  )
}
const notes = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || /投递箱|_assets/.test(e.name)) continue
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.md')) notes.push(p)
  }
}
walk(VAULT)

// 双链口径与 QA §1.2 一致：正文内的唯一 wiki 链接
const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
let links = 0
const libNotes = notes.filter((p) => p.includes('80_资料库') && !/\/_/.test(p))
for (const p of libNotes) {
  const raw = readFileSync(p, 'utf-8')
  const body = raw.startsWith('---') ? raw.split('---').slice(2).join('---') : raw
  links += new Set([...body.matchAll(WIKI)].map((m) => m[1].trim())).size
}

// 合同枢纽：is_contract 的文档有没有同时连上三类卡
const contracts = libNotes.filter((p) => readFm(p).is_contract === 'true')
const hub = contracts.map((p) => {
  const b = readFileSync(p, 'utf-8')
  return {
    file: p.split('/').pop(),
    达人: (b.match(/30_实体\/达人\//g) || []).length,
    产品: (b.match(/30_实体\/产品\//g) || []).length,
    合作方: (b.match(/30_实体\/合作方\//g) || []).length,
  }
})

// 花费：从 checkpoint 逐条累加（pipeline 自己的口径），比读 stdout 准
const ckPath = join(VAULT, '80_资料库', '.checkpoint.jsonl')
let cost = 0
let calls = 0
let tin = 0
let tout = 0
if (existsSync(ckPath)) {
  for (const l of readFileSync(ckPath, 'utf-8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(l)
    if (rec.guard) continue
    cost += rec.cost || 0
    calls++
    tin += rec.usage?.prompt_tokens || 0
    tout += rec.usage?.completion_tokens || 0
  }
}
const assetBytes = existsSync(join(VAULT, '_assets'))
  ? execSync(`du -sk "${join(VAULT, '_assets')}" | cut -f1`).toString().trim() * 1024
  : 0
const fmComplete = libNotes.filter((p) => {
  const f = readFm(p)
  return f.doc_type && f.category && f.tags && f.summary
}).length

const report = {
  墙钟分钟: +((Date.now() - t0) / 60000).toFixed(1),
  打标: { 调用次数: calls, 输入token: tin, 输出token: tout, 花费元: +cost.toFixed(3) },
  笔记: { 库内: libNotes.length, frontmatter齐全: fmComplete },
  卡: { 达人: cards('达人').length, 产品: cards('产品').length, 合作方: cards('合作方').length },
  敏感卡: ['达人', '产品', '合作方'].reduce(
    (n, k) => n + cards(k).filter((f) => /^sensitive: true$/m.test(readFileSync(join(cardDir(k), f), 'utf-8'))).length, 0
  ),
  双链: { 本次: links, 旧库基线: 352, 上次新版: 2 },
  图谱: { 节点: graph.nodes.length, 边: graph.links.length },
  嵌图: { 张数: existsSync(join(VAULT, '_assets')) ? readdirSync(join(VAULT, '_assets')).reduce((n, d) => n + readdirSync(join(VAULT, '_assets', d)).length, 0) : 0, MB: +(assetBytes / 1048576).toFixed(1) },
  合同枢纽: hub,
  合作方卡: cards('合作方').map((f) => f.replace('.md', '')),
}
console.log('\n===== A-3 全量重跑对照 =====')
console.log(JSON.stringify(report, null, 2))
writeFileSync('/tmp/full-rerun-report.json', JSON.stringify(report, null, 2))
await win.screenshot({ path: join(root, 'e2e/shots/full-重跑后图谱.png') })
await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20000))])
say('重跑完成，报告已写 /tmp/full-rerun-report.json')
