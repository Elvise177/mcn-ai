/**
 * 全新装机路径验收（发布前专项，2026-08-18 新增）
 *
 * 走的是**真实客户第一天**那条路，而且是主走查覆盖不到的那个次序：
 *   全新 userData 冷启动 → 登录 → 建库向导「新建模板库」→ 整包拖入 →
 *   入库全流程（六阶段）→ 实体建卡与双链 → 问答 → 生成产物 → 产物入库
 *
 * 与主走查的分工：主走查跑在**预先铺好的库**上，验的是各个交互；
 * 这条验的是**从零到有的次序本身**。A-3 那个「双链 352 → 2」的 bug 就长在这条路上
 * （模板新建的库里没有实体清单目录，07 建链无从下手）——所以这里必须用
 * **模板新建库**而不是指向已有库，否则等于没验。
 *
 * 顺带在这条路上复验 A-8 边界：样本里刻意放了两份人事文件，
 * 断言它们**入库了但没上云**。
 *
 * 真实调用：入库打标 + 一轮问答 + 一次产物生成，实测约 ¥0.5。
 * 跑法：node e2e/fresh-install.mjs
 */
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shots = join(root, 'e2e', 'shots')
mkdirSync(shots, { recursive: true })

const USERDATA = '/tmp/mcnai-fresh-install'
const VAULT = '/tmp/mcnai-fresh-vault'
const PACK = '/tmp/mcnai-fresh-pack'
const SRC = join(homedir(), 'Documents', 'AI', 'maggie-personal-data')

/**
 * 样本包：**保留两级子目录**（pipeline 用 `rel.parts[0]/[1]` 推 category/sub_category，
 * 拍平就是全部「未分类」），混合四种格式，并刻意含两份人事文件验 A-8。
 */
