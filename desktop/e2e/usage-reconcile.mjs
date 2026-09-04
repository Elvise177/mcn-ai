/**
 * 账本三方对账（PLAN-v2 批 5 R8 的收尾验收）
 *
 * 跑一次**真实入库**（小样本，实测 ¥0.02 量级），然后把同一笔打标花费在三处对齐：
 *
 *   ① pipeline 自己的流水　`<库>/<资料库>/.checkpoint.jsonl` —— 每打一篇写一条 usage，
 *      是**回传之外**的独立记录（03 写 checkpoint 与打 usage 行是两段代码）
 *   ② 落盘账本　`<userData>/usage/YYYY-MM.jsonl` —— 主进程真正入的账
 *   ③ 用量页 / 对账脚本　`usage.summary()` 与 `scripts/usage-report.mjs --json`
 *
 * ①②之间对不上 = 回传或落账断了；②③之间对不上 = 归一化/计价长歪了。
 * **第四方（DeepSeek 官方后台）只能人工比**：脚本最后会把本轮的模型、时间窗、
 * token 三项打出来，拿去后台账单按天核对（bug#8 当年就是这么查出 98.7% 缺口的）。
 *
 * 跑法：node e2e/usage-reconcile.mjs
 * 前置：能连 Supabase 与生产 API（登录后自动下发打标 key），见 desktop/CLAUDE.md 的登录清单。
 */
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync, existsSync, readFileSync, readdirSync, cpSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shots = join(root, 'e2e', 'shots')
mkdirSync(shots, { recursive: true })

