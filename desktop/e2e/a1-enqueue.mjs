/**
 * 投递链路验收：整包拖入递归 + 落位一致率（A-1）。
 * 运行: node e2e/a1-enqueue.mjs
 *
 * **为什么单独一个脚本，而不是并进 walkthrough.mjs**：
 * enqueue 断言必然要往投递箱写文件，而写文件必然踢起一轮 pipeline。放在主走查中段，
 * 那一轮 pipeline 会把后面按时序写的断言整体推偏——实测就是这么挂的：
 * 主走查跑到「投递箱进度条」时已经是 `上云 7/7`（本该刚开始），
 * 紧接着 reload 断言就因为任务已结束而失败。这不是把某条断言写稳能解决的，
 * 是「同一个 vault 上有两个东西在抢 pipeline 时序」。所以拆开，各用各的隔离库。
 *
 * **零 LLM 调用**：隔离 userData 不写打标 key → orchestrator 走 `--skip-llm`
 * （见 `src/main/inbox/orchestrator.ts`：`if (llmKey) … else args.push('--skip-llm')`）。
 * 这里验的是结构——递归、子路径保留、护栏计数、落位——不是打标质量。
 *
 * **期望值不从产品代码来**：直接遍历源树自己算一份，否则就是拿实现验实现。
 */
import { _electron as electron } from 'playwright-core'
import { readFileSync, rmSync, mkdirSync, existsSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, relative, extname, basename, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = process.env.A1_SRC || '/Users/tansenpeng/Documents/AI/maggie-personal-data'
const USERDATA = '/tmp/mcnai-a1-userdata'
const VAULT = '/tmp/mcnai-a1-vault'

const t0 = Date.now()
const say = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const fail = (m) => {
  console.error('❌ ' + m)
  process.exitCode = 1
  throw new Error(m)
}

if (!existsSync(SRC)) {
  console.error(`源数据不在：${SRC}（用 A1_SRC 指定别的目录）`)
  process.exit(1)
}

// 别的实例不能盯着同一个库（HANDOFF §4-22b）
{
  const { execSync } = await import('child_process')
  const busy = execSync('ps -eo pid,command')
    .toString()
    .split('\n')
    .filter((l) => l.includes('mcn-ingest') && !l.includes('grep'))
  if (busy.length) {
    console.error('拒跑：已有 mcn-ingest 在跑\n' + busy.join('\n'))
    process.exit(1)
  }
}

// ---- 期望值：自己遍历源树算，规则与 orchestrator 的 SUPPORTED_EXT / JUNK 对齐 ----
const SUPPORTED = new Set(['.md', '.txt', '.docx', '.pdf', '.xlsx', '.pptx'])
const JUNK_DIRS = new Set(['node_modules', 'venv', '.venv', '.git', '__MACOSX', '__pycache__'])
const junk = (n) => n.startsWith('.') || n.startsWith('~$') || JUNK_DIRS.has(n) || n.endsWith('.app')

/** 相对路径 → [category, sub_category]，口径与 pipeline 的 `03b_tag_rules` 一致 */
const expected = new Map()
let expUnsupported = 0
let expJunk = 0
const scan = (dir, rel) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (junk(e.name)) expJunk++
      else scan(p, join(rel, e.name))
    } else if (e.isFile()) {
      if (junk(e.name) || statSync(p).size === 0) expJunk++
      else if (!SUPPORTED.has(extname(e.name).toLowerCase())) expUnsupported++
      else {
        const r = join(rel, e.name)
        const parts = r.split('/')
        expected.set(r, [parts.length > 1 ? parts[0] : '未分类', parts.length > 2 ? parts[1] : ''])
      }
    }
  }
}
scan(SRC, '')
const maxSrcDepth = Math.max(...[...expected.keys()].map((p) => p.split('/').length))
say(`源树：应入箱 ${expected.size} 个　不支持格式 ${expUnsupported}　隐藏/空 ${expJunk}　最深 ${maxSrcDepth} 层`)