const SAMPLE = [
  '工作-执行类/工作-个人IP类/个人工作经历摘要.docx',
  '工作-执行类/工作-课程教学类/培训方案与复盘类/课程开发-2026.xlsx',
  '工作-执行类/工作-课程教学类/课程教学内容类/星母培训计划/课程作业修改/作业评改灰太太.docx',
  '工作-执行类/工作-课程教学类/课程教学内容类/星母培训计划/课程稿件/星母计划_小飞蛾_v4.pptx',
  '工作-管理类/人力资源类/内容剪辑人才画像.xlsx',
  '工作-管理类/人力资源类/OMG-2025年度人才盘点总表.xlsx',
]

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(ok ? `  ✓ ${name}` : `  ❌ ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const t0 = Date.now()
const step = (m) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)

// —— 备料：干净 userData / 空库目录 / 样本包 ——
for (const d of [USERDATA, VAULT, PACK]) rmSync(d, { recursive: true, force: true })
mkdirSync(PACK, { recursive: true })
let packed = 0
for (const rel of SAMPLE) {
  const from = join(SRC, rel)
  if (!existsSync(from)) { console.log(`⚠️  样本缺失，跳过：${rel}`); continue }
  const to = join(PACK, rel)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to)
  packed++
}
if (packed < 4) { console.log(`❌ 样本包只凑到 ${packed} 个文件，源数据不全，中止`); process.exit(1) }
// 再塞一个**必然转换失败**的文件：扩展名认得（会被收进投递箱、02 会真去转它），
// 内容是垃圾字节 → 转换必失败。验 A-4：失败在界面上说不说、原件进不进 `.failed/`。
// 不用不支持的扩展名，那条走的是 enqueue 的跳过分支，压根到不了 pipeline。
writeFileSync(join(PACK, '工作-执行类', '工作-个人IP类', '损坏样本.docx'), Buffer.from('这不是一个真的 docx，转换必失败'))
packed += 1
console.log(`样本包备好：${packed} 个文件（含 2 份人事文件验 A-8、1 个损坏文件验 A-4）`)

const app = await electron.launch({
  executablePath: process.env.MCNAI_APP_BIN || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  args: process.env.MCNAI_APP_BIN ? [] : [root],
  // 只给 userData：vault 要走**建库向导**真建出来，不能用 MCNAI_VAULT 抄近路
  env: { ...process.env, MCNAI_USER_DATA: USERDATA, MCNAI_E2E_NEW_VAULT: VAULT },
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 920 })
const snap = async (n) => { await win.screenshot({ path: join(shots, `${n}.png`) }); console.log(`  shot: ${n}`) }

try {
  step('【1】冷启动：全新机器落在登录门')
  await win.waitForSelector('input[placeholder="邮箱"]', { timeout: 20000 })
  const s0 = await win.evaluate(() => window.api.settings.get())
  check('全新环境无任何 key', !s0.hasApiKey && !s0.hasLlmKey)
  check('全新环境无库路径', !s0.vaultPath, String(s0.vaultPath))
  await snap('60-新装-登录门')

  step('【2】登录 → key 自动下发')
  await win.fill('input[placeholder="邮箱"]', 'mcnai-test-a@example.com')
  await win.fill('input[placeholder="密码"]', 'McnAi-Test-2026!')
  await win.click('button:has-text("登录")')
  // 真·全新机器登录完落的是**建库引导**，不是对话页——那台机器还没有库，
  // 侧栏的「新对话」按钮此时根本不存在。等错东西会白等 90 秒（第一版就是这么红的）。
  await win.waitForSelector('[data-testid="wizard-create"]', { timeout: 90000 })
  let s = {}
  for (let i = 0; i < 60; i++) {
    s = await win.evaluate(() => window.api.settings.get())
    if (s.hasApiKey && s.hasLlmKey) break
    await win.waitForTimeout(1000)
  }
  check('中转站 key 已下发', !!s.hasApiKey)
  check('打标 key 已下发', !!s.hasLlmKey)
  {
    // 契约 v2：两档线路随登录下发，客户端不持写死地址
    const t = (await win.evaluate(() => window.api.ai.tiers())).tiers
    const std = t.find((x) => x.id === 'standard')
    const enh = t.find((x) => x.id === 'enhanced')
    check('标准档已下发且为官方直连', !!std?.configured && std.provisioned && std.baseUrl.startsWith('https://api.deepseek.com'), JSON.stringify(std))
    check('增强档已下发且为中转站 inferera', !!enh?.configured && enh.provisioned && enh.baseUrl.startsWith('https://api.inferera.com'), JSON.stringify(enh))
  }
  await snap('60b-新装-登录后')

  step('【3】建库向导：新建模板库（A-3 那个 bug 就长在这条路上）')
  await win.waitForTimeout(1200)
  await snap('61-新装-建库向导两分支')
  // 走 UI 上那颗「新建库」卡片；落点由 MCNAI_E2E_NEW_VAULT 决定
  // （系统保存框 Playwright 驱动不了，见 ipc.ts 里那条注释）
  await win.click('[data-testid="wizard-create"]')
  for (let i = 0; i < 60; i++) {
    if ((await win.evaluate(() => window.api.settings.get())).vaultPath) break
    await win.waitForTimeout(1000)
  }
  await win.waitForTimeout(2000)
  s = await win.evaluate(() => window.api.settings.get())
  check('模板库建成并被打开', !!s.vaultPath, JSON.stringify({ vaultPath: s.vaultPath }))
  const layoutPath = join(s.vaultPath ?? VAULT, '.mcnai', 'layout.json')
  check('layout.json 写下来了', existsSync(layoutPath))
  const layout = existsSync(layoutPath) ? JSON.parse(readFileSync(layoutPath, 'utf-8')) : {}
  check('layout 里有 entities 段（07 建链要用）', !!layout.entities, JSON.stringify(Object.keys(layout)))
  await snap('61b-新装-模板库已建')

  step('【4】整包拖入 → 入库全流程')
  const enq = await win.evaluate((p) => window.api.inbox.enqueue([p]), PACK)
  check(`整包递归收全（期望 ${packed}）`, enq.added === packed, JSON.stringify(enq))
  // 等 pipeline 跑完（3 秒去抖 + 六阶段；小样本实测几分钟）
  let task = null
  for (let i = 0; i < 900; i++) {
    const list = await win.evaluate(() => window.api.tasks.list())
    task = (list.tasks ?? list).find((t) => t.kind === 'inbox')
    if (task && (task.status === 'succeeded' || task.status === 'failed')) break
    if (i % 30 === 0) console.log(`    …${task?.status ?? '等待'} ${task?.progress?.done ?? 0}/${task?.progress?.total ?? 6} ${task?.progress?.label ?? ''}`)
    await win.waitForTimeout(1000)
  }
  check('入库跑完且成功', task?.status === 'succeeded', JSON.stringify({ status: task?.status, error: task?.error }))
  // 截图前先切回知识库页：`inbox.enqueue` 是直接调 IPC 的，界面停在哪儿就是哪儿，
  // 不切的话这张「入库完成」拍出来是对话首页，等于什么都没证明
  await win.click('aside button:has-text("知识库")').catch(() => {})
  await win.waitForTimeout(2500)
  await snap('62-新装-入库完成')

  step('【5】落位 / 实体卡 / 双链（A-3 在模板新建库上的真实表现）')
  const vroot = s.vaultPath ?? VAULT
  const allMd = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allMd(join(d, e.name)) : e.name.endsWith('.md') ? [join(d, e.name)] : [])
  /**
   * **轮询，不要采样一次**（2026-08-19 踩到）。
   *
   * 建卡器（`vault/entity-cards.ts`）跑在 pipeline 之后，"入库跑完"那一刻卡片
   * 不一定已经落盘。这里原本是直接 `allMd(vroot)` 采样一次，于是同一份代码
   * 两轮分别数到 **1 张卡**和 **0 张卡**——数字在变本身就说明采样早了。
   * （那一轮的现场：断言时 10 篇 md / 0 张卡，跑完去看磁盘是 13 篇 md / **3 张卡**，
   *   卡片名都对：灰太太 / pink bear丰唇蜜 / 罗小曼卧蚕盘。产品是好的，断言太急。）
   * 同走查里那条既有约定：「凡是断言 Dock 的地方都必须轮询而不是采样一次」。
   */
  let mds = allMd(vroot)
  for (let i = 0; i < 30 && mds.filter((f) => f.includes('/30_实体/')).length === 0; i++) {
    await win.waitForTimeout(2000)
    mds = allMd(vroot)
  }
  // A-3 的哨兵**必须排掉 MOC/主题索引**：那两篇天生就是一堆双链，
  // 而 A-3 报的「双链 352 → 2」里的那个 2 恰恰就是它们——把 MOC 算进来这条断言永远绿
  const isMoc = (f) => /(_MOC|_主题索引|Library_MOC)/.test(f)
  const links = mds.filter((f) => !isMoc(f))
    .reduce((n, f) => n + (readFileSync(f, 'utf-8').match(/\[\[/g)?.length ?? 0), 0)
  const cards = mds.filter((f) => f.includes('/30_实体/'))
  const uncategorized = mds.filter((f) => f.includes('未分类'))
  check(`产出笔记 ${mds.length} 篇（>0）`, mds.length > 0)
  check(`正文双链不是 0（A-3 回归哨兵，已排除 MOC，实得 ${links}）`, links > 0)
  check(`实体卡建起来了（实得 ${cards.length}）`, cards.length > 0)
  check('相对子路径没被拍平（无「未分类」）', uncategorized.length === 0, `实得 ${uncategorized.length} 篇`)

  step('【6】A-8 边界：人事文件入库但不上云')
  const sensOnDisk = mds.filter((f) => {
    const t = readFileSync(f, 'utf-8')
    return t.startsWith('---') && /^sensitive:\s*true\s*$/m.test(t.slice(0, t.indexOf('\n---', 3)))
  })
  const cloudStage = (task?.stages ?? []).filter((e) => e.stage === 'cloud_sync').map((e) => e.message).join(' | ')
  check(`盘上有敏感篇（实得 ${sensOnDisk.length}）`, sensOnDisk.length > 0)
  check('上云阶段报出了「仅存本地」的拦截数', /仅存本地|不上云|敏感/.test(cloudStage), `实得「${cloudStage}」`)
  // 文案是「已完成 N 篇，其中 M 篇为敏感文件，按设置仅存本地」——**要抓的是 M 不是 N**。
  // 第一版写成 `(\d+)\s*篇[^|]*仅存本地`，从最左的「N 篇」就开始匹配，抓到的是已上云那个数
  // （实测报成 8 vs 3，看着像产品漏拦，其实是断言自己看错了列）
  const heldNum = Number((cloudStage.match(/其中\s*(\d+)\s*篇为敏感文件/) ?? [])[1] ?? NaN)
  if (!Number.isNaN(heldNum)) check(`拦截数与盘上敏感篇数一致（${heldNum} vs ${sensOnDisk.length}）`, heldNum === sensOnDisk.length)

  step('【6b】A-4 边界：转换失败要说出来，原件进 .failed/ 不静默丢件')
  // 投递箱目录名由 layout.json 决定，别写死：找库根下第一个含 `.failed` 的子目录
  const inboxDir = readdirSync(vroot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(vroot, e.name))
    .find((d) => existsSync(join(d, '.failed')))
  // `.failed/` 底下还按日期分了一层子目录（实测 `.failed/20260819/损坏样本.docx`），要递归
  const walkAll = (d) => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walkAll(join(d, e.name)) : [e.name]))
  const failedDir = inboxDir ? join(inboxDir, '.failed') : ''
  const failedFiles = failedDir && existsSync(failedDir) ? walkAll(failedDir) : []
  const convStage = (task?.stages ?? []).filter((e) => e.stage === 'convert' || e.failed)
  check('损坏文件进了 .failed/（没被静默吞掉）',
    failedFiles.some((f) => f.includes('损坏样本')), `.failed/ 实得 ${JSON.stringify(failedFiles)}`)
  check('界面上报出了失败计数（A-4：不许全绿）',
    convStage.some((e) => (e.failed ?? 0) > 0 || /失败/.test(e.message ?? '')),
    JSON.stringify(convStage.map((e) => ({ stage: e.stage, failed: e.failed, message: e.message }))))

  step('【7】问答（真实调用）')
  await win.click('button[title="新对话"]')
  await win.waitForTimeout(800)
  /** 等这一轮答完：以 chat.list() 里 assistant 条数为准（比数 DOM 稳），且流式已收尾 */
  // 基线取**全部会话的 assistant 总数**，不是 `cs[0]` 的：点完「新对话」那条会话
  // 还没落盘，`chat.list()[0]` 仍是上一条（按 updatedAt 倒序），拿它当基线会数错一位。
  const totalAssistant = (cs) => cs.reduce((n, c) => n + (c.messages ?? []).filter((m) => m.role === 'assistant').length, 0)
  const ask = async (text, budgetS) => {
    const base = totalAssistant(await win.evaluate(() => window.api.chat.list()))
    const ta = win.locator('textarea').first()
    await ta.fill(text)
    await ta.press('Enter')
    for (let i = 0; i < budgetS; i++) {
      const cs = await win.evaluate(() => window.api.chat.list())
      const streaming = await win.evaluate(() => !!document.querySelector('.streaming-body'))
      if (totalAssistant(cs) > base && !streaming) {
        const msgs = cs[0]?.messages ?? []
        return msgs[msgs.length - 1]
      }
      await win.waitForTimeout(1000)
    }
    return null
  }
  const a1 = await ask('库里关于灰太太的作业评改讲了什么？用两句话说。', 300)
  check('问答拿到回答', !!a1 && !a1.error, JSON.stringify(a1 && { error: a1.error, head: (a1.text ?? '').slice(0, 60) }))
  await snap('63-新装-问答')

  step('【8】生成产物 → 产物入库')
  await ask('把刚才那两句话做成一份 Word 文档，文件名叫「新装验收」。', 420)
  let artifact = null
  for (let i = 0; i < 120; i++) {
    const arts = await win.evaluate(() => window.api.artifacts.list())
    if (arts.length) { artifact = arts.sort((x, y) => y.mtimeMs - x.mtimeMs)[0]; break }
    await win.waitForTimeout(1000)
  }
  check('产物生成了', !!artifact, JSON.stringify(artifact))
  await snap('64-新装-产物面板')
  if (artifact) {
    await win.evaluate((p) => window.api.artifacts.ingest(p), artifact.path)
    let ingested = false
    for (let i = 0; i < 600; i++) {
      const list = await win.evaluate(() => window.api.tasks.list())
      const t = (list.tasks ?? list).find((x) => x.kind === 'ingest')
      if (t && (t.status === 'succeeded' || t.status === 'failed')) { ingested = t.status === 'succeeded'; break }
      await win.waitForTimeout(1000)
    }
    check('产物入库成功', ingested)
    await snap('64b-新装-产物已入库')
  }
} catch (e) {
  console.log('❌ 全新装机路径异常：', e)
  await win.screenshot({ path: join(shots, 'FAIL-新装路径.png') }).catch(() => {})
  failed++
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20000))])
}

console.log(failed ? `\n❌ 全新装机 ${failed} 条不通过\n` : '\n✅ 全新装机路径验收通过\n')
process.exit(failed ? 1 : 0)