const USERDATA = '/tmp/mcnai-usage-userdata'
const VAULT = '/tmp/mcnai-usage-vault'
const PACK = '/tmp/mcnai-usage-pack'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(ok ? `  ✓ ${name}` : `  ❌ ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const t0 = Date.now()
const step = (m) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)

/**
 * 样本来自**仓库里的** `e2e/sample.docx`（铁律：测试素材跟着 git 走，不指向本机私有路径），
 * 复制成几份不同文件名。两级子目录是刻意的——pipeline 用 `rel.parts[0]/[1]`
 * 推 category/sub_category，拍平就是全部「未分类」。
 *
 * **不要图省事投 .md/.txt**（2026-09-04 第一版就是这么写的，白跑一轮）：
 * 那两种走的是直拷路径、保留原 mtime，而 `cli.py` 的 `_tag()` 按 mtime 差集选本批，
 * 于是整批被判成"不是本轮的文件"，LLM 打标一次都不会调——这一轮就什么都对不了账。
 * （那是 pipeline 的既有缺陷，已单独立项；这里只是绕开它，别把它当成本脚本的前提。）
 */
const SAMPLE_DOCX = join(root, 'e2e', 'sample.docx')
const TOPICS = [
  ['工作-执行类/直播脚本', '直播脚本'],
  ['工作-执行类/选品资料', '选品资料'],
  ['工作-管理类/流程制度', '流程制度'],
]
const FILES = []
for (const [dir, kind] of TOPICS) {
  for (let i = 1; i <= 3; i++) FILES.push(join(dir, `${kind}${i}.docx`))
}

if (!existsSync(SAMPLE_DOCX)) {
  console.log(`❌ 找不到样本 ${SAMPLE_DOCX}`)
  process.exit(1)
}
for (const d of [USERDATA, VAULT, PACK]) rmSync(d, { recursive: true, force: true })
mkdirSync(PACK, { recursive: true })
for (const rel of FILES) {
  mkdirSync(dirname(join(PACK, rel)), { recursive: true })
  cpSync(SAMPLE_DOCX, join(PACK, rel))
}
console.log(`样本包 ${FILES.length} 篇（e2e/sample.docx 的副本）→ ${PACK}`)

const app = await electron.launch({
  executablePath: process.env.MCNAI_APP_BIN || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  args: process.env.MCNAI_APP_BIN ? [] : [root],
  env: { ...process.env, MCNAI_USER_DATA: USERDATA, MCNAI_E2E_NEW_VAULT: VAULT },
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 920 })

/** 累加一份 OpenAI 兼容口径的 usage（与 pipeline 的 usage_acc.py 同一件事） */
const accum = (acc, u) => {
  for (const [k, v] of Object.entries(u ?? {})) {
    if (typeof v === 'number') acc[k] = (acc[k] ?? 0) + v
  }
  return acc
}

try {
  step('【1】登录 → 打标 key 下发')
  await win.waitForSelector('input[placeholder="邮箱"]', { timeout: 20000 })
  await win.fill('input[placeholder="邮箱"]', 'mcnai-test-a@example.com')
  await win.fill('input[placeholder="密码"]', 'McnAi-Test-2026!')
  await win.click('button:has-text("登录")')
  await win.waitForSelector('[data-testid="wizard-create"]', { timeout: 90000 })
  let s = {}
  for (let i = 0; i < 60; i++) {
    s = await win.evaluate(() => window.api.settings.get())
    if (s.hasLlmKey) break
    await win.waitForTimeout(1000)
  }
  check('打标 key 已下发（没有它这一轮不会花钱，也就没得对账）', !!s.hasLlmKey)

  step('【2】建模板库 → 投递样本 → 等入库跑完')
  await win.click('[data-testid="wizard-create"]')
  // 建库是**两步**：先选「新建」，再选模板（0.2.0 分类体系配置化之后加的这一步）。
  // 少点这一下的话，`vaultPath` 会一直是 null，报出来的却是「投递箱未就绪」——
  // 方向指到了投递箱，其实是库压根没建（fresh-install.mjs 还停在一步的老写法，另记）
  await win.locator('[data-testid="wizard-templates"]').waitFor({ timeout: 10000 })
  await win.click('[data-testid="wizard-template-mcn"]')
  for (let i = 0; i < 60; i++) {
    if ((await win.evaluate(() => window.api.settings.get())).vaultPath) break
    await win.waitForTimeout(1000)
  }
  await win.waitForTimeout(2000)
  s = await win.evaluate(() => window.api.settings.get())
  check('库建好了', !!s.vaultPath, String(s.vaultPath))
  const vroot = s.vaultPath ?? VAULT

  const startedAt = Date.now()
  const enq = await win.evaluate((p) => window.api.inbox.enqueue([p]), PACK)
  check(`样本收全（期望 ${FILES.length}）`, enq.added === FILES.length, JSON.stringify(enq))

  let task = null
  for (let i = 0; i < 900; i++) {
    const list = await win.evaluate(() => window.api.tasks.list())
    task = (list.tasks ?? list).find((t) => t.kind === 'inbox')
    if (task && (task.status === 'succeeded' || task.status === 'failed')) break
    if (i % 20 === 0) console.log(`    …${task?.status ?? '等待'} ${task?.progress?.done ?? 0}/${task?.progress?.total ?? 6} ${task?.progress?.label ?? ''}`)
    await win.waitForTimeout(1000)
  }
  check('入库跑完且成功', task?.status === 'succeeded', JSON.stringify({ status: task?.status, error: task?.error }))
  const endedAt = Date.now()

  step('【3】① pipeline 流水（.checkpoint.jsonl，独立于回传的那份记录）')
  const libDir = readdirSync(vroot).map((n) => join(vroot, n)).find((p) => existsSync(join(p, '.checkpoint.jsonl')))
  check('找到 checkpoint', !!libDir, readdirSync(vroot).join(','))
  const ckpt = libDir
    ? readFileSync(join(libDir, '.checkpoint.jsonl'), 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    : []
  const tagged = ckpt.filter((r) => r.usage && Object.keys(r.usage).length)
  const ckptUsage = tagged.reduce((a, r) => accum(a, r.usage), {})
  console.log(`    打标 ${tagged.length} 篇，流水合计 ${JSON.stringify(ckptUsage)}`)
  check('确实真调了模型（否则这一轮什么都没验到）', tagged.length > 0, `${tagged.length} 篇`)

  step('【4】② 落盘账本（usage/YYYY-MM.jsonl）')
  const usageDir = join(USERDATA, 'usage')
  const months = existsSync(usageDir) ? readdirSync(usageDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)) : []
  const recs = months.flatMap((f) =>
    readFileSync(join(usageDir, f), 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)))
  const tagRecs = recs.filter((r) => r.taskType === 'ingest-tag')
  console.log(`    账本 ${recs.length} 条，其中入库打标 ${tagRecs.length} 条`)
  for (const r of tagRecs) console.log(`      ${JSON.stringify({ calls: r.calls, model: r.resolved_model, route: r.route, stage: r.attribution?.stage, usage: r.usage })}`)
  check('打标进账了（R8 之前这里是 usage:null）', tagRecs.some((r) => r.usage && Object.keys(r.usage).length > 0), JSON.stringify(tagRecs))

  const tagLlmRec = tagRecs.find((r) => r.attribution?.stage === 'tag_llm')
  check('有 tag_llm 那条，且带归因', !!tagLlmRec && tagLlmRec.attribution?.vault === vroot, JSON.stringify(tagLlmRec?.attribution))
  if (tagLlmRec) {
    // ①②逐字段对齐：pipeline 流水的合计 == 账本里存的那份
    for (const k of ['prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens']) {
      if (ckptUsage[k] == null && tagLlmRec.usage?.[k] == null) continue
      check(`① == ② · ${k}`, ckptUsage[k] === tagLlmRec.usage?.[k], `流水 ${ckptUsage[k]} vs 账本 ${tagLlmRec.usage?.[k]}`)
    }
    check('① == ② · 调用次数', tagged.length === tagLlmRec.calls, `流水 ${tagged.length} 篇 vs 账本 calls=${tagLlmRec.calls}`)
    check('线路记的是打标那条（计价按线路取单价）', tagLlmRec.route === 'deepseek', String(tagLlmRec.route))
    check('模型是 pipeline 回报的那个', !!tagLlmRec.resolved_model, String(tagLlmRec.resolved_model))
  }

  step('【5】③ 用量页与对账脚本')
  const sum = await win.evaluate(() => window.api.usage.summary())
  const row = sum.byType.find((r) => r.type === 'ingest-tag')
  console.log(`    用量页按类型 · 入库打标：${JSON.stringify(row)}`)
  check('用量页把打标的 token 显示出来了', !!row && row.tokens > 0, JSON.stringify(row))
  check('本月没有未计量的打标（新产物已全量回传）', sum.ingest.unmetered === 0, JSON.stringify(sum.ingest))

  /**
   * ②③：账本里那几条的 token 之和 == 用量页那一行。
   * **这里故意不调用应用的 `tokensOf`**——用它就是拿被测的东西验被测的东西。
   * 打标链路是 OpenAI 兼容口径，缓存命中**含在 prompt_tokens 里**，
   * 所以「总量」就是 prompt + completion，与命中多少无关（挪不改总量）。
   * 归一化要是把命中又加了一遍，这条就会红。
   */
  const ledgerTokens = tagRecs.reduce(
    (n, r) => n + (r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0),
    0
  )
  check('② == ③ · token 合计', row?.tokens === ledgerTokens, `账本 ${ledgerTokens} vs 用量页 ${row?.tokens}`)

  const { execFileSync } = await import('child_process')
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'usage-report.mjs'), '--dir', usageDir, '--json'], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  const rep = JSON.parse(out)
  const repTag = rep.byType['ingest-tag']
  console.log(`    对账脚本 · 入库打标：${JSON.stringify(repTag)}`)
  check('③ 两处一致 · token', repTag && repTag.input + repTag.cacheRead + repTag.cacheWrite + repTag.output === row?.tokens,
    `脚本 ${repTag ? repTag.input + repTag.cacheRead + repTag.cacheWrite + repTag.output : '无'} vs 用量页 ${row?.tokens}`)
  check('③ 两处一致 · 次数', repTag?.calls === row?.count, `脚本 ${repTag?.calls} vs 用量页 ${row?.count}`)

  /**
   * **拆分也要对，不能只对总量**（2026-09-04 第一轮真跑就栽在这儿）。
   * DeepSeek 把缓存命中报了两个别名，求和会把整段 prompt 都判成缓存：
   * 总量守恒 → 上面那条 token 断言照样绿，而缓存读按 1/30 计价，花费低估 10%。
   * 期望值从 ①（pipeline 流水）独立算出来，不问应用要。
   */
  const expHit = ckptUsage.prompt_cache_hit_tokens ?? 0
  const expInput = (ckptUsage.prompt_tokens ?? 0) - expHit
  check('拆分对得上 · 纯输入', repTag?.input === expInput, `流水推算 ${expInput} vs 脚本 ${repTag?.input}`)
  check('拆分对得上 · 缓存读', repTag?.cacheRead === expHit, `流水推算 ${expHit} vs 脚本 ${repTag?.cacheRead}`)
  check('拆分对得上 · 输出', repTag?.output === (ckptUsage.completion_tokens ?? 0), `流水 ${ckptUsage.completion_tokens} vs 脚本 ${repTag?.output}`)

  step('【6】截图：用量页（这一版脚注该说"已包含入库打标"）')
  await win.evaluate(() => window.api.settings.setShowCost(true))
  await win.click('aside button:has-text("设置")').catch(() => {})
  await win.waitForTimeout(800)
  await win.click('[data-testid="open-usage"]').catch(() => {})
  await win.waitForTimeout(1500)
  const scope = await win.locator('[data-testid="usage-scope-note"]').innerText().catch(() => '')
  check('脚注说"已包含入库打标"（unmetered=0 的那条分支）', /已包含入库打标/.test(scope), `「${scope}」`)
  await win.locator('[data-testid="usage-token-note"]').scrollIntoViewIfNeeded().catch(() => {})
  await win.screenshot({ path: join(shots, '47f-用量页-打标已计入.png') })
  console.log('  shot: 47f-用量页-打标已计入')

  step('【7】拿去 DeepSeek 后台人工核对的那三项')
  console.log(`    模型　　：${tagLlmRec?.resolved_model}`)
  console.log(`    时间窗　：${new Date(startedAt).toLocaleString('zh-CN')} → ${new Date(endedAt).toLocaleString('zh-CN')}`)
  console.log(`    token　 ：${JSON.stringify(ckptUsage)}`)
  console.log(`    估算花费：见 usage-report（本轮 ingest-tag ¥${repTag?.costCny?.toFixed?.(4) ?? '?'}）`)
  console.log('    ⚠️ 后台账单按天聚合，同一把 key 上还会混着别的调用——比的是"这几项在不在、量级对不对"')
} catch (e) {
  failed++
  console.log('\n❌ 对账中断：', e?.message ?? e)
  await win.screenshot({ path: join(shots, 'ZZ-对账失败现场.png') }).catch(() => {})
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20000))])
}

console.log(failed ? `\n❌ ${failed} 条不通过\n` : '\n✅ 三方对账通过\n')
process.exit(failed ? 1 : 0)