// ---- 隔离实例 ----
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
// 与主走查同一套：关掉过渡动画，否则截图会糊在淡入中间帧（看着像对比度坏了）
await win.setViewportSize({ width: 1440, height: 920 })
await (await app.context().newCDPSession(win)).send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
})
await win.waitForTimeout(2000)

// 首跑停在登录门，不过它就进不到知识库页（拖放锚点在那儿）
await win.click('text=暂不登录').catch(() => {})
await win.waitForTimeout(800)

const settings = await win.evaluate(() => window.api.settings.get())
if (settings.aiReady) fail('隔离实例里竟然有打标 key——这一轮就不是零 LLM 调用了')
say('线路自检：无打标 key → pipeline 走 --skip-llm ✓')

await app.evaluate(({ dialog }, target) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
}, VAULT)
await win.evaluate(() => window.api.vault.createNew())

// ---- ① 一次 enqueue 整个源根（= 用户把整个文件夹拖进窗口）----
const r = await win.evaluate((p) => window.api.inbox.enqueue([p]), SRC)
say(`enqueue 返回 ${JSON.stringify(r)}`)
if (r.added !== expected.size)
  fail(`整包拖入没有全部入队：实收 ${r.added}，期望 ${expected.size}`)
if (r.skippedUnsupported !== expUnsupported || r.skippedJunk !== expJunk)
  fail(`护栏计数对不上：期望 不支持 ${expUnsupported} / 隐藏空 ${expJunk}`)
if (r.truncated) fail('不该被单次上限截断')

// ---- ② 投递箱里的相对路径必须与源树逐条相同 ----
// 必须**趁 pipeline 还没消费**就抓：跑完之后原件会被打平归档进 .done/<日期>/
const inboxDir = readdirSync(VAULT)
  .map((n) => join(VAULT, n))
  .filter((p) => statSync(p).isDirectory() && /投递箱|待入库/.test(basename(p)))[0]
if (!inboxDir) fail('找不到投递箱目录')
const listFiles = (d, base = d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith('.')
      ? []
      : e.isDirectory()
        ? listFiles(join(d, e.name), base)
        : [relative(base, join(d, e.name))]
  )
const got = new Set(listFiles(inboxDir))
const missing = [...expected.keys()].filter((p) => !got.has(p))
const extra = [...got].filter((p) => !expected.has(p))
if (missing.length || extra.length)
  fail(`投递箱里的相对路径与源树不一致（被拍平了？）缺 ${missing.length} 多 ${extra.length}\n` +
    `  缺失样例：${missing.slice(0, 5).join(' | ')}\n  多出样例：${extra.slice(0, 5).join(' | ')}`)
const gotDepth = Math.max(...[...got].map((p) => p.split('/').length))
if (gotDepth !== maxSrcDepth) fail(`投递箱最深 ${gotDepth} 层，源树 ${maxSrcDepth} 层——子路径没保全`)
say(`投递箱实收 ${got.size} 个，相对路径逐条相同，最深 ${gotDepth} 层 ✓`)

// ---- ③ 空目录 / 全不支持格式：不许静默 ----
const mk = (name, files) => {
  const d = join('/tmp', name)
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true })
  for (const f of files) writeFileSync(join(d, f), 'x')
  return d
}
const rBad = await win.evaluate((p) => window.api.inbox.enqueue([p]), mk('mcnai-a1-bad', ['a.zip', 'b.dmg']))
if (rBad.added !== 0 || rBad.skippedUnsupported !== 2)
  fail(`全不支持格式的目录结果不对：${JSON.stringify(rBad)}`)
const rEmpty = await win.evaluate((p) => window.api.inbox.enqueue([p]), mk('mcnai-a1-empty', []))
if (rEmpty.added !== 0) fail(`空目录竟然入队了文件：${JSON.stringify(rEmpty)}`)
say('空目录 / 全不支持格式：均返回 added=0 且带跳过计数 ✓')

// ---- ④ 文案走真实拖入，验的是「说出来」这一步 ----
// 只断言返回值是不够的：修复前那条路径**拿到结果就扔了**，返回值一直是对的
// 拖之前先确保停在知识库页：建完库不一定就落在这儿，搜索框（拖放锚点）没渲染出来的话
// 事件根本没人接，toast 自然等不到
await win.click('text=个人知识库').catch(() => {})
await win.locator('input[placeholder="搜索库…"]').waitFor({ timeout: 15000 })

const dropDir = async (p) => {
  await win.mouse.move(0, 0)
  await win.locator('[data-testid="toast"]').first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {})
  await win.evaluate((path) => {
    const dt = new DataTransfer()
    const f = new File(['x'], path.split('/').pop())
    Object.defineProperty(f, 'path', { value: path }) // Electron 30 真实拖入就是靠这个字段
    dt.items.add(f)
    const el =
      document.querySelector('input[placeholder="搜索库…"]') ??
      document.querySelector('main .relative.flex.h-full')
    el?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, p)
  await win.locator('[data-testid="toast"]').first().waitFor({ timeout: 8000 })
  return (await win.locator('[data-testid="toast"]').first().innerText()).replace(/\s+/g, '')
}
const badMsg = await dropDir('/tmp/mcnai-a1-bad')
if (!/未发现可入库的文件/.test(badMsg) || !/已跳过2个不支持的格式/.test(badMsg))
  fail(`全不支持格式的提示不明确：「${badMsg}」`)
const emptyMsg = await dropDir('/tmp/mcnai-a1-empty')
if (!/未发现可入库的文件/.test(emptyMsg)) fail(`空目录的提示不明确：「${emptyMsg}」`)
mkdirSync(join(root, 'e2e', 'shots'), { recursive: true })
await win.screenshot({ path: join(root, 'e2e', 'shots', 'a1-拖入无可入库文件-明确提示.png') })
say(`空态提示 ✓ 「${badMsg}」/「${emptyMsg}」`)

// ---- ⑤ 落位一致率：pipeline 跑完，逐篇比 category/sub_category ----
say('等 pipeline（watcher 触发，3 秒去抖）…')
let done = false
for (let i = 0; i < 180 && !done; i++) {
  await win.waitForTimeout(5000)
  const t = await win.evaluate(() => window.api.tasks.list())
  const inbox = (t.tasks ?? t).filter?.((x) => x.kind === 'inbox') ?? []
  if (i % 6 === 0) say(`  …任务 ${JSON.stringify(inbox.map((x) => x.status))}`)
  if (inbox.length && !inbox.some((x) => x.status === 'queued' || x.status === 'running')) done = true
}
if (!done) fail('等 pipeline 超时')

const notes = []
const walkVault = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || /投递箱|待入库/.test(e.name)) continue
    const p = join(d, e.name)
    if (e.isDirectory()) walkVault(p)
    else if (e.name.endsWith('.md')) notes.push(p)
  }
}
walkVault(VAULT)
const frontmatter = (p) => {
  const m = readFileSync(p, 'utf-8').match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  return Object.fromEntries(
    m[1]
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()])
      .filter(([k]) => k)
  )
}
const byStem = new Map()
for (const [rel, cats] of expected) byStem.set(basename(rel).replace(/\.[^.]+$/, ''), cats)

let hit = 0
const misses = []
let skipped = 0
for (const p of notes) {
  const want = byStem.get(basename(p).replace(/\.md$/, ''))
  if (!want) {
    skipped++ // MOC / 主题索引等非源文件笔记，不参与
    continue
  }
  const f = frontmatter(p)
  if (f.category === want[0] && (f.sub_category ?? '') === want[1]) hit++
  else misses.push(`${basename(p)}: 实际 ${f.category}/${f.sub_category} 期望 ${want[0]}/${want[1]}`)
}
const rate = hit + misses.length ? (hit / (hit + misses.length)) * 100 : 0
say(`落位比对：命中 ${hit}　不一致 ${misses.length}　非源文件笔记 ${skipped}　→ 一致率 ${rate.toFixed(1)}%`)
misses.slice(0, 8).forEach((m) => console.log('  ✗ ' + m))
if (rate < 100) fail(`落位一致率 ${rate.toFixed(1)}%，低于 100%`)

await Promise.race([app.close(), new Promise((res) => setTimeout(res, 15000))])
say('投递链路验收通过 ✓')
