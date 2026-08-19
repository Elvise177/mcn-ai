/**
 * GUI 验收走查：Playwright 驱动真实 Electron 应用，逐步截图。
 * 运行: node e2e/walkthrough.mjs   截图落在 e2e/shots/（AI 与人都用截图做验收）
 * 每个里程碑交付前必须跑一遍并人工/AI 检视截图——「构建通过」不等于「功能可用」。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, copyFileSync, existsSync, rmSync, cpSync, writeFileSync, readdirSync, readFileSync, chmodSync } from 'fs'
import { execSync } from 'child_process'
import { createServer } from 'net'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shots = join(root, 'e2e', 'shots')
mkdirSync(shots, { recursive: true })

// 本次运行写出的截图；收尾时拿它和 shots/ 里的实际文件比对，
// 没被刷新的（= 旧版本残留）一律列出来报警，防止基线里混代
const written = new Set()
const record = (name) => written.add(name + '.png')

// 每次重置隔离环境：userData 清空（保证登录门可见），vault 副本重拷（保证确定性）
const userData = '/tmp/mcnai-e2e-userdata'
rmSync(userData, { recursive: true, force: true })
const vaultCopy = process.env.E2E_VAULT || '/tmp/mcnai-e2e-vault'
if (!process.env.E2E_VAULT) {
  const src = join(homedir(), 'Documents', 'AI', 'maggie-vault')
  if (existsSync(src)) {
    rmSync(vaultCopy, { recursive: true, force: true })
    cpSync(src, vaultCopy, { recursive: true })
    /**
     * **给旧 checkpoint 补上当前 schema_rev**（2026-08-18 加，A-3 逼出来的）。
     *
     * `03_tag_llm` 的断点续跑从「只看 path」改成了「看 (path, rev)」——没有 rev 的旧记录
     * 一律判为过期、重新打标。那是**给真实用户设计的**（改了打标产出结构就该重跑一次），
     * 但走查库是 maggie-vault 的副本，它带着一份 119 条的旧格式 checkpoint，
     * 于是**每跑一轮走查都要重新打标约 100 篇**：慢到阶段卡在 tag_llm 好几分钟、
     * 每轮真烧钱、而且这笔钱在用量页上还看不见（§3-8 pipeline 打标不入账）。
     *
     * 这些笔记本来就打过标、内容一个字没变，测试夹具没必要每轮重烧一遍。
     * 补 rev 只影响走查副本，真实用户那次一次性重打标照常发生。
     */
    for (const lib of ['80_Library', '80_资料库']) {
      const ck = join(vaultCopy, lib, '.checkpoint.jsonl')
      if (!existsSync(ck)) continue
      const REV = 1 // 与 pkb-pipeline 的 03_tag_llm.SCHEMA_REV 对齐；那边 +1 时这里跟着改
      const lines = readFileSync(ck, 'utf-8').split('\n').filter(Boolean)
      let patched = 0
      const out = lines.map((l) => {
        try {
          const rec = JSON.parse(l)
          if (rec.guard || rec.rev !== undefined) return l
          patched++
          return JSON.stringify({ ...rec, rev: REV })
        } catch {
          return l
        }
      })
      writeFileSync(ck, out.join('\n') + '\n')
      if (patched) console.log(`走查库 ${lib}/.checkpoint.jsonl 补 rev：${patched}/${lines.length} 条（省掉一轮重打标）`)
    }
  }
}

// 产物卡片（文件类型图标/hover 操作）与首页「最近产物」卡片区需要真实产物：
// 往库副本的 90_产物 里塞几个不同类型的样例，保证每次走查的卡片内容确定
const artifactDir = join(vaultCopy, '90_产物')
// 只往自己拷出来的副本里塞样例；E2E_VAULT 指向真实库时不动人家的数据
for (const [name, body] of process.env.E2E_VAULT ? [] : (mkdirSync(artifactDir, { recursive: true }), [
  ['e2e课件.pptx', 'x'.repeat(9000)],
  ['e2e周报.docx', 'x'.repeat(5000)],
  ['e2e数据表.xlsx', 'x'.repeat(3000)],
  ['e2e方案.pdf', 'x'.repeat(7000)],
  ['e2e说明.md', '# e2e 说明\n\n这是走查用的产物预览内容。\n'],
])) {
  writeFileSync(join(artifactDir, name), body)
}

// 产物入库三态（未入库→入库中→已入库）要一个 pipeline 真能转换的产物：
// 上面那几个是 'x'.repeat() 造的假文件，转换阶段必然失败，测不到「已入库」
if (!process.env.E2E_VAULT && existsSync(join(root, 'e2e', 'sample.docx'))) {
  copyFileSync(join(root, 'e2e', 'sample.docx'), join(artifactDir, 'e2e产物样例.docx'))
}

/**
 * 启动前护栏：**别的 mcn-ai 实例正盯着同一个库**时直接拒跑。
 *
 * 踩过一次：开发时用 `npm run dev` 起了一个实例，而它的 vaultPath 恰好也是这个走查库，
 * 于是两边的投递箱 watcher 抢着起 pipeline。表现是走查跑到最后一条（before-quit 孤儿检查）
 * 才失败，报的却是"有孤儿进程"——而那个进程属于另一个实例、本来就该活着。
 * 排查成本极高（12 分钟才撞到，且结论完全指错方向），所以在第一秒就喊停。
 */
{
  const foreign = execSync('ps -eo pid=,command=')
    .toString()
    .split('\n')
    .filter((l) => /electron|mcn-ai/i.test(l) && /mcn-ai\/desktop|mcn-ingest/.test(l))
    .filter((l) => !/walkthrough\.mjs|electron-vite|Cursor|Claude/.test(l))
  const onThisVault = execSync('ps -eo pid=,command=')
    .toString()
    .split('\n')
    .filter((l) => /mcn-ingest/.test(l) && l.includes(vaultCopy))
  if (onThisVault.length) {
    console.error(
      `\n❌ 有别的实例正在处理这个走查库（${vaultCopy}），先把它关掉再跑：\n` +
        onThisVault.map((l) => '   ' + l.trim().slice(0, 160)).join('\n') +
        '\n（多半是 `npm run dev` 起的实例，它的 vaultPath 也指到了这个库）\n'
    )
    process.exit(1)
  }
  if (foreign.length) console.log(`ℹ️  另有 ${foreign.length} 个 mcn-ai 相关进程在跑，若走查异常先确认它们没盯着同一个库`)
}

// MCNAI_APP_BIN 指向打包后的二进制时 = 打包形态回归；否则 dev 形态
const packagedBin = process.env.MCNAI_APP_BIN

const launch = (env) =>
  electron.launch({
    executablePath:
      packagedBin || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    args: packagedBin ? [] : [root],
    env,
  })

/**
 * 线路纪律闸门（2026-08-18 起，永久断言）。
 *
 * **背景**：`migrateTiers()` 判「这台机器以前用过」的依据是「配过库、或任意一把 key 落过盘」。
 * 走查/测试的隔离实例如果预置了 key 却没预置档位映射，就会被判成**老用户**，
 * 把标准档原样搬成 `describeProvider()` 的历史线路 —— **中转站**。
 * 实测代价：20 轮本该走 DeepSeek 官方直连的测试调用全打在中转站余额上，把它打穿，
 * 而那把 key 与网页版共用，连带影响线上。
 *
 * **纪律**：DeepSeek（v4-pro/v4-flash）一律官方直连 `api.deepseek.com`；
 * aihubmix 只给增强档 `claude-opus-5` 用。任何测试实例起来后标准档不是官方直连即判失败。
 *
 * 这个坑不允许出现第三次——所以断言放在**任何真实调用之前**，早失败早停。
 *
 * **唯一豁免**：下面「老用户升级机」那个独立实例（45e）是**故意**走老用户分支的，
 * 它的标准档就该是中转站，别给它加这条断言。
 */
const OFFICIAL_DEEPSEEK = 'https://api.deepseek.com'
const assertStandardRoute = async (win, label = '') => {
  const t = await win.evaluate(() => window.api.ai.tiers())
  const std = t.tiers.find((x) => x.id === 'standard')
  if (!std) throw new Error(`线路纪律：ai.tiers() 里没有标准档${label ? `（${label}）` : ''}`)
  if (!std.baseUrl.startsWith(OFFICIAL_DEEPSEEK)) {
    throw new Error(
      `线路纪律违规${label ? `（${label}）` : ''}：标准档 baseUrl=${std.baseUrl}，` +
        `必须是 ${OFFICIAL_DEEPSEEK}。多半是 migrateTiers 把这台实例判成了老用户——` +
        `隔离实例的 config 必须显式写 tierMigrated:true + 出厂档位映射。`
    )
  }
  console.log(`线路纪律 ✓ 标准档 ${std.baseUrl} / ${std.model}${label ? `（${label}）` : ''}`)
  return std
}

/**
 * 走查窗口统一初始化：固定视口 + 关掉过渡动画。
 * 动画不关的话截图容易糊在淡入中间帧（整页发灰发虚，看着像对比度坏了），
 * 这里用 CDP 模拟 prefers-reduced-motion:reduce，样式表里已有对应的 @media 兜底。
 */
const prepWindow = async (app, win) => {
  await win.setViewportSize({ width: 1440, height: 920 })
  const cdp = await app.context().newCDPSession(win)
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  return cdp
}

/**
 * 进程组残留检查（设计 §5.1 / §8 风险 1）。
 *
 * `child.kill()` 只杀直接子进程：spawn 起的是 PyInstaller onedir 的引导程序，真正干活的
 * Python 是它 fork 出来的孙子进程。取消/退出之后那一整组必须一个都不剩，否则 UI 显示"已停止"
 * 而后台还在写 vault、烧 LLM 额度。**这条断言必须在打包形态（MCNAI_APP_BIN）下跑一次**——
 * 打包后路径与权限都不一样，dev 形态验过不算数。
 */
const pipelineLeftovers = (pgid) =>
  execSync('ps -eo pgid=,pid=,command=')
    .toString()
    .split('\n')
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    // ① 目标进程组里的任何进程；② 任何还挂在本次走查这个库上的 mcn-ingest
    .filter(([, g, , cmd]) => (pgid && Number(g) === Number(pgid)) || (/mcn-ingest/.test(cmd) && cmd.includes(vaultCopy)))
    .map(([, g, p, cmd]) => `pgid=${g} pid=${p} ${cmd.slice(0, 140)}`)

/** 等到 pipeline 真的 spawn 起来（任务对象上有 pid 才说明进程组存在） */
const waitForPipelinePid = async (page, timeoutMs = 90000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const pid = await page.evaluate(async () => {
      const s = await window.api.tasks.list()
      const t = s.tasks.find((x) => x.kind === 'inbox' && (x.status === 'running' || x.status === 'queued'))
      return t?.pid ?? null
    })
    if (pid) return pid
    await page.waitForTimeout(120)
  }
  return null
}

/**
 * 等投递箱彻底闲下来。取消断言必须从"没有任何在跑的轮次"开始，
 * 否则 waitForPipelinePid 抓到的是上一轮**马上就要结束**的 pid，
 * 点下去按钮已经变回「立即处理」了（实测踩过）。
 * 空闲要连续 4.5 秒才算数——两轮之间有 3 秒去抖窗口。
 */
/**
 * 等投递箱彻底闲下来（连续 4.5 秒无活跃任务，跨过 3 秒去抖窗口）。
 *
 * **上限 5 分钟 → 10 分钟**（2026-08-18，A-3 之后）：实体建卡会改写上百篇笔记的
 * `## 🔗 关联` 段，这些笔记的 mtime 随之变化，于是 `cloudSync` 的"本轮变更"集合
 * 从几篇涨到上百篇（实测这一轮 **上云·20/125篇**），一轮跑完要好几分钟。
 * 这是**实体首次铺开的一次性代价**，不是每轮都有：链接内容没变就不落盘，
 * 下一轮触及的笔记数会掉回个位数。
 */
const waitInboxIdle = async (page, timeoutMs = 600000) => {
  const t0 = Date.now()
  let quietSince = 0
  while (Date.now() - t0 < timeoutMs) {
    const busy = await page.evaluate(async () => {
      const s = await window.api.tasks.list()
      return s.tasks.some((t) => t.kind === 'inbox' && (t.status === 'queued' || t.status === 'running'))
    })
    if (busy) quietSince = 0
    else if (!quietSince) quietSince = Date.now()
    else if (Date.now() - quietSince > 4500) return true
    await page.waitForTimeout(400)
  }
  return false
}

/** 原始 CDP 抓屏：Playwright 的 page.screenshot() 会清掉 :hover，hover 态只能这样截 */
const rawShot = async (cdp, name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name + '.png'), Buffer.from(data, 'base64'))
  record(name)
  console.log('shot(hover):', name)
}

// ---- 首跑引导环节：全新 userData 且不给库 → 登录门 → 建库引导 → 跳过 → 对话页 ----
{
  rmSync('/tmp/mcnai-e2e-firstrun', { recursive: true, force: true })
  const env2 = { ...process.env, MCNAI_USER_DATA: '/tmp/mcnai-e2e-firstrun' }
  delete env2.MCNAI_VAULT
  const app2 = await launch(env2)
  const w2 = await app2.firstWindow()
  const cdp2 = await prepWindow(app2, w2)
  await w2.waitForTimeout(1500)
  await w2.click('text=暂不登录')
  await w2.locator('text=建立你的知识库').waitFor({ timeout: 5000 })
  await w2.waitForTimeout(600) // 动画已关，这点等待只为布局稳定
  await w2.screenshot({ path: join(shots, '00c-首跑-建库引导.png') })
  record('00c-首跑-建库引导')
  console.log('shot: 00c-首跑-建库引导')
  // 两张卡片静态同款、hover 才高亮：hover 态要用 CDP 抓
  await w2.locator('button:has-text("新建库")').hover()
  await w2.waitForTimeout(200)
  const wizardHover = await w2.locator('button:has-text("新建库")').evaluate(
    (el) => getComputedStyle(el).borderColor
  )
  const wizardIdle = await w2.locator('button:has-text("使用已有库")').evaluate(
    (el) => getComputedStyle(el).borderColor
  )
  if (wizardHover === wizardIdle) throw new Error(`建库卡片 hover 没有反馈：${wizardHover}`)
  await rawShot(cdp2, '00c2-建库引导-卡片hover')
  console.log('建库卡片 hover ✓', JSON.stringify({ hover: wizardHover, idle: wizardIdle }))
  await w2.click('text=暂时跳过')
  await w2.locator('text=问你的库，或直接说要做什么').waitFor({ timeout: 5000 })
  await w2.screenshot({ path: join(shots, '00d-首跑-跳过后落对话页.png') })
  record('00d-首跑-跳过后落对话页')
  console.log('shot: 00d-首跑-跳过后落对话页')
  await app2.close()
}

// ---- H-12 建库向导：创建失败/耗时长不再永久卡在灰掉的状态 ----
// 用 MCNAI_E2E_VAULT_FAIL 让 vault:createNew 先卡 1.2 秒再抛错（走查专用开关，见 ipc.ts 注释）：
// 系统保存框一弹起来 Playwright 就没法继续，只能这样验失败分支
{
  rmSync('/tmp/mcnai-e2e-wizardfail', { recursive: true, force: true })
  const envW = { ...process.env, MCNAI_USER_DATA: '/tmp/mcnai-e2e-wizardfail', MCNAI_E2E_VAULT_FAIL: '1200' }
  delete envW.MCNAI_VAULT
  const appW = await launch(envW)
  const wW = await appW.firstWindow()
  const cdpW = await prepWindow(appW, wW)
  await wW.waitForTimeout(1500)
  await wW.click('text=暂不登录')
  await wW.locator('text=建立你的知识库').waitFor({ timeout: 5000 })
  await wW.click('[data-testid="wizard-create"]')

  // ① busy 态要有文案与 spinner（旧版只是 opacity-60，被当成卡死而反复点）
  await wW.locator('[data-testid="wizard-create"]:has-text("正在创建/索引…")').waitFor({ timeout: 4000 })
  if (!(await wW.locator('[data-testid="wizard-create"] .animate-spin').count()))
    throw new Error('建库 busy 态没有 spinner')
  const busyDisabled = await wW.locator('[data-testid="wizard-existing"]').isDisabled()
  if (!busyDisabled) throw new Error('创建中另一张卡片没有禁用（会被重复点）')
  await rawShot(cdpW, '40-建库向导-创建中')

  // ② 失败要有可见报错，而且必须解锁回可点状态（H-12 的正主：以前 setBusy(false) 根本不会执行）
  await wW.locator('[data-testid="toast"]').waitFor({ timeout: 15000 })
  const wizToast = await wW.locator('[data-testid="toast"]').first().innerText()
  if (!/新建库失败/.test(wizToast)) throw new Error(`建库失败没有报错 toast：「${wizToast}」`)
  await wW.screenshot({ path: join(shots, '40b-建库向导-失败报错.png') })
  record('40b-建库向导-失败报错')
  for (const id of ['wizard-create', 'wizard-existing']) {
    if (await wW.locator(`[data-testid="${id}"]`).isDisabled())
      throw new Error(`建库失败后 ${id} 仍然是禁用的（向导永久卡死）`)
  }
  // 真点第二次：还能再发起（不是"只剩重启一条路"）
  await wW.click('[data-testid="wizard-create"]')
  await wW.locator('[data-testid="wizard-create"]:has-text("正在创建/索引…")').waitFor({ timeout: 4000 })
  console.log('H-12 建库向导 ✓', JSON.stringify({ toast: wizToast.trim(), 失败后可再点: true }))
  await appW.close()
}

// ---- 空库引导环节：指向一个全新的空库 → 知识库页中间区域应给"拖入第一份资料"引导 ----
{
  const emptyVault = '/tmp/mcnai-e2e-empty-vault'
  rmSync(emptyVault, { recursive: true, force: true })
  mkdirSync(emptyVault, { recursive: true })
  rmSync('/tmp/mcnai-e2e-emptyuser', { recursive: true, force: true })
  const app3 = await launch({
    ...process.env,
    MCNAI_USER_DATA: '/tmp/mcnai-e2e-emptyuser',
    MCNAI_VAULT: emptyVault,
  })
  const w3 = await app3.firstWindow()
  await prepWindow(app3, w3)
  await w3.waitForTimeout(1500)
  const skip3 = w3.locator('text=暂不登录')
  if (await skip3.count()) await skip3.click()

  /**
   * 空库时**工作台**这一屏也要给引导（R-3，2026-08-19 拍板的最小版）。
   * 这一条必须在切去知识库页**之前**验——新客户登录后落的就是工作台，
   * 在这一屏之前他根本走不到知识库页那个空态引导。
   * 断言到文案层：默认那句「问你的库」在空库上是句假承诺，不许出现。
   */
  await w3.waitForTimeout(1200)
  const sub = (await w3.locator('[data-testid="home-subtitle"]').innerText()).trim()
  if (sub !== '把资料拖进来，或直接问我')
    throw new Error(`空库时工作台副标题不对：「${sub}」（不许还说"问你的库"）`)
  const hint = w3.locator('[data-testid="home-empty-vault-hint"]')
  if (!(await hint.count())) throw new Error('空库时工作台没有引导文案')
  const hintText = (await hint.innerText()).replace(/\s+/g, ' ').trim()
  if (!/拖进|投递箱/.test(hintText)) throw new Error(`工作台空库引导没有指向：「${hintText}」`)
  // 同一屏上不许自相矛盾：副标题改了、输入框却还写着「问你的库」就是产品自己打自己
  const ph = await w3.locator('textarea').first().getAttribute('placeholder')
  if (/问你的库/.test(ph ?? '')) throw new Error(`空库时输入框还在说「问你的库」：「${ph}」`)
  // 不做浮层引导是拍板项——出现遮罩/气泡引导就是跑偏了
  const overlay = await w3.locator('[data-testid="onboarding-overlay"], .onboarding-tour').count()
  if (overlay) throw new Error('工作台出现了浮层引导（拍板只做一段文案+指向）')
  await w3.screenshot({ path: join(shots, '02a-工作台-空库引导.png') })
  record('02a-工作台-空库引导')
  console.log('shot: 02a-工作台-空库引导 ✓', JSON.stringify({ 副标题: sub, 指向: hintText }))

  await w3.click('text=个人知识库')
  await w3.locator('text=拖入你的第一份资料试试').waitFor({ timeout: 8000 })
  const guideBtn = await w3.locator('button:has-text("打开投递箱")').count()
  if (!guideBtn) throw new Error('空库引导缺少「打开投递箱」入口')
  await w3.waitForTimeout(600)
  await w3.screenshot({ path: join(shots, '02b-知识库-空库引导.png') })
  record('02b-知识库-空库引导')
  console.log('shot: 02b-知识库-空库引导（空态引导 + 投递箱入口 ✓）')
  // 引导按钮真点：应弹出投递箱面板
  await w3.click('button:has-text("打开投递箱")')
  await w3.waitForTimeout(500)
  const inboxOpened = await w3.locator('text=把文件拖进窗口').count()
  if (!inboxOpened) throw new Error('空库引导点「打开投递箱」后投递箱面板没出来')
  await w3.screenshot({ path: join(shots, '02c-空库引导-打开投递箱.png') })
  record('02c-空库引导-打开投递箱')
  console.log('shot: 02c-空库引导-打开投递箱')
  await app3.close()
}

// ---- 云端离线降级：把服务器地址指到一个连不上的端口，重启后应「照常开窗 + 顶部离线条」----
// （HANDOFF bug#1 的正确行为；这条只能靠独立实例验，主实例是在线的）
{
  const offlineUser = '/tmp/mcnai-e2e-offline'
  rmSync(offlineUser, { recursive: true, force: true })
  const envOff = { ...process.env, MCNAI_USER_DATA: offlineUser, MCNAI_VAULT: vaultCopy }

  // 第一次启动只为把服务器地址改成不可达的（127.0.0.1:9 = discard 端口，必然连不上）
  const a1 = await launch(envOff)
  const w1 = await a1.firstWindow()
  await w1.waitForTimeout(1500)
  await w1.evaluate(() => window.api.settings.setApiBase('http://127.0.0.1:9'))
  await a1.close()

  // 第二次启动：probeCloud 探测失败 → 窗口照常出现、本地功能可用、顶部挂离线条
  const a2 = await launch(envOff)
  const w2b = await a2.firstWindow()
  await prepWindow(a2, w2b)
  await w2b.waitForTimeout(2000)
  const skipOff = w2b.locator('text=暂不登录')
  if (await skipOff.count()) await skipOff.click()
  await w2b.locator('[data-testid="offline-bar"]').waitFor({ timeout: 20000 })
  const offText = await w2b.locator('[data-testid="offline-bar"]').innerText()
  if (!/云端离线/.test(offText)) throw new Error(`离线条文案不对：「${offText}」`)
  // 本地功能必须照常可用（这是 bug#1 的关键：不是"打不开"，是"云端那部分不可用"）
  await w2b.click('text=个人知识库')
  await w2b.waitForTimeout(2500)
  if (!(await w2b.locator('[data-testid="tree-col"]').count()))
    throw new Error('离线时知识库打不开了（bug#1 降级不成立）')
  await w2b.waitForTimeout(500)
  await w2b.screenshot({ path: join(shots, '33-云端离线-降级说明条.png') })
  record('33-云端离线-降级说明条')
  console.log('bug#1 离线降级 ✓', JSON.stringify(offText.replace(/\s+/g, ' ')))
  await a2.close()
}

// ---- M-01 登录超时 / 可取消 / 区分「网络不可达」和「密码错」----
{
  // (a) 连得上但永不回应：起一个只收不答的黑洞 socket。
  //     真正的坑就是这种——Supabase 被暂停时请求挂在那儿，按钮永远定格在「登录中…」。
  //     （直接指一个不可达 IP 不行：实测 fetch 9ms 就报 ENETUNREACH，压根走不到超时分支）
  const sockets = new Set()
  const blackhole = createServer((s) => {
    sockets.add(s)
    s.on('data', () => void 0) // 收下请求，什么都不回
    s.on('close', () => sockets.delete(s))
  })
  await new Promise((r) => blackhole.listen(0, '127.0.0.1', r))
  const holePort = blackhole.address().port

  const loginUser = '/tmp/mcnai-e2e-login-timeout'
  rmSync(loginUser, { recursive: true, force: true })
  const a3 = await launch({
    ...process.env,
    MCNAI_USER_DATA: loginUser,
    MCNAI_VAULT: vaultCopy,
    MCNAI_SUPABASE_URL: `http://127.0.0.1:${holePort}`,
  })
  const w = await a3.firstWindow()
  const cdp3 = await prepWindow(a3, w)
  await w.locator('input[placeholder="邮箱"]').waitFor({ timeout: 20000 })
  await w.fill('input[placeholder="邮箱"]', 'mcnai-test-a@example.com')
  await w.fill('input[placeholder="密码"]', 'McnAi-Test-2026!')

  // ① 可取消：挂住时必须有出口，不能永远定格在「登录中…」
  await w.click('button:has-text("登录")')
  await w.locator('[data-testid="login-cancel"]').waitFor({ timeout: 5000 })
  await rawShot(cdp3, '38-登录中-可取消')
  const tCancel = Date.now()
  await w.click('[data-testid="login-cancel"]')
  await w.locator('text=已取消登录').waitFor({ timeout: 8000 })
  if (await w.locator('[data-testid="login-cancel"]').count())
    throw new Error('点了取消，界面还停在「登录中…」')
  console.log(`M-01 取消登录 ✓ ${Date.now() - tCancel}ms 回到可操作`)

  // ② 10 秒超时：不能无限等，文案也不能说成"密码不对"
  const t0 = Date.now()
  await w.click('button:has-text("登录")')
  await w.locator('text=登录超时').waitFor({ timeout: 20000 })
  const took = Date.now() - t0
  const timeoutErr = await w.locator('.text-danger').first().innerText()
  if (took < 8000 || took > 15000) throw new Error(`登录超时不在 10s 量级：${took}ms`)
  if (/密码|凭据/.test(timeoutErr)) throw new Error(`超时却报成密码错：「${timeoutErr}」`)
  await w.waitForTimeout(300)
  await w.screenshot({ path: join(shots, '38b-登录-超时文案.png') })
  record('38b-登录-超时文案')
  console.log('M-01 超时 ✓', JSON.stringify({ 耗时ms: took, 文案: timeoutErr.trim() }))
  await a3.close()
  for (const s of sockets) s.destroy()
  blackhole.close()

  // (b) 连都连不上（端口 9 = discard，没人监听）：应立刻回「网络不可达」，
  //     绝不能说"邮箱或密码不对"——那会让用户一遍遍改密码，永远想不到去看网络
  const refuseUser = '/tmp/mcnai-e2e-login-refused'
  rmSync(refuseUser, { recursive: true, force: true })
  const a4 = await launch({
    ...process.env,
    MCNAI_USER_DATA: refuseUser,
    MCNAI_VAULT: vaultCopy,
    MCNAI_SUPABASE_URL: 'http://127.0.0.1:9',
  })
  const w4 = await a4.firstWindow()
  await prepWindow(a4, w4)
  await w4.locator('input[placeholder="邮箱"]').waitFor({ timeout: 20000 })
  await w4.fill('input[placeholder="邮箱"]', 'mcnai-test-a@example.com')
  await w4.fill('input[placeholder="密码"]', 'McnAi-Test-2026!')
  const raw = await w4.evaluate(() => window.api.auth.login('mcnai-test-a@example.com', 'McnAi-Test-2026!'))
  if (raw.kind !== 'network') throw new Error('云端不可达时的错误种类不是 network：' + JSON.stringify(raw))
  await w4.click('button:has-text("登录")')
  await w4.locator('text=连不上服务器').waitFor({ timeout: 20000 })
  const netErr = await w4.locator('.text-danger').first().innerText()
  if (/密码|凭据/.test(netErr)) throw new Error(`网络不通却报成密码错：「${netErr}」`)
  await w4.waitForTimeout(300)
  await w4.screenshot({ path: join(shots, '38c-登录-网络不可达文案.png') })
  record('38c-登录-网络不可达文案')
  console.log('M-01 错误分类 ✓', JSON.stringify({ kind: raw.kind, 文案: netErr.trim() }))
  await a4.close()
}

// ---- 会话级模型档位 · 不可用分支：增强档线路探测失败时必须置灰 + 说「暂时不可用」----
// 用独立实例把探测强制判死（MCNAI_E2E_TIER_HEALTH=down，走查专用开关，生产不读）：
// 真造这个分支得把 aihubmix 打挂或断网，走查里做不到（判据同 HANDOFF §4-22）。
// 主实例反过来强制为可用，那边验的是"能选、能记住、失败有出口"。
{
  const downUser = '/tmp/mcnai-e2e-tier-down'
  rmSync(downUser, { recursive: true, force: true })
  const aD = await launch({
    ...process.env,
    MCNAI_USER_DATA: downUser,
    MCNAI_VAULT: vaultCopy,
    MCNAI_E2E_TIER_HEALTH: 'down',
  })
  const wD = await aD.firstWindow()
  await prepWindow(aD, wD)
  const skipD = wD.locator('text=暂不登录')
  await skipD.waitFor({ timeout: 20000 })
  await skipD.click()
  await wD.locator('[data-testid="tier-selector"]').waitFor({ timeout: 20000 })
  await wD.click('[data-testid="tier-selector"]')
  await wD.locator('[data-testid="tier-menu"]').waitFor({ timeout: 8000 })
  const enh = wD.locator('[data-testid="tier-option-enhanced"]')
  if ((await enh.getAttribute('data-available')) !== '0') throw new Error('线路探测失败时增强档没有置灰')
  if (await enh.isEnabled()) throw new Error('置灰的档位还能点（disabled 没生效）')
  const menuTextD = await wD.locator('[data-testid="tier-menu"]').innerText()
  if (!menuTextD.includes('暂时不可用')) throw new Error(`置灰的档位没有「暂时不可用」说明：「${menuTextD}」`)
  await wD.waitForTimeout(300)
  await wD.screenshot({ path: join(shots, '45b-档位选择器-增强暂时不可用.png') })
  record('45b-档位选择器-增强暂时不可用')
  // 点它一下也不许切过去（disabled 之外再验一次结果状态）
  await enh.click({ force: true }).catch(() => {})
  await wD.waitForTimeout(300)
  const stillD = (await wD.locator('[data-testid="tier-selector"]').getAttribute('data-tier')) ?? ''
  if (stillD !== 'standard') throw new Error(`点了置灰的档位竟然切过去了：${stillD}`)
  console.log('档位置灰 ✓', JSON.stringify(menuTextD.replace(/\s+/g, ' ').slice(0, 60)))
  await aD.close()
}

// ---- 老用户升级机（大头那台的形态）：只有中转站 key，增强档必须靠**回落**可用 ----
// 实测依据：api.inferera.com 是 aihubmix 的备用域名，服务端下发的 CLIENT_RELAY_API_KEY
// 与网页版的 AIHUBMIX_API_KEY 是同一把，所以登录过的机器天然就能开增强档（见 ai/tiers.ts）。
// 这一屏同时把 migrateTiers 的老用户分支也验了——之前它只在真机上跑过。
{
  const legacyUser = '/tmp/mcnai-e2e-legacy'
  rmSync(legacyUser, { recursive: true, force: true })
  const envL = {
    ...process.env,
    MCNAI_USER_DATA: legacyUser,
    MCNAI_VAULT: vaultCopy,
    MCNAI_E2E_TIER_HEALTH: 'up',
  }

  // 第一次启动只为把 vaultPath 落进 store（= 这台机器"以前用过"的判据）
  const a1 = await launch(envL)
  const w1 = await a1.firstWindow()
  await w1.waitForTimeout(2500)
  await a1.close()

  // 抹掉迁移标记，模拟"这台机器是从旧版升上来的"：下次启动 migrateTiers 会走老用户分支
  const cfgPath = join(legacyUser, 'config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
  if (!cfg.vaultPath) throw new Error('第一次启动没把 vaultPath 落盘，老用户判据不成立')
  delete cfg.tierMigrated
  delete cfg.tierOverrides
  writeFileSync(cfgPath, JSON.stringify(cfg))

  const a2 = await launch(envL)
  const w2 = await a2.firstWindow()
  await prepWindow(a2, w2)
  const skipL = w2.locator('text=暂不登录')
  await skipL.waitFor({ timeout: 20000 })
  await skipL.click()
  await w2.locator('[data-testid="tier-selector"]').waitFor({ timeout: 20000 })

  // 迁移：标准档沿用旧线路（中转站），key 槽位也跟着搬过去
  const migrated = await w2.evaluate(() => window.api.ai.tiers())
  const std = migrated.tiers.find((t) => t.id === 'standard')
  if (std.keyField !== 'encryptedApiKey' || !std.baseUrl.includes('inferera'))
    throw new Error('老用户迁移没生效：' + JSON.stringify(std))

  // 这台机器只有中转站那把 key（模拟服务端下发过、但从没配过增强档的独立 key）
  await w2.evaluate((k) => window.api.settings.setKey(k, 'standard'), 'sk-e2e-legacy-relay-key-0123456789')
  // 这里是**直接调 IPC**、不走界面那颗保存按钮，所以不会有 toast——等 toast 会一直等到超时
  // （第一版就是这么挂住的）。落盘是后台任务，但明文立刻进内存缓存，hasKey 马上就该翻真
  let tiersNow = null
  let enh = null
  for (let i = 0; i < 40; i++) {
    tiersNow = await w2.evaluate(() => window.api.ai.tiers())
    enh = tiersNow.tiers.find((t) => t.id === 'enhanced')
    if (enh.hasKey) break
    await w2.waitForTimeout(500)
  }
  if (!enh.hasKey) throw new Error('只有 relay key 时增强档仍判为没有密钥（回落没生效）')
  if (!enh.usingSharedKey) throw new Error('增强档没有标出"复用中转站密钥"')

  // 选择器里增强档必须不再置灰
  await w2.click('[data-testid="tier-selector"]')
  await w2.locator('[data-testid="tier-menu"]').waitFor({ timeout: 8000 })
  if ((await w2.locator('[data-testid="tier-option-enhanced"]').getAttribute('data-available')) !== '1')
    throw new Error('回落生效后增强档还是置灰的')
  await w2.waitForTimeout(300)
  await w2.screenshot({ path: join(shots, '45e-老用户机-增强档回落可用.png') })
  record('45e-老用户机-增强档回落可用')
  await w2.keyboard.press('Escape')

  // 管理员区要把"复用"这件事标出来（钱从哪把 key 上扣的，必须查得到）
  await w2.click('text=设置')
  const badgeL = w2.locator('[data-testid="version-badge"]')
  await badgeL.waitFor({ timeout: 10000 })
  for (let i = 0; i < 7; i++) {
    await badgeL.click()
    await w2.waitForTimeout(60)
  }
  await w2.locator('[data-testid="tier-shared-key-enhanced"]').waitFor({ timeout: 8000 })

  // 回落**日志**必须落下来：发一条增强档的消息把 resolveTierForRequest 走一遍
  // （key 是假的，请求注定失败，但预检必须放行——放行本身就是回落生效的证据）
  await w2.evaluate(() => window.api.chat.send('e2e-fallback', '回落走查', undefined, 'enhanced'))
  let logText = ''
  for (let i = 0; i < 40 && !/回落到共享密钥/.test(logText); i++) {
    await w2.waitForTimeout(500)
    try {
      logText = readFileSync(join(legacyUser, 'logs', 'main.log'), 'utf-8')
    } catch {
      /* 还没写出来 */
    }
  }
  const fallbackLine = logText.split('\n').find((l) => l.includes('回落到共享密钥'))
  if (!fallbackLine) throw new Error('增强档回落没有打日志（静默兜底是明确禁止的）')
  if (!fallbackLine.includes('encryptedApiKey')) throw new Error(`回落日志没说清回落到哪把：${fallbackLine}`)
  console.log('增强档回落（老用户机）✓', JSON.stringify({ 迁移后标准档: std.keyField, 日志: fallbackLine.trim() }))
  await a2.close()
}

const app = await launch({
  ...process.env,
  MCNAI_USER_DATA: userData,
  MCNAI_VAULT: vaultCopy,
  // 主实例强制把增强档探测判为可用：这台机器上没有 aihubmix 的 key，不强制的话
  // 档位选择器永远只有一档可选，"按会话记忆"和"失败有出口"两条就没法走真实用户路径。
  // 注意 key 仍然是没有的 —— 增强档发出去照样会被主进程预检拦下，M-11 那段正好用它造确定失败
  MCNAI_E2E_TIER_HEALTH: 'up',
})
const win = await app.firstWindow()
const cdp = await prepWindow(app, win)
// 线路纪律：任何真实调用之前先验标准档是官方直连。走查的 userData 每次都是清空重建，
// migrateTiers 会走「全新安装」分支拿出厂映射——这条断言就是守住这个前提不被改坏
await assertStandardRoute(win, '走查主实例')

/**
 * B-1 检索回归（不烧 token，所以常驻走查）。
 *
 * 修前：索引侧 unigram+bigram、检索侧 AND，于是整句自然语言查询里那些**跨词边界的二元组**
 * （「公司年度目标」里的「司年」）在任何一篇笔记里都不存在 → 整条查询归零。
 * 实测 10 题问库里有 7 题因此答「库里没有」，而资料就在库里。
 *
 * **最后两条是防幻觉的地基，比前面几条更要紧**：库里确实没有「完美日记」这个品牌，
 * 检索就必须返回 0。中间某一版放宽成 OR 之后它漏了 12 条、置顶还正好是
 * 「向日花年框」「霞飞年框」——**张冠李戴的原料**。这条挂了就说明模糊那一遍又放太松了。
 */
{
  const CASES = [
    ['公司年度目标', '>0'],
    ['谁的绩效最好', '>0'],
    ['星母第二期', '>0'],
    ['2026年上半年收支', '>0'],
    ['公司今年的年度目标是什么，目前进展如何', '>0'],
    ['哪位达人最适合带霞飞的高光粉', '>0'],
    ['灰太太', '>0'], // 精确查询不许退化
    ['收支利润表', '>0'],
    ['完美日记', '=0'], // 库里没有这个品牌——**品牌名本身必须零命中**
  ]
  const bad = []

  /**
   * **第一版检索口径 = 本地**（2026-08-19 裁决）。
   * 出厂值必须是 `local`——云端那一支不给 file_path，模型只能猜路径（HANDOFF §3-13）。
   * 这条断言零成本，守的是"别有人顺手把默认值改回 cloud"。
   * **注意它验不到什么**：登录态下真的没走云端，靠的是 `agent/index.ts` 里那一道
   * `store.get('searchBackend') === 'cloud'` 闸门，本地模式走查跑不到登录态，**未经真实调用验证**。
   */
  {
    const backend = await win.evaluate(() => window.api.settings.get().then((s) => s.searchBackend ?? '(未暴露)'))
    if (backend !== 'local') bad.push(`检索口径出厂值应为 local，实得 ${backend}`)
  }

  /**
   * **索引就绪哨兵**（2026-08-19，Electron 30 → 43 升级时暴露）。
   *
   * `vaultManager.open()` 是先置 root、再 await 扫全库、最后才 rebuild 索引，
   * 中间那段「库已打开、索引还空着」的窗口里，查询会被 worker 秒回 0 条，
   * 界面照三态画成「没找到「X」」——产品在说谎。
   * Electron 30 上扫得快、走查从没撞上；43 上每轮必现（前 1~2 条查询归零）。
   *
   * 这一条**故意放在整个 B-1 的最前面、且不等任何东西**：它就是要打在那个窗口里。
   * 修法在 `vault/searcher.ts` 的就绪闸门（search 等索引建好），不是在走查里多睡两秒。
   */
  {
    const r = await win.evaluate(() => window.api.vault.search('灰太太'))
    if (!(r.total > 0)) bad.push(`索引就绪哨兵：开库后立刻检索「灰太太」回了 ${r.total} 条（就绪闸门失效）`)
  }

  for (const [q, expect] of CASES) {
    const r = await win.evaluate((x) => window.api.vault.search(x), q)
    const ok = expect === '>0' ? r.total > 0 : r.total === 0
    if (!ok) bad.push(`「${q}」期望 ${expect}，实际 total=${r.total}${r.fuzzy ? '（模糊）' : ''}`)
  }

  /**
   * 整句陷阱题的判据**不是「零命中」**——那是第一版写错的。
   * 「我们和完美日记的合作条款是什么」里除了不存在的品牌名，还含着库里真实存在的
   * 「合作条款」，检索器给它一条模糊命中是**对的**。92 篇的小库里恰好没这个词，
   * 所以当时通过了；换到 372 篇的真实库就暴露了断言写歪。
   *
   * 真正要守的是：**张冠李戴的原料不许被捞出来**——库里那两篇品牌年框合作，
   * 一旦出现在「完美日记」的检索结果里，模型就有机会把它们的条款安到完美日记头上。
   */
  {
    const q = '我们和完美日记的合作条款是什么'
    const r = await win.evaluate((x) => window.api.vault.search(x), q)
    const hit = (r.hits ?? []).map((h) => h.path)
    const contaminated = hit.filter((p) => /年框合作/.test(p))
    if (contaminated.length) {
      bad.push(`「${q}」把品牌年框合作捞了出来（张冠李戴的原料）：${contaminated.join('、')}`)
    }
    if (!r.fuzzy && r.total > 0) {
      bad.push(`「${q}」返回了**精确**命中 ${r.total} 条——库里没有这个品牌，精确命中说明闸门失效`)
    }
  }
  if (bad.length) throw new Error('B-1 检索回归失败：\n  ' + bad.join('\n  '))
  console.log(`B-1 检索回归 ✓ ${CASES.length} 条全过`)
}
const snap = async (name, ms = 600) => {
  await win.waitForTimeout(ms)
  await win.screenshot({ path: join(shots, name + '.png') })
  record(name)
  console.log('shot:', name)
}
const snapHover = async (name, ms = 250) => {
  await win.waitForTimeout(ms)
  await rawShot(cdp, name)
}

/**
 * 悬停到卡片上、等 hover 才出现的按钮真的可见——**采样一次判死是不行的**。
 *
 * 产物列表挂着 watcher：删一个产物、跑完一轮入库，列表就会重渲染一次。
 * 光标停着不动时，被换掉的那个节点上的 `:hover` 要等下一次鼠标移动才重算，
 * 于是"hover 了但按钮不出来"完全是时序决定的——同一段代码上一轮绿这一轮红
 * （2026-08-18 在 13 和 44 两步各撞过一次）。
 * 所以：挪开 → 重新 hover → 轮询可见性，最多两轮；失败时把现场 dump 出来，
 * 别只报一句"没出现"让下一个人重猜一遍。
 */
const hoverUntilVisible = async (card, btns, label, selector) => {
  const list = Array.isArray(btns) ? btns : [btns]
  let ok = false
  for (let i = 0; i < 2 && !ok; i++) {
    await win.mouse.move(4, 4)
    await card.hover()
    for (let t = 0; t < 12 && !ok; t++) {
      await win.waitForTimeout(150)
      ok = true
      for (const b of list) ok = ok && (await b.isVisible().catch(() => false))
    }
  }
  if (!ok) {
    const dump = selector
      ? await win.locator(selector).evaluateAll((els) =>
          els.map((e) => ({
            cls: e.className.slice(0, 70),
            rect: e.getBoundingClientRect().toJSON(),
            hovering: e.matches(':hover'),
            btns: [...e.querySelectorAll('button')].map((b) => b.textContent.trim()),
          }))
        )
      : null
    throw new Error(`${label}：hover 后按钮没出现；现场：` + JSON.stringify(dump))
  }
}

// ---------- 品牌二期（更名「拉齐」+ 炭黑侧栏 + 信号橙）的断言工具 ----------

/**
 * toast 的"一家人"检查（品牌二期，真人验收点名「同屏两条长得不像一家人」）。
 *
 * 采集是**跨步骤**的：同屏那三条、保存成功的绿、产物打不开那条带按钮的红，
 * 各自在自己的真实场景里被量一次，最后统一比。
 * 为什么不在一个时刻凑齐五种语义色：那需要给产品加一个 `window.__ui` 测试钩子，
 * 而这几种 toast 全都能用真实操作造出来——按本仓库的规矩（HANDOFF §4-22），
 * 能真造的就不给开关。
 */
const toastGeos = []
const grabToastGeo = async (label) => {
  const got = await win.locator('[data-testid="toast"]').evaluateAll((els) =>
    els.map((e) => {
      const s = getComputedStyle(e)
      return {
        kind: e.dataset.kind ?? '?',
        icon: e.dataset.icon ?? '?',
        width: Math.round(e.getBoundingClientRect().width),
        maxWidth: s.maxWidth,
        radius: s.borderRadius,
        font: s.fontSize,
        padding: `${s.paddingTop}/${s.paddingRight}/${s.paddingBottom}/${s.paddingLeft}`,
        bg: s.backgroundColor,
        action: !!e.querySelector('[data-testid="toast-action"]'),
      }
    })
  )
  for (const g of got) toastGeos.push({ ...g, at: label })
  if (!got.length) console.log(`⚠️ toast 几何采集「${label}」没抓到（这一步的 toast 可能已经散了）`)
  return got
}

/**
 * 收尾统一判（三期改判据）：**底色必须全一样**（炭黑）、几何逐项相同、
 * 语义由**图标**表达且对得上、宽度策略一致（自适应 + 同一个上限）。
 * 二期那版判的是"底色至少三种"——那正是被推翻的路线，判据跟着一起改。
 */
const assertToastConsistency = () => {
  if (toastGeos.length < 4)
    throw new Error(`toast 几何样本只有 ${toastGeos.length} 条，覆盖不足（至少要同屏三条 + 成功 + 带按钮的错误）`)
  for (const key of ['radius', 'font', 'padding', 'maxWidth']) {
    const vals = [...new Set(toastGeos.map((g) => String(g[key])))]
    if (vals.length > 1)
      throw new Error(
        `toast 的 ${key} 不一致：${vals.join(' ≠ ')}\n  明细 ` + JSON.stringify(toastGeos, null, 1)
      )
  }
  const bgs = new Set(toastGeos.map((g) => g.bg))
  if (bgs.size > 1)
    throw new Error(`toast 底色不统一（三期规定一律炭黑，语义只走图标）：${[...bgs].join(' ≠ ')}`)
  // 宽度**不要求相等**（自适应文案），但不许超过上限
  for (const g of toastGeos) {
    const cap = parseFloat(g.maxWidth)
    if (Number.isFinite(cap) && g.width > cap + 1)
      throw new Error(`toast 宽度 ${g.width} 超过上限 ${g.maxWidth}：${JSON.stringify(g)}`)
  }
  // 图标语义：info 不许有图标，ok/error/warn 必须有且是自己那一种
  for (const g of toastGeos) {
    const want = g.kind === 'info' ? 'none' : g.kind
    if (g.icon !== want) throw new Error(`toast 语义图标不对：kind=${g.kind} 却是 icon=${g.icon}`)
  }
  const kinds = new Set(toastGeos.map((g) => g.kind))
  if (kinds.size < 3) throw new Error(`语义种类只覆盖到 ${[...kinds].join('/')}，至少要 info/ok/error 三种`)
  if (!toastGeos.some((g) => g.action)) throw new Error('没量到带动作按钮的 toast，这条断言等于空过')
  const widths = [...new Set(toastGeos.map((g) => g.width))]
  console.log(
    'toast 一致性 ✓',
    JSON.stringify({
      样本: toastGeos.length,
      语义: [...kinds],
      底色: [...bgs][0],
      宽度上限: toastGeos[0].maxWidth,
      实际宽度: widths,
      圆角: toastGeos[0].radius,
      字号: toastGeos[0].font,
      内边距: toastGeos[0].padding,
    })
  )
}

/**
 * 全局文案扫描：界面上不许再出现旧名。
 * 扫的是可见文本 ＋ title/placeholder/aria-label（旧名最容易残留在 tooltip 里），
 * 大小写不敏感。每到一个页面都调一次——只在首页扫等于没扫。
 *
 * **扫之前先把两类"环境串"抠掉**（2026-08-18 E2E_CHAT 轮连踩两次）：
 *   ① **邮箱**——侧栏身份行画的是「邮箱 · 版本号」，而测试账号叫
 *      `mcnai-test-a@example.com`，`mcnai` 正好命中 `mcn[-\s]?ai`；
 *   ② **走查自己的临时路径**——知识库页/设置页/换库确认/删除确认都会把库路径画出来，
 *      而走查库就叫 `/tmp/mcnai-e2e-vault`。
 * 两者都是**环境与用户数据，不是品牌文案**，扫它们只会一轮一轮报假红
 * （而且每轮 E2E_CHAT ≈¥1.8，靠跑来发现太贵）。
 *
 * **抠的范围是刻意收窄的**：只抠邮箱、以及 `/tmp` 下 `mcnai-` 开头的走查目录，
 * 不做"凡是路径一律放行"——产品自己生成的名字必须仍在扫描范围内
 * （建库向导写的欢迎笔记、模板目录名这些，真带旧名就该报出来）。
 */
const assertNoOldBrand = async (where) => {
  const hits = await win.evaluate(() => {
    const bad = []
    // 两代旧名都要扫：mcn-ai（初版）与「拉齐」（二期用过一天的中文名，三期改 SamePage）
    const re = /mcn[-\s]?ai|拉齐/i
    // 环境串（邮箱 / 走查临时目录）不属于品牌文案，先抠掉再扫
    const strip = (s) =>
      String(s)
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<邮箱>')
        // 完整路径与"只剩目录名"两种形态都要抠：界面上有的地方画全路径（换库确认、
        // 删除确认），有的地方只画库名。截断成半截（`/tmp/mcnai-e2`）也要能命中，
        // 所以尾巴用 `*` 不用 `+`。
        .replace(/(\/private)?\/tmp\/mcnai-[\w.-]*|mcnai-(e2e|a1|smoke|probe|full|qa)[\w.-]*/g, '<走查目录>')
    const text = document.body.innerText || ''
    for (const line of text.split('\n')) if (re.test(strip(line))) bad.push(`正文:「${line.trim()}」`)
    for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
      for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute(a)
        if (v && re.test(strip(v))) bad.push(`${a}:「${v}」`)
      }
    }
    if (re.test(document.title)) bad.push(`document.title:「${document.title}」`)
    return bad
  })
  if (hits.length) throw new Error(`【${where}】界面上还有旧名（mcn-ai／拉齐）：\n  ` + hits.join('\n  '))
  console.log(`旧名扫描 ✓ ${where}`)
}

/**
 * 旧玫瑰色残留扫描（品牌二期 D）。
 *
 * 两道：① **精确黑名单**——上一版主色与它的淡色/线色变体，出现即失败；
 * ② **色相兜底**——任何落在玫红/品红区间（H 300–355）且有饱和度的颜色都报出来，
 * 防的是"有人又调了一支新粉进来"。
 *
 * 唯一的白名单是关系图图例里的藕紫（H≈322）：它是实体卡「合作方」那一支，
 * 是**这次配色方案定的**颜色，不是残留。白名单按 DOM 位置给（图例容器内），
 * 不按色值给——按色值等于把整段紫色区间放行。
 */
const ROSE_BLACKLIST = ['226, 84, 132', '207, 91, 122', '217, 139, 166', '194, 81, 122', '251, 236, 243']
const assertNoRose = async (where) => {
  const found = await win.evaluate(
    ({ blacklist }) => {
      const PROPS = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor', 'fill', 'stroke', 'caretColor']
      const hue = (r, g, b) => {
        const [mx, mn] = [Math.max(r, g, b), Math.min(r, g, b)]
        if (mx === mn) return { h: 0, s: 0 }
        const d = mx - mn
        const l = (mx + mn) / 2 / 255
        const s = d / 255 / (1 - Math.abs(2 * l - 1))
        let h
        if (mx === r) h = ((g - b) / d) % 6
        else if (mx === g) h = (b - r) / d + 2
        else h = (r - g) / d + 4
        return { h: (h * 60 + 360) % 360, s }
      }
      const hits = []
      for (const el of document.querySelectorAll('*')) {
        // 图例里的藕紫是本方案定的「合作方」色，不是旧玫瑰残留
        if (el.closest('[data-testid="graph-legend"]')) continue
        const cs = getComputedStyle(el)
        for (const p of PROPS) {
          const v = cs[p]
          const m = String(v).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
          if (!m) continue
          const [r, g, b] = [+m[1], +m[2], +m[3]]
          const a = m[4] === undefined ? 1 : +m[4]
          if (a < 0.05) continue
          const key = `${r}, ${g}, ${b}`
          if (blacklist.includes(key)) {
            hits.push({ why: '旧玫瑰色值', tag: el.tagName, cls: String(el.className).slice(0, 50), p, v })
            continue
          }
          const { h, s } = hue(r, g, b)
          if (h >= 300 && h <= 355 && s > 0.15) {
            hits.push({ why: `玫红区间 H=${Math.round(h)}`, tag: el.tagName, cls: String(el.className).slice(0, 50), p, v })
          }
        }
      }
      return hits.slice(0, 12)
    },
    { blacklist: ROSE_BLACKLIST }
  )
  if (found.length)
    throw new Error(`【${where}】界面上还有玫瑰/粉系颜色：\n  ` + found.map((f) => `${f.why} ${f.p}=${f.v} on <${f.tag} class="${f.cls}">`).join('\n  '))
  console.log(`旧玫瑰扫描 ✓ ${where}`)
}

/**
 * 深色侧栏的对比度闸门（WCAG AA 4.5:1，全是小字所以没有大字豁免）。
 *
 * **在渲染态真算**，不是拿设计稿的十六进制对：文字色多半是 rgba（ink-soft 就是），
 * 必须先合成到它实际压着的那层底上，否则算出来的数比眼睛看到的好看得多。
 */
const assertSidebarContrast = async () => {
  const rows = await win.evaluate(() => {
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
    const lum = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255)
    const parse = (s) => {
      const m = String(s).match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const p = m[1].split(',').map((x) => parseFloat(x))
      return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]
    }
    const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]))
    /** 元素实际压着的底：自己不透明就用自己，否则往上找，最后落到侧栏底色 */
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c && c[3] === 1) return c.slice(0, 3)
        if (c && c[3] > 0) return over(c, bgOf(n.parentElement || document.body))
      }
      return [255, 255, 255]
    }
    const ratio = (el) => {
      const bg = bgOf(el)
      const fg = over(parse(getComputedStyle(el).color), bg)
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
      return (hi + 0.05) / (lo + 0.05)
    }
    const out = []
    const side = document.querySelector('aside')
    if (!side) return out
    const push = (label, el) => {
      if (!el) return
      const t = (el.innerText || '').trim().slice(0, 18)
      if (!t) return
      out.push({ label, text: t, ratio: Math.round(ratio(el) * 100) / 100 })
    }
    push('侧栏标题', side.querySelector('.text-xl'))
    push('副标题', side.querySelector('.text-xs.text-muted'))
    push('新对话按钮', side.querySelector('button[title="新对话"]'))
    side.querySelectorAll('nav button').forEach((b, i) => push(`导航${i + 1}`, b))
    push('分组标题-最近对话', side.querySelector('.text-2xs'))
    push('最近对话项', side.querySelector('.group.relative button'))
    push('身份行', side.lastElementChild)
    document.querySelectorAll('[data-testid="task-dock"] *').forEach((e) => {
      if (e.children.length === 0) push('TaskDock', e)
    })
    return out
  })
  const bad = rows.filter((r) => r.ratio < 4.5)
  console.log('侧栏对比度：' + rows.map((r) => `${r.label} ${r.ratio}`).join(' · '))
  if (bad.length)
    throw new Error(
      '深色侧栏对比度不达 WCAG AA 4.5：\n  ' +
        bad.map((b) => `${b.label}「${b.text}」= ${b.ratio}`).join('\n  ')
    )
  if (rows.length < 5) throw new Error(`侧栏对比度只测到 ${rows.length} 项，选择器多半失效了`)
}

/** 侧栏 logo：真的在、真是 20px、基准线真是橙色（不是继承下来的文字色） */
const assertSidebarLogo = async () => {
  const r = await win.evaluate(() => {
    const side = document.querySelector('aside')
    const svg = side?.querySelector('[data-testid="brand-logo"]')
    if (!svg) return { ok: false, why: '侧栏里没有 logo' }
    const bar = svg.querySelector('[data-testid="brand-logo-bar"]')
    const box = svg.getBoundingClientRect()
    const barColor = getComputedStyle(bar).stroke
    const lineColor = getComputedStyle(svg.querySelector('line')).stroke
    return {
      ok: true,
      size: Math.round(box.width),
      lines: svg.querySelectorAll('line').length,
      barColor,
      lineColor,
      title: side.querySelector('.text-xl')?.textContent?.trim(),
      titleFont: side.querySelector('.text-xl') ? getComputedStyle(side.querySelector('.text-xl')).fontFamily : '',
    }
  })
  if (!r.ok) throw new Error('侧栏 logo：' + r.why)
  if (r.size < 16 || r.size > 20) throw new Error(`侧栏 logo 尺寸 ${r.size}px，不在 16–20 区间`)
  if (r.lines !== 4) throw new Error(`侧栏 logo 应为 3 横线 + 1 基准线 = 4 条，实为 ${r.lines}`)
  if (r.barColor === r.lineColor)
    throw new Error(`基准线与横线同色（${r.barColor}）——橙色 token 没生效`)
  if (!/^rgb\(2[0-9]{2},\s*1[0-9]{2},/.test(r.barColor))
    throw new Error(`基准线不是橙色：${r.barColor}`)
  if (r.title !== 'SamePage') throw new Error(`侧栏标题不是 SamePage，实为「${r.title}」`)
  if (!/SF Pro|-apple-system|Inter|Helvetica/i.test(r.titleFont))
    throw new Error(`主名没走品牌英文字体栈（--font-brand），实为 ${r.titleFont}`)
  console.log('侧栏 logo ✓', JSON.stringify(r))
}

// ---------- 过程可见性（步骤流）的断言工具 ----------
//
// 一条铁律：**断言一律到参数层**。「有一条检索步骤」是弱断言，跑绿了也证明不了
// 参数透传是通的；要断言的是「界面上那句话里的检索词，就是主进程这一轮发出去的那个词」。
// 所以先把原始步骤事件收下来（`window.__steps`），再拿它比对 DOM 文本。

/** 每轮开始前调用：清空上一轮的事件，订阅只挂一次 */
const armSteps = () =>
  win.evaluate(() => {
    window.__steps = []
    if (window.__stepsArmed) return
    window.__stepsArmed = true
    window.api.chat.onStream((p) => {
      if (p.kind !== 'tool' || !p.step) return
      const s = p.step
      let cur = window.__steps.find((x) => x.id === s.id)
      if (!cur) {
        cur = { id: s.id, tool: s.tool, args: {} }
        window.__steps.push(cur)
      }
      if (s.args) cur.args = s.args
      if (s.phase === 'result') {
        cur.count = s.count
        cur.unit = s.unit
        cur.failed = !!s.failed
      }
    })
  })

/** 主进程真正发出来的步骤（含参数与结果数），按轮次分组 */
const rawSteps = () => win.evaluate(() => window.__steps ?? [])
/** 步骤 id 形如 `agent:<会话>#<本轮开始时刻>.<序号>`，按中间那段切轮次 */
const rawStepGroups = async () => {
  const gs = []
  let key = null
  for (const s of await rawSteps()) {
    const k = String(s.id).split('#')[1]?.split('.')[0]
    if (k !== key) {
      key = k
      gs.push([])
    }
    gs[gs.length - 1].push(s)
  }
  return gs
}

/** 界面上真正画出来的步骤行 */
const stepRows = () =>
  win.locator('[data-testid="step-item"]').evaluateAll((els) =>
    els.map((e) => ({
      kind: e.dataset.kind,
      status: e.dataset.status,
      count: e.dataset.count,
      unit: e.dataset.unit,
      retry: e.dataset.retry === '1',
      verify: e.dataset.verify === '1',
      text: e.textContent.trim(),
    }))
  )

/**
 * 核对步骤的参数层：**目标 + 数字**都得在，而且量词要跟单位对上
 * （份=笔记，处=一篇里的行内命中；混着说就是瞎报）。
 * 数字还必须能在原始事件里找到出处——不然就是界面自己编的。
 */
let sawScanCount = null
const assertScanRow = (rows, events) => {
  const scan = rows.find((r) => r.kind === 'scan' && r.status === 'done' && r.count !== '')
  if (!scan) return
  const ok =
    scan.unit === 'file'
      ? new RegExp(`核对了 ${scan.count} 份\\S`).test(scan.text)
      : new RegExp(`核对了\\S+，命中 ${scan.count} 处`).test(scan.text)
  if (!ok) throw new Error(`核对步骤缺目标或数字，或量词与单位对不上（${scan.unit}）：「${scan.text}」`)
  if (!events.some((s) => String(s.count) === scan.count && s.unit === scan.unit))
    throw new Error(`核对步骤的数字在原始事件里查无出处：界面 ${scan.count}/${scan.unit}，事件 ${JSON.stringify(events.map((s) => [s.tool, s.count, s.unit]))}`)
  sawScanCount = scan.text
}

/** 等到某个工具的步骤把参数带回来（start 与 args 是两拍） */
const waitStepArgs = async (tool, key, timeout = 180000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const s = (await rawSteps()).find((x) => x.tool === tool && x.args?.[key])
    if (s) return s
    await win.waitForTimeout(300)
  }
  return null
}

/**
 * 折叠摘要里的 N 的口径（与 lib/step-stream.ts 的 resourceCount 同一套）：
 * **只算「份」**（unit==='file'），阅读按篇。Grep 的行内命中（unit==='match'）
 * 是一篇里的几十行，加进来就成了"检索了 42 份资料"的瞎报。
 * 这里**独立重算一遍**，用来和界面上的数字对账。
 */
const expectResourceCount = (steps) => {
  const readOnce = new Set()
  let n = 0
  for (const s of steps) {
    if (s.failed) continue
    if (s.tool === 'Read') {
      const k = s.args?.file ?? s.id
      if (readOnce.has(k)) continue
      readOnce.add(k)
      n += 1
    } else if (['search_knowledge', 'Grep', 'Glob'].includes(s.tool) && s.unit === 'file') {
      n += s.count ?? 0
    }
  }
  return n
}

/** 整个步骤流区域一个英文工具名都不许出现（兜底文案也只说「正在处理」） */
const TOOL_NAME_LEAK = /(search_knowledge|render_pptx|render_document|mcp__|\bRead\b|\bGrep\b|\bGlob\b|\bBash\b|\bWrite\b|\bEdit\b|\bWebFetch\b)/
const assertNoToolNames = async (where) => {
  const txt = await win
    .locator('[data-testid="step-list"], [data-testid="steps-summary"], [data-testid="steps-summary-open"]')
    .evaluateAll((els) => els.map((e) => e.textContent).join('\n'))
  const hit = txt.match(TOOL_NAME_LEAK)
  if (hit) throw new Error(`${where}：步骤流里漏出了工具原名「${hit[0]}」\n${txt.slice(0, 400)}`)
  return txt
}

/** 「阅读《…》」这条至少要在整轮走查里出现一次并被验到参数层 */
let sawReadTitle = null

// E2E_CHAT=1 要真调 AI：本地模式没有 key，必须先用测试账号登录拿服务端下发的 key
/** 收尾的 before-quit 断言要自己 close，finally 里别再关一次 */
let closed = false

const CHAT = process.env.E2E_CHAT === '1'
const E2E_EMAIL = process.env.E2E_EMAIL || 'mcnai-test-a@example.com'
const E2E_PASSWORD = process.env.E2E_PASSWORD || 'McnAi-Test-2026!'

try {
  await snap('00-登录门', 1500)
  // 登录门是 logo 三落点之一（大尺寸 logo + SamePage 字标），也是旧名最容易残留的一屏
  await assertNoOldBrand('登录门')
  await assertNoRose('登录门')
  {
    const g = await win.evaluate(() => {
      const svg = document.querySelector('[data-testid="brand-logo"]')
      return svg
        ? { size: Math.round(svg.getBoundingClientRect().width), lines: svg.querySelectorAll('line').length,
            name: [...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'SamePage') }
        : null
    })
    if (!g) throw new Error('登录页没有品牌 logo')
    if (g.size < 48) throw new Error(`登录页 logo 只有 ${g.size}px，不是大尺寸落点`)
    if (g.lines !== 4) throw new Error(`登录页 logo 线条数 ${g.lines}，应为 4`)
    if (!g.name) throw new Error('登录页没有 SamePage 字标')
    console.log('登录页 logo ✓', JSON.stringify(g))
  }
  if (CHAT) {
    await win.fill('input[placeholder="邮箱"]', E2E_EMAIL)
    await win.fill('input[placeholder="密码"]', E2E_PASSWORD)
    const tLogin = Date.now()
    await win.click('button:has-text("登录")')
    // M-29 修复后：会话与 key 的加密落盘都转成后台任务，登录不再被 safeStorage 冻住。
    // 以前这里要给到 10 分钟（主进程一冻，CDP 跟着停，界面迟迟不出来），现在 90s 足够，
    // 超了就是回归——写入又跑回登录这条同步路径上了
    await win.locator('button[title="新对话"]').waitFor({ timeout: 90000 })
    console.log(`登录到进主界面 ${Date.now() - tLogin}ms`)
    // 等服务端下发 key 落库：safeStorage 写 Keychain 要好几秒（实测 ~6s），固定等会误判
    let s = await win.evaluate(() => window.api.settings.get())
    for (let i = 0; i < 30 && !s.hasApiKey; i++) {
      await win.waitForTimeout(1000)
      s = await win.evaluate(() => window.api.settings.get())
    }
    if (!s.hasApiKey) throw new Error('登录后没拿到 AI key，E2E_CHAT 跑不了（检查中转站/账号）')
    console.log('登录 ✓ key 已下发')
    // M-29 的正主：老用户每次启动/登录都会重跑 provision。同一把 key 必须一次都不写
    const p1 = await win.evaluate(() => window.api.auth.provision())
    const p2 = await win.evaluate(() => window.api.auth.provision())
    if (!p2.ok) throw new Error('第二次 provision 失败：' + p2.error)
    if (p2.wrote?.length)
      throw new Error(`同一份服务端配置重复下发时又写了 key：${JSON.stringify(p2.wrote)}`)
    console.log('M-29 重复下发零写入 ✓', JSON.stringify({ 第一次: p1.wrote, 第二次: p2.wrote }))
  } else {
    const skip = win.locator('text=暂不登录')
    if (await skip.count()) {
      await skip.click()
      await win.waitForTimeout(800)
    }
  }
  await snap('01-工作台首页', 800)
  /**
   * R-3 的反面：**有内容的库上不许出现空库引导**。
   * 这条比正面那条更容易坏——`vault.tree()` 读慢一点或抛一下，首页就会挂着
   * 一句「知识库还是空的」，而用户库里躺着几百篇。
   */
  {
    const sub = (await win.locator('[data-testid="home-subtitle"]').innerText()).trim()
    if (sub !== '问你的库，或直接说要做什么') throw new Error(`非空库首页副标题被改成了空库那句：「${sub}」`)
    if (await win.locator('[data-testid="home-empty-vault-hint"]').count())
      throw new Error('库里有内容，首页却挂着空库引导')
  }
  await assertSidebarLogo()
  await assertSidebarContrast()
  await assertNoOldBrand('工作台首页')
  await assertNoRose('工作台首页')
  // 深色侧栏的 hover 态要单独留一张：hover 只有 CDP 抓屏截得到（§4-15），
  // 而"深底上 hover 是提亮还是压暗"正是这次改动最容易做错的一处
  await win.hover('nav button:has-text("个人知识库")')
  await snapHover('01i-侧栏-深色hover态')
  // 对话工作台（默认页，无模块入口——新对话/Recents 即入口）：空态 + 输入 + 快捷指令
  await snap('01b-工作台-空态', 400)

  // 问候语不许出现用户 ID 数字：本地模式无昵称 → 只剩问候语本身
  const greeting = (await win.locator('h1').first().innerText()).trim()
  if (!/^(早上好|下午好|晚上好|夜深了)$/.test(greeting)) throw new Error(`问候语不对：「${greeting}」`)
  const footer = await win.locator('aside div').last().innerText()
  if (/\d{6,}/.test(footer)) throw new Error(`侧栏身份行露出了用户 ID：「${footer}」`)
  if (!footer.includes('v0.1.0')) throw new Error(`侧栏身份行缺版本号：「${footer}」`)
  console.log('问候语/身份行 ✓', JSON.stringify({ greeting, footer: footer.trim() }))

  // 输入框：60px 起高 + 附件占位按钮
  // offsetHeight：含 1px 边框的实际高度（box-sizing: border-box，clientHeight 会少掉两条边）
  const boxH = await win.locator('textarea').first().evaluate((el) => el.parentElement.offsetHeight)
  if (boxH < 60) throw new Error(`输入框高度不足 60px：${boxH}`)
  if (!(await win.locator('[data-testid="attach-btn"]').count())) throw new Error('输入框缺附件按钮')
  // 附件已经做实（A-3 B'）：按钮不再是占位、也不再吐 toast，标题里不许再写「即将支持」
  {
    const t = (await win.locator('[data-testid="attach-btn"]').getAttribute('title')) ?? ''
    if (/即将|敬请|占位/.test(t)) throw new Error(`附件按钮还是占位文案：「${t}」`)

    /**
     * 挑图 → 缩略图条 → 移除。**这里只验界面这一半，不发消息**：主走查后面有一串
     * 按消息条数写的断言，中途多发一轮会把它们整体推偏（同 a1-enqueue 拆出去的理由）。
     * 「发出去之后附件到没到主进程、thumb 有没有被剥掉」在 e2e/attachments.mjs 里验。
     */
    /**
     * 用**仓库里真实的 logo.png** 当附件样本，不要手搓 base64——
     * 第一版就是内联了一段 base64，`nativeImage` 解不出来 → `thumb` 是空串 →
     * `<img src="">` → naturalWidth=0，断言红了才发现"图不合法"而不是"链路坏了"。
     */
    const pic = join(root, 'src/renderer/src/assets/logo.png')
    if (!existsSync(pic)) throw new Error(`附件样本图不存在：${pic}`)
    const restore = await app.evaluate(({ dialog }, f) => {
      const orig = dialog.showOpenDialog
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
      // 走查后面还要用 showOpenDialog（换库选目录），用完必须还回去
      globalThis.__restoreOpenDialog = () => { dialog.showOpenDialog = orig }
      return true
    }, pic)
    if (!restore) throw new Error('桩 showOpenDialog 失败')
    await win.click('[data-testid="attach-btn"]')
    await win.locator('[data-testid="attach-strip"]').waitFor({ timeout: 8000 })
    const thumb = await win.evaluate(() => {
      const i = document.querySelector('[data-testid="attach-strip"] img')
      return i ? { w: i.naturalWidth, isData: (i.getAttribute('src') || '').startsWith('data:') } : null
    })
    // 量像素不数标签：<img> 在但 naturalWidth=0 正是这条链路最典型的失败形态
    if (!thumb || thumb.w <= 0) throw new Error(`附件缩略图没渲染出来：${JSON.stringify(thumb)}`)
    if (!thumb.isData) throw new Error('附件缩略图不是内存态 dataURL（不落库的前提）')
    await snap('01h-附件缩略图条', 200)
    await win.locator('[data-testid="attach-strip"] .group').first().hover()
    await win.locator('[data-testid="attach-remove"]').first().click()
    await win.waitForTimeout(300)
    if (await win.locator('[data-testid="attach-strip"]').count())
      throw new Error('移除最后一张附件后，缩略图条没有消失')
    await app.evaluate(() => globalThis.__restoreOpenDialog?.())
    console.log('附件直供（界面半）✓', JSON.stringify(thumb))
  }

  // ---- 会话级模型档位：选择器在输入框**下沿控制条**上（不在输入框里）、新会话默认标准 ----
  {
    const sel = win.locator('[data-testid="tier-selector"]')
    if (!(await sel.count())) throw new Error('输入框下沿没有模型档位选择器')
    if ((await sel.getAttribute('data-tier')) !== 'standard') throw new Error('新会话默认档位不是标准')
    const label = (await sel.innerText()).trim()
    if (!label.includes('标准')) throw new Error(`档位按钮文案不对：「${label}」`)
    // 位置：必须在控制条里，且**输入框那一行内不得再有档位控件**（返工要求）
    const place = await win.evaluate(() => {
      const ta = document.querySelector('textarea')
      const bar = document.querySelector('[data-testid="composer-bar"]')
      const sel = document.querySelector('[data-testid="tier-selector"]')
      return {
        在控制条里: !!(bar && sel && bar.contains(sel)),
        输入行里还有: !!(ta?.parentElement && ta.parentElement.querySelector('[data-testid="tier-selector"]')),
        控制条靠右: bar ? getComputedStyle(bar).justifyContent : null,
        // 控制条在输入行**下面**：比一比两者的 y
        在输入行下方:
          !!(ta && bar) && bar.getBoundingClientRect().top >= ta.getBoundingClientRect().bottom - 1,
      }
    })
    if (!place.在控制条里) throw new Error('档位选择器没有落在输入框下沿的控制条上')
    if (place.输入行里还有) throw new Error('输入框内部还留着档位控件（返工要求：内部只留附件位）')
    if (!place.在输入行下方) throw new Error('控制条没有落在输入行下方')
    if (place.控制条靠右 !== 'flex-end') throw new Error(`控制条不是靠右对齐：${place.控制条靠右}`)
    // 形态是低调文字胶囊，说明写在菜单里而不是 tooltip 上
    if (await sel.getAttribute('title')) throw new Error('档位按钮还挂着 tooltip（返工要求去掉）')
    const LEAK = /deepseek|claude|opus|aihubmix|inferera|kimi|智谱/i
    await sel.click()
    await win.locator('[data-testid="tier-menu"]').waitFor({ timeout: 8000 })
    const menuText = await win.locator('[data-testid="tier-menu"]').innerText()
    if (LEAK.test(menuText)) throw new Error(`档位菜单泄露了供应商/模型名：「${menuText}」`)
    if (!/消耗/.test(menuText)) throw new Error(`档位菜单没有说清消耗差异：「${menuText}」`)
    // 主实例把探测强制判为可用，所以这里两档都该能选（置灰分支在上面的独立实例里验）
    if ((await win.locator('[data-testid="tier-option-enhanced"]').getAttribute('data-available')) !== '1')
      throw new Error('强制可用时增强档仍然置灰')
    // 菜单向上弹（贴在控制条上方），别把输入框和正文挡在下面看不见
    const upward = await win.evaluate(() => {
      const m = document.querySelector('[data-testid="tier-menu"]').getBoundingClientRect()
      const b = document.querySelector('[data-testid="tier-selector"]').getBoundingClientRect()
      return m.bottom <= b.top + 2
    })
    if (!upward) throw new Error('档位菜单不是向上弹的')
    await snap('45-档位选择器-展开', 250)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    console.log('档位选择器 ✓', JSON.stringify({ 默认: label, 菜单: menuText.replace(/\s+/g, ' ').slice(0, 60) }))
  }

  // 流式光标：完整流式链路只有 E2E_CHAT=1（真实 AI 调用）才跑得到，
  // 这里至少断言光标样式在 streaming-body 上能生效，别静默失效
  // 注意：走查开了 prefers-reduced-motion:reduce（防止截到动画中间帧），
  // 光标此时不闪但仍然要在，所以断言几何与颜色，动画名只做记录
  const caret = await win.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'streaming-body'
    probe.innerHTML = '<div class="md-article"><p>x</p></div>'
    document.body.appendChild(probe)
    const st = getComputedStyle(probe.querySelector('p'), '::after')
    const info = { content: st.content, width: st.width, bg: st.backgroundColor, anim: st.animationName }
    probe.remove()
    return info
  })
  if (caret.width !== '2px' || caret.content !== '""') throw new Error('流式输出光标样式未生效：' + JSON.stringify(caret))
  console.log('流式光标样式 ✓', JSON.stringify(caret))

  // 首页卡片区：库里有产物 → 「最近产物」必须出现
  if (!(await win.locator('text=最近产物').count())) throw new Error('首页缺「最近产物」卡片区')
  // 且右侧产物面板必须是收起的（否则首页同屏两份一样的内容）
  if (await win.locator('text=90_产物/').count()) throw new Error('首页产物面板没有默认收起')
  if (!(await win.locator('button[title="打开产物面板"]').count())) throw new Error('首页缺收起态的产物入口')
  await snap('01f-首页-最近产物卡片区', 400)

  // chips 真点一次：应把模板文案填进输入框
  await win.click('text=写种草脚本')
  await win.waitForTimeout(300)
  const chipVal = await win.locator('textarea').first().inputValue()
  if (chipVal !== '写种草脚本：') throw new Error(`chip 未填充输入框："${chipVal}"`)
  await snap('01g-chips点击填充', 200)

  // ---- L-03 toast：同屏最多 3 条 / 悬停暂停倒计时 / 点击立刻关掉 ----
  /**
   * toast 发生器（2026-08-18 迁移）：原来点「附件」按钮，那颗按钮每点一次吐一条 toast，
   * 正好当发生器。附件做实之后它不再吐 toast 了，于是换成**往工作台拖一个空目录**——
   * `enqueue` 收到 0 个可入库文件必回一条「未发现可入库的文件」，而且 `added=0`
   * **不会往投递箱写任何东西、不会踢起 pipeline**（这一点很关键，见 a1-enqueue.mjs 的头注释：
   * 主走查中段起一轮 pipeline 会把后面按时序写的断言整体推偏）。
   */
  const TOAST_SRC = '/tmp/mcnai-e2e-toast-src'
  mkdirSync(TOAST_SRC, { recursive: true })
  const emitToastOnce = async () => {
    await win.evaluate((p) => {
      const dt = new DataTransfer()
      const f = new File([''], p.split('/').pop())
      Object.defineProperty(f, 'path', { value: p })
      dt.items.add(f)
      const el = document.querySelector('textarea')?.closest('div[class*="rounded"]')?.parentElement ?? document.body
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, TOAST_SRC)
  }

  {
    await win.locator('[data-testid="toast"]').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
    for (let i = 0; i < 5; i++) {
      await emitToastOnce()
      await win.waitForTimeout(120)
    }
    const n = await win.locator('[data-testid="toast"]').count()
    if (n !== 3) throw new Error(`连点 5 次后 toast 没有限流到 3 条：${n}`)
    await snap('40c-toast-最多三条', 100)

    // 同屏这三条先量一遍（长短不一的文案就在这里）：几何必须逐项相同
    await grabToastGeo('同屏三条')
    await snapHover('40e-toast-同屏几何一致')
    /**
     * 「悬停暂停」和「点击关闭」拆成两段互不依赖的验证，各自用一条**新发的** toast。
     *
     * 这一步反复假红过两次，两次都是断言自己的竞态，不是产品的问题：
     *  · 第一次：拿 `.first()`（最老那条）去比 3.2 秒倒计时——它的寿命被前面 5 连点和截图
     *    耗掉一大截，等于跟自己的倒计时赛跑；判据还只看总数，别的 toast 也能满足
     *  · 第二次：悬停验完之后接着点同一条。可中间隔着一张截图，鼠标一离开倒计时就恢复，
     *    等点它的时候人早没了（`Element is not attached to the DOM`）
     * 所以现在每段都从「发一条新的」开始，谁也不指望上一段留下的元素还活着。
     */
    /**
     * 发一条新 toast 并拿到句柄。**只动测试，与任何产品改动无关**。
     *
     * 这一处前后踩了四个竞态，前两个已随「拿最老那条」「两段共享元素」修掉，剩下这两个：
     *  ③ 固定睡 150ms 再抓 `.last()`：机器一忙新 toast 还没渲染出来，抓到的是上一条
     *    **快过期的**，于是「悬停 5 秒后还在」当场假红（纯 HEAD 上复现过）
     *  ④ 上一段验完悬停后鼠标还压在那条上、倒计时永久暂停——所以要先把鼠标挪开，
     *    否则下面等「屏上一条不剩」会直接等到超时
     * 现在每次都从干净状态起步，`.last()` 必然就是刚发的那条、寿命是满的。
     * （数量涨没涨不能当判据：同屏限流 3 条，满了之后再发数量也不变。）
     */
    const emitToast = async () => {
      await win.mouse.move(0, 0)
      await win.locator('[data-testid="toast"]').first().waitFor({ state: 'detached', timeout: 10000 })
      await emitToastOnce()
      await win.locator('[data-testid="toast"]').first().waitFor({ timeout: 8000 })
      const h = await win.locator('[data-testid="toast"]').last().elementHandle()
      if (!h) throw new Error('补发的 toast 没出现，拿不到句柄')
      return h
    }
    const alive = (h) => h.evaluate((el) => el.isConnected).catch(() => false)

    // 段一 · 悬停暂停：默认 3.2 秒，悬停 5 秒后这一条必须还在
    const hovered = await emitToast()
    /**
     * 竞态⑤（2026-08-18 品牌二期走查现场）：`hover()` 返回不等于 `mouseenter` 已经落上，
     * 于是"悬停 5 秒还在"变成跟 3.2 秒倒计时赛跑——上一轮绿、这一轮红，代码没动过。
     * 所以先**确认 `:hover` 真的命中**（命中 = React 的 onMouseEnter 一定已经跑过，
     * 暂停生效），落不上就挪开重来一次；始终落不上才是真失败，报出来别静默重试到超时。
     */
    let onIt = false
    for (let i = 0; i < 2 && !onIt; i++) {
      await hovered.hover()
      for (let t = 0; t < 10 && !onIt; t++) {
        onIt = await hovered.evaluate((el) => el.matches(':hover')).catch(() => false)
        if (!onIt) await win.waitForTimeout(100)
      }
      if (!onIt) await win.mouse.move(0, 0)
    }
    if (!onIt) throw new Error('鼠标没能真正落在 toast 上（:hover 一直不命中），悬停暂停这条验不了')
    /**
     * 边等边采样，而不是干等 5 秒。
     *
     * **2026-08-19：根因基本查清了，改法也跟着变了。**
     *
     * 老记录：这条在 2026-08-18 那几轮偶发红（同一段代码前后两轮绿、第三轮红），
     * 单独探针连跑 5 轮一次都没复现，当时只能记「根因没查清」。
     *
     * 这次的时间线给出了**判据性证据**：`2ms hov=1 | 255ms hov=1 | 508ms hov=0 | …一路 0`。
     *   · 若是**产品的暂停逻辑坏了** → `hov` 会一直是 1，元素却消失
     *   · 实际是 **`hov` 先掉到 0 且再没回来**，之后倒计时才恢复
     * → **是悬停被夺走，产品行为是对的**。走查开的是真实屏幕窗口，
     * 真实鼠标划过会发出真的 mouseover/mouseout，把 Playwright 的合成 hover 顶掉；
     * "单独探针复现不了"也对得上——探针跑得快、又常在没人碰电脑的时候跑。
     *
     * 所以改成**每次采样前把鼠标按回去**：断言语义不变（悬停期间倒计时必须暂停），
     * 只是不再假设一次 hover 能站住 5 秒。时间线仍然打印——它是这次能定性的唯一依据。
     */
    const tl = []
    const t0 = Date.now()
    let dead = false
    for (let i = 0; i < 20 && !dead; i++) {
      await hovered.hover({ force: true }).catch(() => {}) // 鼠标按回去：真实指针会把合成 hover 顶掉
      const st = await hovered
        .evaluate((el) => ({ conn: el.isConnected, hov: el.matches(':hover') }))
        .catch(() => ({ conn: false, hov: false }))
      if (!st.conn) dead = true
      else tl.push(`${Date.now() - t0}ms hov=${st.hov ? 1 : 0}`)
      if (!dead) await win.waitForTimeout(250)
    }
    if (dead)
      throw new Error(
        `悬停 5 秒后被悬停的那条 toast 仍自己消失了（倒计时没暂停）；时间线：${tl.join(' | ')}`
      )
    const stay = await win.locator('[data-testid="toast"]').count()
    await snapHover('40d-toast-悬停暂停倒计时')

    // 段二 · 点击关闭：另发一条，点下去必须立刻从 DOM 上消失（不依赖段一那条还在不在）
    const clicked = await emitToast()
    await clicked.click()
    await win.waitForTimeout(250)
    if (await alive(clicked)) throw new Error('点击没有关掉 toast')
    const after = await win.locator('[data-testid="toast"]').count()
    console.log(
      'L-03 toast ✓',
      JSON.stringify({ 连点5次同屏: n, 悬停5秒后仍在: stay, 点击关闭后同屏: after })
    )
    await win.locator('[data-testid="toast"]').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
  }

  const chatInput = win.locator('textarea').first()
  if (await chatInput.count()) {
    await chatInput.fill('灰太太最近的数据怎么样？')
    await snap('01c-工作台-输入态', 400)
    // 回归 2026-07-24：长句自动折行时输入框要跟着长高（旧版 rows 只数 \n，折行后上一行被顶没）
    const h1 = await chatInput.evaluate((el) => el.clientHeight)
    await chatInput.fill('这是一段很长的输入用来测试自动折行时输入框会不会自动长高'.repeat(4))
    await win.waitForTimeout(300)
    const h2 = await chatInput.evaluate((el) => el.clientHeight)
    if (h2 <= h1) throw new Error(`输入框折行未长高：${h1} → ${h2}`)
    await snap('01c2-输入框折行自动长高', 300)
    await chatInput.fill('灰太太最近的数据怎么样？')
    if (CHAT) {
      // 爆炸半径守卫（T-02 那单加的）：`result` 分支的改动只该影响**失败**那条路。
      // 这里挂一个流式事件收集器，用来证明成功路径与工具调用路径原样还在——
      // 这一问是库内问题，系统提示词第 1 条要求先 search_knowledge，所以必然有工具事件
      await win.evaluate(() => {
        window.__streamKinds = {}
        window.__streamTools = []
        window.api.chat.onStream((p) => {
          window.__streamKinds[p.kind] = (window.__streamKinds[p.kind] ?? 0) + 1
          if (p.kind === 'tool' && p.tool) window.__streamTools.push(p.tool)
        })
      })
      // 过程可见性：把**主进程发出来的原始步骤事件**收下来。
      // 断言必须拿它去比对界面上的文字（真检索词 / 真文件名 / 真数字），
      // 而不是让 DOM 自己跟自己对——这一单的存在本身就是弱断言的教训。
      await armSteps()
      await chatInput.press('Enter')

      // ---- 48 过程可见性：步骤逐条出现，当前步骤转圈 ----
      {
        await win.locator('[data-testid="step-item"]').first().waitFor({ timeout: 180000 })
        // 采样一次会空过：单条工具可能一秒就回来了，正好错开那一帧。
        // 轮询"曾经出现过转圈的步骤"，抓到再截图
        let live = []
        for (let i = 0; i < 300; i++) {
          live = await stepRows()
          if (live.some((r) => r.status === 'running')) break
          await win.waitForTimeout(200)
        }
        if (!live.some((r) => r.status === 'running'))
          throw new Error('步骤流里始终没有"进行中"的那一条（当前步骤该转圈）：' + JSON.stringify(live))
        await snap('48-步骤流-进行中', 150)
        console.log('步骤流进行中 ✓', JSON.stringify(live.map((r) => `${r.status}|${r.text}`)))
      }
      // 流式中：等第一段正文出来再截，光标才有东西可跟
      await win.locator('.streaming-body, .thinking-dots').first().waitFor({ timeout: 60000 }).catch(() => {})
      await snap('01d-工作台-流式中', 4000)
      // 正文开始往外吐的那一刻截一张：这时候才看得到行尾光标
      await win.locator('.streaming-body').first().waitFor({ timeout: 180000 }).catch(() => {})
      const caretLive = await win.evaluate(() => {
        const el = document.querySelector('.streaming-body .md-article > *:last-child')
        if (!el) return null
        const st = getComputedStyle(el, '::after')
        return { anim: st.animationName, width: st.width, content: st.content }
      })
      if (caretLive) await snap('01d3-流式输出-行尾光标', 100)
      console.log('流式光标（真实流式中）：', JSON.stringify(caretLive))
      // ---- H-10：生成中切走对话再切回来，进行中状态与半截正文都要还在 ----
      {
        // 这一段的前提是"切走的那一刻它还在生成"。第一条问题很短，常常几秒就答完，
        // 那样断言只能空过、截图 28 也刷不出来 —— 所以先确认真有活儿在跑，没有就补发一条长回答的提问
        const agentRunning = () =>
          win.evaluate(async () => {
            const s = await window.api.tasks.list()
            return s.tasks.some((t) => t.kind === 'agent' && t.status === 'running')
          })
        if (!(await agentRunning())) {
          console.log('（第一条回答已经结束，补发一条长回答的提问来验 H-10 切走切回）')
          await chatInput.fill('把灰太太的情况尽量详细地展开讲讲，分点写，越长越好')
          await chatInput.press('Enter')
        }
        // 先等正文吐到一定长度再切走：刚开头就切的话，短回答很容易在这一两秒里答完，
        // 断言就变成了"空过"（切回来本来就该没有进行中状态）
        let bodyNow = ''
        for (let i = 0; i < 40; i++) {
          bodyNow = await win.evaluate(() => document.querySelector('.streaming-body')?.textContent ?? '')
          if (bodyNow.replace(/\s+/g, '').length >= 24) break
          await win.waitForTimeout(500)
        }
        if (bodyNow.trim()) {
          const convTitle = (await win.locator('aside div.group button').first().innerText()).trim()
          await win.locator('button[title="新对话"]').click() // 切走
          await win.waitForTimeout(800)
          if (await win.locator('button[title="停止生成"]').count())
            throw new Error('切到新对话后仍显示上一个会话的停止按钮')
          await win.locator(`aside button:has-text("${convTitle.slice(0, 8)}")`).first().click() // 切回
          await win.waitForTimeout(1200)
          // 短回答有时在切走/切回这一两秒里就答完了——那时候"没有进行中状态"是对的。
          // 所以先问主进程：这条 agent 任务还在跑吗？还在跑却看不到停止按钮，才是 H-10 回归
          const stillRunning = await win.evaluate(async () => {
            const s = await window.api.tasks.list()
            return s.tasks.some((t) => t.kind === 'agent' && t.status === 'running')
          })
          if (!stillRunning) {
            console.log('⚠️ 回答在切走/切回的间隙就结束了，跳过 H-10 切回断言（这不是回归）')
          } else {
            if (!(await win.locator('button[title="停止生成"]').count()))
              throw new Error('切回生成中的对话后没有"进行中"状态（H-10）')
            const bodyBack = await win.locator('.streaming-body').first().innerText().catch(() => '')
            // 比之前先把 markdown 记号剥掉：切走那一刻正文可能停在**没闭合**的强调里
            // （`**结论：…`），那时候星号是当字面量画出来的；等它闭合成粗体，星号就没了。
            // 直接比原文会在这个边界上假失败一次（2026-08-18 实测踩到）
            const plain = (t) => t.replace(/[*_`~\s]/g, '')
            const head = plain(bodyNow).slice(0, 12)
            if (!plain(bodyBack).includes(head))
              throw new Error(`切回后半截正文没接上（draft 基线失效）：期望含「${head}」，实得「${bodyBack.slice(0, 40)}」`)
            await snap('28-切回生成中的对话', 200)
            console.log('H-10 切走切回 ✓', JSON.stringify({ 切走前: head, 切回后长度: bodyBack.length }))
          }
        } else {
          console.log('⚠️ 流式正文还没吐出来，跳过 H-10 切走切回断言')
        }
      }
      await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {})
      await snap('01e-工作台-回答完成', 1200)
      const answered = await win.locator('.md-article').count()
      if (!answered) throw new Error('E2E_CHAT：没有拿到任何回答正文')

      // ---- 爆炸半径：成功路径（is_error=false）与工具调用路径必须零影响 ----
      const stream = await win.evaluate(() => ({ kinds: window.__streamKinds, tools: window.__streamTools }))
      if (!stream.kinds.assistant) throw new Error('成功那一轮没有 assistant 事件：' + JSON.stringify(stream.kinds))
      if (stream.kinds.error) throw new Error('成功那一轮竟然也发了 error 事件：' + JSON.stringify(stream.kinds))
      if (!stream.tools.length)
        throw new Error('这一问没有触发任何工具调用，工具链路无从验证：' + JSON.stringify(stream.kinds))
      const okAnswer = await win.evaluate(async () => {
        const c = (await window.api.chat.list())[0]
        const a = c.messages.filter((m) => m.role === 'assistant')
        return { n: a.length, err: a.some((m) => m.error), len: a[a.length - 1]?.text.length ?? 0 }
      })
      if (okAnswer.err || !okAnswer.len)
        throw new Error('正常回答被判成了错误或正文为空：' + JSON.stringify(okAnswer))
      console.log(
        '爆炸半径守卫 ✓',
        JSON.stringify({ 事件: stream.kinds, 工具: [...new Set(stream.tools)], 回答: okAnswer })
      )

      // ---- 用量记账的写入链路（只有真实调用才跑得到）：一轮对话必须落一条字段齐全的记录 ----
      {
        const ym = new Date().toISOString().slice(0, 7)
        const f = join(userData, 'usage', `${ym}.jsonl`)
        let recs = []
        for (let i = 0; i < 20 && !recs.length; i++) {
          recs = existsSync(f)
            ? readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            : []
          if (!recs.length) await win.waitForTimeout(500)
        }
        if (!recs.length) throw new Error(`真实对话之后 ${f} 里一条用量记录都没有`)
        const last = recs[recs.length - 1]
        for (const k of ['ts', 'sessionId', 'taskType', 'tier', 'expected_model', 'resolved_model', 'durationMs', 'usage'])
          if (!(k in last)) throw new Error(`用量记录缺字段 ${k}：${JSON.stringify(last)}`)
        if (last.tier !== 'standard') throw new Error(`标准档的记录档位不对：${last.tier}`)
        if (last.expected_model !== 'deepseek-v4-pro') throw new Error(`期望模型不对：${last.expected_model}`)
        // 静默降级防线：实际模型必须就是档位钉死的那个
        if (last.resolved_model && last.degraded)
          throw new Error(`标准档被线路静默换了模型：期望 ${last.expected_model}，实际 ${last.models?.join('/')}`)
        console.log(
          '用量记账（标准档真实调用）✓',
          JSON.stringify({ 条数: recs.length, 任务类型: last.taskType, 实际模型: last.resolved_model, 耗时ms: last.durationMs })
        )
      }

      // ================= 过程可见性：参数层断言 =================
      //
      // 全部断言都比对「主进程发出来的真参数」与「界面上那句话」，
      // 不接受「有一条检索步骤」这种弱断言——本单的存在就是弱断言的教训。

      // ---- 49/50 折叠摘要 + 点击展开 + 参数层比对（第一问那一轮）----
      {
        const gs = await rawStepGroups()
        if (!gs.length) throw new Error('真实对话跑完，一条步骤事件都没有——参数透传链路没通')
        // H-10 那段可能补发过一条提问，于是这个会话里有两轮。
        // **只认最后一轮**：下面点开的也是最后那条摘要，两边必须指同一轮，
        // 否则拿上一轮的检索词去比对这一轮的界面，绿了红了都没意义
        const last = gs[gs.length - 1]

        // ① 检索步骤必须含**真实关键词**
        const search = last.find((s) => s.tool === 'search_knowledge' && s.args?.query)
        if (!search) throw new Error('这一轮没有带参数的检索步骤：' + JSON.stringify(last))

        // 摘要必须已经折叠（回答开始输出那一刻收起来的）
        const summary = win.locator('[data-testid="steps-summary"]').last()
        // 等不到就把步骤区的整个状态 dump 出来：只报"没等到"的话，
        // "分组还挂着 live"和"用户点开过所以 pinned"长得一模一样（2026-08-18 为此白跑一轮）
        await summary.waitFor({ timeout: 30000 }).catch(async (e) => {
          const state = await win.evaluate(() => ({
            summary: document.querySelectorAll('[data-testid="steps-summary"]').length,
            openHeader: document.querySelectorAll('[data-testid="steps-summary-open"]').length,
            lists: [...document.querySelectorAll('[data-testid="step-list"]')].map((el) => ({
              live: el.dataset.live,
              pinned: el.dataset.pinned,
            })),
            assistantBubbles: document.querySelectorAll('.md-article').length,
          }))
          throw new Error(`回答落地了却没折叠成摘要，步骤区现状：${JSON.stringify(state)}\n原始错误：${e.message}`)
        })
        const sumText = (await summary.innerText()).trim()
        await snap('49-步骤流-折叠摘要', 300)

        // ② 折叠摘要的数字必须与步骤明细对得上（独立重算一遍，不信界面自己的话）
        const wantN = expectResourceCount(last)
        const gotN = Number((sumText.match(/检索了\s*(\d+)\s*份资料/) ?? [])[1] ?? NaN)
        if (wantN > 0) {
          if (gotN !== wantN)
            throw new Error(
              `折叠摘要的资料数不对：界面「${sumText}」，按步骤明细应为 ${wantN}\n${JSON.stringify(last)}`
            )
        } else if (!/未找到相关资料/.test(sumText)) {
          throw new Error(`零命中那一轮的摘要文案不对：「${sumText}」`)
        }
        if (!/用时\s*\d+(\.\d+)?s/.test(sumText)) throw new Error(`折叠摘要没有用时：「${sumText}」`)

        // ③ 点开看明细
        await summary.click()
        await win.locator('[data-testid="step-list"]').last().waitFor({ timeout: 10000 })
        await snap('50-步骤流-展开明细', 400)
        const rows = await stepRows()
        if (!rows.length) throw new Error('点开折叠摘要之后没有步骤明细')

        // ④ 检索步骤那一行必须含真实检索词（参数层）
        const searchRow = rows.find((r) => r.kind === 'search')
        if (!searchRow || !searchRow.text.includes(search.args.query))
          throw new Error(
            `检索步骤没有带出真实关键词：主进程发的是「${search.args.query}」，界面上是「${searchRow?.text}」`
          )

        // ⑤ 阅读步骤（有就验）：书名号里必须是真实文件名
        const readEv = last.find((s) => s.tool === 'Read' && s.args?.file)
        if (readEv) {
          const title = readEv.args.file.split('/').pop().replace(/\.[a-z0-9]+$/i, '')
          const readRow = rows.find((r) => r.kind === 'read')
          if (!readRow || !readRow.text.includes(`《${title}》`))
            throw new Error(`阅读步骤没有带出书名号文件名「《${title}》」：${readRow?.text}`)
          sawReadTitle = readRow.text
        }

        // ⑥ 核对步骤：目标 + 数字 + 量词与单位对得上
        assertScanRow(rows, last)
        await assertNoToolNames('第一问步骤流')
        console.log(
          '过程可见性 · 第一问 ✓',
          JSON.stringify({ 摘要: sumText, 资料数对账: { 界面: gotN, 明细算出: wantN }, 检索词: search.args.query, 步骤: rows.map((r) => r.text) })
        )
      }

      // ---- 检索策略失控的回归闸门（真人实测 2026-08-18：同一问题 188s，Grep 穷举猜路径）----
      //
      // 机械护栏硬断言；"猜没猜"这种要人看的，把事实打出来给人判断，不自己编一个通过标准
      {
        const g0 = (await rawStepGroups())[0] ?? []
        const scans = g0.filter((s) => ['Grep', 'Glob'].includes(s.tool))
        /**
         * **被护栏拦下的那一步不算"放行"**（2026-08-18 修，A-3 走查现场暴露）。
         * 主进程给它标的是 `capped`、且刻意不标 `failed`（那是我们自己踩的刹车、不是故障，
         * 见 SCAN_LIMIT），而这里只滤 `failed`，于是第 6 次**被拒**的扫描被算成了放行，
         * 报「护栏没生效」——恰恰是护栏生效了才会出现的现象。
         * 这条 off-by-one 一直在，只是以前护栏从没真触发过。
         */
        const allowed = scans.filter((s) => !s.failed && !s.capped)
        // 硬闸：主进程侧的 SCAN_LIMIT=5，放行的绝不该超（超了就是护栏没生效）
        if (allowed.length > 5)
          throw new Error(`文件查找放行 ${allowed.length} 次，超过硬上限 5（canUseTool 闸门没生效）`)
        // 技术黑话：步骤区不许出现 my_script / source_type 这类内部字段名
        const areaText = await win
          .locator('[data-testid="step-list"], [data-testid="steps-summary"], [data-testid="steps-summary-open"]')
          .evaluateAll((els) => els.map((e) => e.textContent).join('\n'))
        const techy = areaText.match(/[a-z][a-z0-9]*_[a-z0-9]+/)
        if (techy) throw new Error(`步骤流里出现技术黑话「${techy[0]}」：${areaText.slice(0, 300)}`)

        const zeroGuess = g0.filter(
          (s) => ['Grep', 'Glob'].includes(s.tool) && s.count === 0 && !s.failed
        )
        const ym = new Date().toISOString().slice(0, 7)
        const f = join(userData, 'usage', `${ym}.jsonl`)
        const recs = existsSync(f)
          ? readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
          : []
        const durMs = recs.filter((r) => r.taskType === 'chat').pop()?.durationMs ?? 0
        console.log(
          '检索策略（第一问）',
          JSON.stringify({
            耗时秒: +(durMs / 1000).toFixed(1),
            达标60秒: durMs > 0 && durMs <= 60000,
            检索次数: g0.filter((s) => s.tool === 'search_knowledge').length,
            文件查找放行: allowed.length,
            被护栏拒绝: scans.length - allowed.length,
            零命中扫描: zeroGuess.length,
            零命中扫描的词: zeroGuess.map((s) => s.args?.pattern ?? s.args?.glob ?? ''),
            步骤: g0.length,
          })
        )
        /**
         * **判据是行为，不是墙钟**（2026-08-18 改，n=3 实测逼出来的）。
         *
         * 这条断言原本用 `durMs > 120000` 判失败，想抗的是 §2-19 那种 188 秒失控——
         * 特征是模型拿不到可引用的检索结果，转去 **穷举猜路径**（`my_script` / `script` /
         * `40_带货/数据` 一长串 0 命中 Grep）。
         *
         * 但同一个问题连测三次是 **86.2s / 138.7s / 224.9s**，而 224.9s 那一轮是
         * **11 步零猜测**（全是有线索的 Grep/Read）、86.2s 那轮 7 步 —— 墙钟根本
         * 区分不了"失控"和"慢但正确"，120s 又正好压在中位数上，等于一半概率假红。
         * 慢的根因是已知的 §3-13（云端语义检索没有阈值、返回的碎片没有出处，模型只能
         * 自己读大表汇总），跨仓库改 webpage 才治得了，不是走查这一步该抗的东西。
         *
         * 所以改成直接判那三个**失控行为**本身；墙钟照旧打印（含 60 秒达标行）供人看，
         * 另留一条 300s 的真·失控线兜底。
         */
        const zeroGuessN = zeroGuess.length
        const rejectedN = scans.length - allowed.length // 只用于打印，不判失败（见上）
        const searchN = g0.filter((s) => s.tool === 'search_knowledge').length
        if (zeroGuessN >= 2)
          throw new Error(`第一问出现 ${zeroGuessN} 次猜测式 0 命中扫描：${zeroGuess.map((s) => s.args?.pattern ?? s.args?.glob ?? '').join(' / ')}`)
        // 撞护栏**不判失败**：本轮实测 5 次扫描全部有命中（22/4/42/7/1），
        // 只是查得细，不是瞎试。真正的失控特征是"零命中猜测"，上面那条已经在管了。
        // 次数照旧打印在 `被护栏拒绝` 里给人看。
        if (searchN > 3) throw new Error(`第一问检索了 ${searchN} 次（提示词规定最多 3 次）`)
        if (durMs > 300000) throw new Error(`第一问耗时 ${(durMs / 1000).toFixed(1)}s，真失控了`)
      }

      // ---- 51 验证性扫描：检索 0 命中 → 「正在确认正文里有没有「X」」/「已确认文件名里没有「X」」 ----
      //
      // 怎么**确定性**地造出 0 命中：登录态下 search_knowledge 先走云端语义检索，
      // 而语义检索没有相似度阈值（migration 012 的 RPC 只有 order+limit），
      // 库里只要有东西就一定返回 6 条，问什么都不会是 0。
      // 所以把 apiBaseUrl 临时指到一个 404 前缀 —— searchCloud 拿到非 2xx 回 null，
      // 走产品自己的「回退本地全文检索」那条路，本地检索一个不存在的词才真是 0 命中。
      // 用 404 而不是黑洞地址：传输层失败会点亮「云端离线」条，糊在后面每一张截图上。
      {
        const apiBase0 = (await win.evaluate(() => window.api.settings.get())).apiBaseUrl
        await win.evaluate((u) => window.api.settings.setApiBase(u), `${apiBase0}/e2e-force-local-search`)
        try {
          /**
           * 问一件**库里绝对没有、而且拆不出真词**的事。
           *
           * 踩了两次才明白：检索 0 命中好造（本地检索兜底就行），难的是**紧接着那一遍扫描
           * 也得是 0**——模型会把问题拆成关键词做 `A|B|C` 的 Grep，只要有一个词在库里真有，
           * 那一步就（正确地）回到「核对了 1 份…」，`已确认…没有…` 那句就出不来。
           *   - 「南极科考队后勤预算」→ 拆出「后勤」，命中 1
           *   - 「磷虾捕捞配额」→ 拆出「配额」，命中 1
           * 所以要用一个**没有业务语义、拆不开**的专名。
           */
          const ABSENT = [
            '库里有没有霍格沃茨的资料？',
            '库里有没有文件名里带「霍格沃茨」的笔记？直接按文件名找。',
          ]
          let running = null
          let doneVerify = null
          let rows = []
          let steps = []
          for (const q of ABSENT) {
            await win.locator('button[title="新对话"]').click()
            await win.waitForTimeout(600)
            await armSteps()
            await chatInput.fill(q)
            await chatInput.press('Enter')

            // 认 `data-verify` 而不是 `kind==='verify'`：扫到东西时 kind 会（正确地）变回 scan。
            // 先等这一轮真的动起来，否则第一圈就因为"停止按钮还没出现"直接 break 掉
            await win.locator('[data-testid="step-item"]').first().waitFor({ timeout: 180000 }).catch(() => {})
            for (let i = 0; i < 3000; i++) {
              const now = await stepRows()
              const v = now.find((r) => r.verify && r.status === 'running')
              if (v) {
                running = v
                break
              }
              if (!(await win.locator('button[title="停止生成"]').count())) break
              await win.waitForTimeout(60)
            }
            // 立刻截，一毫秒都别等：验证性扫描往往 100ms 内就回来了，
            // 等一下截到的就是它**完成之后**那一帧（2026-08-18 实测，基线因此失真）
            if (running) await snap('51-步骤流-确认库中没有', 0)
            await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {})

            steps = (await rawStepGroups()).pop() ?? []
            const searched = steps.find((s) => s.tool === 'search_knowledge')
            if (!searched || searched.count !== 0)
              throw new Error(
                `「${q}」没有制造出"检索 0 命中"（云端回退没生效？）：${JSON.stringify(steps.map((s) => [s.tool, s.count]))}`
              )
            const sum = win.locator('[data-testid="steps-summary"]').last()
            if (await sum.count()) await sum.click()
            rows = await stepRows()
            if (!rows.some((r) => r.verify))
              throw new Error(`「${q}」检索 0 命中之后没有任何一步被判成"验证性扫描"：` + JSON.stringify(rows))
            doneVerify = rows.find((r) => r.verify && /^已确认.*没有/.test(r.text))
            if (doneVerify || running) break
            console.log(`（「${q}」那一遍扫描真扫到了东西，换一个更刁钻的问法再试一次）`)
          }
          // 进行中那一帧极短（grep 往往 100ms 内就回来），抓不到不算失败——
          // 收尾那条「已确认…没有…」是同一个特性，截它一样算数
          // 收尾是「已确认…没有…」的话，用它覆盖一次：完成态是**静止**的，
          // 比抢那一帧进行中稳得多，基线截图要的就是稳
          if (doneVerify) await snap('51-步骤流-确认库中没有', 200)
          else if (!running)
            throw new Error('两种问法都没能让验证性扫描落到"确认没有"上，51 截不出来：' + JSON.stringify(rows))
          // 复读机回归（真人对照截图指出）：多条验证性扫描扫的是不同的东西
          // （正文 / 文件名 / 换个词），文案不许全都一模一样
          {
            const vs = rows.filter((x) => x.verify).map((x) => x.text)
            if (vs.length > 1 && new Set(vs).size === 1)
              throw new Error(`${vs.length} 条验证性扫描文案完全相同，像复读机：「${vs[0]}」`)
          }
          // 每一条验证性扫描的文案都必须是三种合法形态之一
          for (const r of rows.filter((x) => x.verify)) {
            if (!/^(正在确认.*有没有|已确认.*没有|核对了)/.test(r.text))
              throw new Error(`验证性扫描文案不对：「${r.text}」`)
          }

          assertScanRow(rows, steps)
          await assertNoToolNames('验证性扫描步骤流')
          console.log(
            '过程可见性 · 验证性扫描 ✓',
            JSON.stringify({
              抓到进行中: running?.text ?? null,
              收尾确认态: doneVerify?.text ?? null,
              全部步骤: rows.map((r) => r.text),
            })
          )
        } finally {
          await win.evaluate((u) => window.api.settings.setApiBase(u), apiBase0)
        }
      }

      // ---- 52 产物步骤的时长文案：两种形态都要真实截图，且都不是写死的 ----
      //
      // 形态一（无历史）：走查用的是全新 userData，usage/ 里还没有 make-docx 记录 →「内容较多时需要几分钟」
      // 形态二（有历史）：形态一跑完就落了一条真实 durationMs → 下一轮变成「通常约 X 秒」（X 来自中位数）
      {
        const ym = new Date().toISOString().slice(0, 7)
        const usageFile = join(userData, 'usage', `${ym}.jsonl`)
        const medianOf = (type) => {
          const rs = (existsSync(usageFile) ? readFileSync(usageFile, 'utf-8').split('\n').filter(Boolean) : [])
            .map((l) => JSON.parse(l))
            .filter((r) => r.taskType === type && r.durationMs > 0)
            .map((r) => r.durationMs)
            .sort((a, b) => a - b)
          if (!rs.length) return 0
          const m = rs.length >> 1
          return rs.length % 2 ? rs[m] : Math.round((rs[m - 1] + rs[m]) / 2)
        }
        if (medianOf('make-docx') > 0)
          throw new Error('跑到这里本不该有 make-docx 历史（走查是全新 userData），"无历史"那一形态造不出来了')

        /** 发一条产物请求，抓「正在生成…」那一行 */
        const askDoc = async (name) => {
          await win.locator('button[title="新对话"]').click()
          await win.waitForTimeout(600)
          await armSteps()
          await chatInput.fill(`把灰太太的情况整理成一份 Word 文档，文件名叫「${name}」，两三段就够。`)
          await chatInput.press('Enter')
          // 等**带上了格式**的那一帧：tool_use 刚开始时入参还在流，那一瞬只知道"在做文档"，
          // 拿到 format 之后才说得出「Word 文档」。截早了截到的是半成品文案
          let row = null
          for (let i = 0; i < 2000 && !row; i++) {
            row = (await stepRows()).find(
              (r) => r.kind === 'artifact' && r.status === 'running' && /正在生成 Word 文档/.test(r.text)
            )
            if (!row) await win.waitForTimeout(60)
          }
          return row
        }

        const noHistory = await askDoc('步骤流走查A')
        if (!noHistory) throw new Error('第一次做产物时没抓到"正在生成…"那一步（模型没调渲染工具？）')
        await snap('52-产物步骤-无历史时长', 0)
        if (!/正在生成 Word 文档（内容较多时需要几分钟）/.test(noHistory.text))
          throw new Error(`无历史时的时长文案不对：「${noHistory.text}」`)
        await assertNoToolNames('产物步骤（无历史）')
        await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 600000 }).catch(() => {})

        const median = medianOf('make-docx')
        if (!median) throw new Error('第一份文档跑完，用量里没有 make-docx 记录，"有历史"那一形态无从谈起')
        const withHistory = await askDoc('步骤流走查B')
        if (!withHistory) throw new Error('第二次做产物时没抓到"正在生成…"那一步')
        await snap('52b-产物步骤-有历史时长', 0)
        // 秒数必须**来自本机中位数**，不是写死的常量
        const want = `正在生成 Word 文档（通常约 ${Math.round(median / 1000)} 秒）`
        if (withHistory.text !== want)
          throw new Error(`有历史时的时长文案不对：期望「${want}」（中位数 ${median}ms），实得「${withHistory.text}」`)
        await assertNoToolNames('产物步骤（有历史）')
        await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 600000 }).catch(() => {})
        console.log(
          '过程可见性 · 产物时长两形态 ✓',
          JSON.stringify({ 无历史: noHistory.text, 有历史: withHistory.text, 中位数ms: median })
        )
      }

      // ---- 53 失败步骤要标出来（读一个不存在的文件）----
      // 这一步靠模型肯照做，抓不到就只报警不判失败：它不在硬断言清单里，
      // 而为了它去改产品加测试钩子，代价比收益大
      {
        await win.locator('button[title="新对话"]').click()
        await win.waitForTimeout(600)
        await armSteps()
        await chatInput.fill(`直接打开 ${vaultCopy}/根本不存在的笔记.md 这个文件，告诉我里面写了什么。`)
        await chatInput.press('Enter')
        let failedRow = null
        for (let i = 0; i < 400 && !failedRow; i++) {
          failedRow = (await stepRows()).find((r) => r.status === 'failed')
          if (!failedRow) await win.waitForTimeout(400)
        }
        if (failedRow) {
          await snap('53-步骤流-失败步骤', 200)
          if (!/这一步没成功/.test(failedRow.text)) throw new Error(`失败步骤没有标出来：「${failedRow.text}」`)
          if (/《根本不存在的笔记》/.test(failedRow.text)) sawReadTitle = failedRow.text
          await assertNoToolNames('失败步骤')
          console.log('过程可见性 · 失败步骤 ✓', JSON.stringify(failedRow))
        } else {
          console.log('⚠️ 没能造出失败的工具步骤（模型没照做），跳过 53（不算回归）')
        }
        await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {})
        // 展开看一眼，顺带把"阅读《…》"这条硬断言补上
        const sum = win.locator('[data-testid="steps-summary"]').last()
        if (await sum.count()) await sum.click()
        const readRow = (await stepRows()).find((r) => r.kind === 'read')
        const readEv = ((await rawStepGroups()).pop() ?? []).find((s) => s.tool === 'Read' && s.args?.file)
        if (readRow && readEv) {
          const title = readEv.args.file.split('/').pop().replace(/\.[a-z0-9]+$/i, '')
          if (!readRow.text.includes(`《${title}》`))
            throw new Error(`阅读步骤没有带出书名号文件名「《${title}》」：${readRow.text}`)
          sawReadTitle = readRow.text
        }
      }

      if (!sawReadTitle)
        throw new Error('整轮走查里一次都没验到「阅读《文件名》」这条步骤——阅读步骤的参数层没被覆盖')
      if (!sawScanCount)
        throw new Error('整轮走查里一次都没验到带数字的核对步骤——核对步骤的参数层没被覆盖')
      console.log('过程可见性 · 参数层覆盖 ✓', JSON.stringify({ 阅读: sawReadTitle, 核对: sawScanCount }))

      // ---- 46 会话恢复失败自动降级：拿一个**过期的 session id** 发消息，必须照常答上来 ----
      // 用户实测撞到的形态：在历史对话里发消息 → `No conversation found with session ID: …`。
      // 真实成因是 SDK 会话文件没了（换库改 cwd / 保留期清理 / 换机器），这里用伪造 id 等价复现。
      // 断言的重点不是"没报错"，而是**上下文真的被拼回去了**——所以先让它记一个数字再问。
      {
        await win.locator('button[title="新对话"]').click()
        await win.waitForTimeout(600)
        await chatInput.fill('记住这个数字：4271。只回复"记住了"，不要检索知识库，不要调用任何工具。')
        await chatInput.press('Enter')
        await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {})

        const conv = await win.evaluate(async () => {
          const [c] = await window.api.chat.list()
          return c ? { id: c.id, sdk: c.sdkSessionId, n: c.messages.length } : null
        })
        if (!conv?.sdk) throw new Error(`第一轮没拿到 sdkSessionId，伪造过期会话无从谈起：${JSON.stringify(conv)}`)

        // 伪造：格式合法但 SDK 侧根本不存在的 id。走的是和真实故障完全相同的那条错误路径
        const GHOST = 'a1b2c3d4-1111-4222-8333-444455556666'
        const sent = await win.evaluate(
          ([id, ghost]) =>
            window.api.chat.send(id, '刚才让你记的数字是多少？只回数字本身，不要检索知识库。', ghost, 'standard'),
          [conv.id, GHOST]
        )
        if (sent?.ok === false) throw new Error('伪造会话那条消息主进程没收：' + JSON.stringify(sent))

        // 必须以**发之前的条数**为基线等新消息。直接取"最后一条 assistant"会立刻拿到
        // 上一轮那句「记住了」，断言就变成了拿第一轮的回答去验第二轮（第一版就是这么假失败的）
        let last = null
        for (let i = 0; i < 240 && !last; i++) {
          await win.waitForTimeout(1000)
          last = await win.evaluate(
            async ([id, base]) => {
              const c = (await window.api.chat.list()).find((x) => x.id === id)
              if (!c || c.messages.length <= base) return null
              const m = c.messages[c.messages.length - 1]
              return m.role === 'assistant' ? { text: m.text, error: !!m.error } : null
            },
            [conv.id, conv.n]
          )
        }
        if (!last) throw new Error('过期 session 发消息后 4 分钟没有任何回答（降级重发没生效？）')
        // ① 不许报错——这是这一单的全部意义：上游那句英文原文不该再有机会抵达用户
        if (last.error || /No conversation found|session/i.test(last.text))
          throw new Error(`过期 session 仍然把错误抛给了用户：${last.text.slice(0, 160)}`)
        // ② 上下文真的接上了：答得出第一轮记的数字，才证明历史被拼进了新会话
        if (!last.text.includes('4271'))
          throw new Error(`降级重开后上下文没接上（期望含 4271）：${last.text.slice(0, 160)}`)
        // ③ 短对话是**无损**恢复，不该打扰用户——那条提示只在历史超预算被截时才出现
        const noticed = await win.locator('[data-testid="toast"]:has-text("已开始新的会话")').count()
        if (noticed) throw new Error('短对话无损恢复却弹了"较早的上下文可能不被记住"提示')
        // ④ 降级必须在日志里留痕（"用户无感"不等于"运维也看不见"）
        const logs = readFileSync(join(userData, 'logs', 'main.log'), 'utf-8')
        if (!logs.includes('在 SDK 侧已不存在'))
          throw new Error('日志里没有降级记录：走的可能根本不是恢复路径')
        await snap('46-会话恢复降级-照常回答', 600)
        console.log('会话恢复降级 ✓', JSON.stringify({ 伪造id: GHOST.slice(0, 8), 回答: last.text.replace(/\s+/g, ' ').slice(0, 40) }))
      }

      // ---- H-09 停止留半截 + H-10 生成中重复发送被拒 ----
      {
        await chatInput.fill('把灰太太的情况尽量详细地展开讲讲，分点写，越长越好')
        await chatInput.press('Enter')
        // 等正文真的开始往外吐（要有半截可留）。
        // 不用 waitFor(visible)：检索阶段 draft 可能只有一个换行，`.streaming-body` 里是个
        // 空段落、高度为 0，Playwright 判定为 hidden，会一直等到超时（实测踩过）
        const norm = (s) => s.replace(/\s+/g, '')
        let half = ''
        const tStream = Date.now()
        while (Date.now() - tStream < 240000 && norm(half).length < 24) {
          half = await win.evaluate(() => document.querySelector('.streaming-body')?.textContent ?? '')
          if (norm(half).length < 24) await win.waitForTimeout(500)
        }
        if (norm(half).length < 10) {
          const st = await win.evaluate(async () => {
            const s = await window.api.tasks.list()
            return s.tasks
              .filter((t) => t.kind === 'agent')
              .map((t) => ({ status: t.status, draftLen: t.draft?.length ?? 0, title: t.title }))
          })
          throw new Error('流式正文迟迟没出来，H-09 没得可停：' + JSON.stringify(st))
        }
        const head = norm(half).slice(0, 10)

        // ① 主进程侧的权威拒绝：同一 session 已在流式中，第二条必须被拒
        const convId = await win.evaluate(async () => {
          const s = await window.api.tasks.list()
          return s.tasks.find((t) => t.kind === 'agent' && t.status === 'running')?.key ?? null
        })
        if (!convId) throw new Error('拿不到正在生成的 agent 任务（H-10 断言无从谈起）')
        const rejected = await win.evaluate((id) => window.api.chat.send(id, '插队的第二条'), convId)
        if (rejected?.ok !== false || rejected.reason !== 'busy')
          throw new Error('生成中重复发送竟然被接受了：' + JSON.stringify(rejected))
        console.log('H-10 主进程拒绝 ✓', JSON.stringify(rejected))

        // ② 界面侧：照常敲 Enter，应当出现带「停止当前生成」动作按钮的提示，且输入不被清空
        await chatInput.fill('生成中再发一条')
        await chatInput.press('Enter')
        await win.locator('[data-testid="toast-action"]').waitFor({ timeout: 8000 })
        const toastText = await win.locator('[data-testid="toast"]').last().innerText()
        const actionLabel = await win.locator('[data-testid="toast-action"]').last().innerText()
        if (!/生成中/.test(toastText)) throw new Error(`拒绝提示文案不对：「${toastText}」`)
        if (!/停止当前生成/.test(actionLabel)) throw new Error(`提示上没有出口按钮：「${actionLabel}」`)
        if ((await chatInput.inputValue()) !== '生成中再发一条')
          throw new Error('被拒之后输入框内容被清掉了（用户白打一遍）')
        await snap('35-生成中重复发送-拒绝并给出口', 100)
        console.log('H-10 拒绝 + 出口 ✓', JSON.stringify({ toastText, actionLabel }))

        // ③ 点提示上的「停止当前生成」= H-09：半截回答要落进对话并带「（已停止）」尾标
        await win.locator('[data-testid="toast-action"]').last().click()
        await win.locator('text=（已停止）').first().waitFor({ timeout: 30000 })
        // abort 传播到 SDK 需要几秒，停止按钮随之消失（进行中状态收干净）
        await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 60000 })
        // 再等一会儿：停止之后**不能**再补一条完整答案上来（那等于根本没停成）
        await win.waitForTimeout(3000)
        const lastMsg = await win.locator('.md-article').last().innerText()
        if (!lastMsg.includes('（已停止）')) throw new Error(`半截回答没带尾标：「${lastMsg.slice(-60)}」`)
        if (!norm(lastMsg).includes(head))
          throw new Error(`留下的不是刚才那段半截正文：期望含「${head}」，实得「${lastMsg.slice(0, 60)}」`)
        await snap('36-停止生成-半截回答留在对话里', 300)
        console.log('H-09 停止留半截 ✓', JSON.stringify({ head, 长度: lastMsg.length }))
      }
    }
    // ---- M-11 AI 出错要能一键重试：复用上一条 user 消息重发，且不把提问复制成两条 ----
    //
    // 增强档的失败**怎么造**，两种模式已经不一样了（2026-08-18 修）：
    //  - 本地模式：增强档确实没有 key → 主进程预检 `bail` → **同步**错误。这是竞态最宽的
    //    那条窗口（错误抢在 React 提交用户消息之前到达），仍然由这一轮守着
    //  - `E2E_CHAT`：登录之后增强档**是有 key 的**——2026-08-17 起没配独立 key 会回落到
    //    共享密钥（45e）。"增强档没 key 所以必然快速失败"这个前提就此消失，旧写法会在这里
    //    干等 30 秒等不到错误气泡（实测卡死在这，整轮 E2E_CHAT 跑不到终点）。
    //    **不能靠"测试环境别下发共享密钥"来复原**——那是为测试削产品。
    //    改成把**增强档的地址**临时指到一个秒回 401 的本地桩：失败照样确定、只要几秒、零 token，
    //    产品侧一行不动，跑完立刻还原（同 41c 已经验证过的手法）
    {
      await win.click('button[title="新对话"]')
      await win.waitForTimeout(500)
      await win.click('[data-testid="tier-selector"]')
      await win.locator('[data-testid="tier-option-enhanced"]').click()
      await win.waitForTimeout(400)
      if ((await win.locator('[data-testid="tier-selector"]').getAttribute('data-tier')) !== 'enhanced')
        throw new Error('点了增强档但选择器没切过去')
      await snap('45c-档位选择器-已切到增强', 200)

      // 桩要在**选完档位之后**才架：健康探针的结论缓存 5 分钟，先坏地址会让选择器直接置灰
      let enhStub = null
      let enhOrigBase = null
      if (CHAT) {
        const { createServer: createHttpServer } = await import('http')
        enhStub = createHttpServer((_req, res) => {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'e2e 模拟增强档失败' } }))
        })
        await new Promise((r) => enhStub.listen(0, '127.0.0.1', r))
        enhOrigBase = await win.evaluate(async () => {
          const r = await window.api.ai.tiers()
          return r.tiers.find((t) => t.id === 'enhanced').baseUrl
        })
        await win.evaluate(
          (port) => window.api.ai.setTierConfig('enhanced', { baseUrl: `http://127.0.0.1:${port}` }),
          enhStub.address().port
        )
        console.log('增强档临时指到 401 桩', JSON.stringify({ 原地址: enhOrigBase, 桩端口: enhStub.address().port }))
      }
      // 本地模式是同步 bail（毫秒级）；CHAT 模式要真发一次请求再收 401，给足余量
      const ERR_WAIT = CHAT ? 180000 : 30000

      await chatInput.fill('M-11 重试走查：这条一定会失败')
      await chatInput.press('Enter')
      await win.locator('[data-testid="retry-answer"]').waitFor({ timeout: ERR_WAIT })
      const errText1 = await win.locator('.md-article').last().innerText()
      if (!errText1.includes('⚠️')) throw new Error(`错误没有落成气泡：「${errText1}」`)

      // ---- T-02：一次失败**有且只有一条**错误气泡，且是中文 ----
      // 修之前上游 401 会出两条：先一条 `Failed to authenticate. API Error: 401 …`
      // （`subtype:'success'` + `is_error:true`，被当成 AI 的正常回答画出来），再一条 ⚠️。
      // 两种模式都要守：本地模式走预检 bail，CHAT 模式走 401 桩——正是 T-02 的原型场景。
      // 多等一拍再数：抛出来的那条 ⚠️ 比 result 晚到，只数一次可能刚好卡在中间
      await win.waitForTimeout(1500)
      const t02 = await win.evaluate(async () => {
        const c = (await window.api.chat.list())[0]
        return {
          msgs: c.messages.length,
          assistants: c.messages.filter((m) => m.role === 'assistant').map((m) => ({ err: !!m.error, text: m.text })),
        }
      })
      if (t02.assistants.length !== 1 || t02.msgs !== 2)
        throw new Error(
          `一次失败应当只出一条错误气泡（T-02）：${JSON.stringify({ ...t02, assistants: t02.assistants.map((a) => ({ ...a, text: a.text.slice(0, 90) })) })}`
        )
      if (!t02.assistants[0].err)
        throw new Error(`那一条没被标成错误气泡（拿不到「重试」）：${t02.assistants[0].text.slice(0, 90)}`)
      // 中文化：上游英文原文不许出现在界面上（"AI"这类两字母缩写不算，所以门槛设 5 个字母）
      const leaked = t02.assistants[0].text.match(/[A-Za-z]{5,}/g)
      if (leaked)
        throw new Error(`错误气泡里漏出了上游英文原文（T-02）：${leaked.join('/')} ←「${t02.assistants[0].text.slice(0, 120)}」`)
      console.log('T-02 一次失败一条中文气泡 ✓', JSON.stringify({ 条数: t02.msgs, 文案: t02.assistants[0].text.slice(0, 40) }))
      // 预检失败的错误是**同步**发回来的，抢在 React 提交用户那条消息之前——
      // 旧代码那一下会把刚发出去的提问整条盖掉（历史里只剩一条 ⚠️，重试也就无从谈起）
      const userBubbles = await win.evaluate(
        () => [...document.querySelectorAll('.max-w-3xl > div')].filter((b) => b.className.includes('justify-end')).length
      )
      if (userBubbles !== 1) throw new Error(`发出去的提问没留在历史里：user 气泡 ${userBubbles} 个`)
      /**
       * 错误气泡的**红边**（三期：语义底色只留给持续存在的状态，错误回答会一直留在历史里）。
       * 断言取 computed style 与 token 比，不认"class 里有 border-danger"——
       * Tailwind 类名写对了但 token 没接上是最容易糊过去的一种（`bg-x/60` 那类坑）。
       */
      const eb = await win.evaluate(() => {
        const el = document.querySelector('[data-testid="error-bubble"]')
        if (!el) return null
        const cs = getComputedStyle(el)
        const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
        const hex2rgb = (h) => {
          const m = h.replace('#', '')
          return `rgb(${parseInt(m.slice(0, 2), 16)}, ${parseInt(m.slice(2, 4), 16)}, ${parseInt(m.slice(4, 6), 16)})`
        }
        return {
          borderLeft: cs.borderLeftWidth,
          color: cs.borderLeftColor,
          bg: cs.backgroundColor,
          wantColor: hex2rgb(css('--color-danger')),
          wantBg: hex2rgb(css('--color-danger-soft')),
        }
      })
      if (!eb) throw new Error('错误气泡没有 error-bubble 容器（红边没画）')
      if (parseFloat(eb.borderLeft) < 2) throw new Error(`错误气泡左边框太细：${eb.borderLeft}`)
      if (eb.color !== eb.wantColor) throw new Error(`错误气泡边色 ${eb.color} 与 --color-danger 对不上`)
      if (eb.bg !== eb.wantBg) throw new Error(`错误气泡底色 ${eb.bg} 与 --color-danger-soft 对不上`)
      console.log('错误气泡红边 ✓', JSON.stringify(eb))
      await snap('41-AI出错-气泡内重试按钮', 200)

      // 重试前后消息条数必须一样：只数"提问几条/重试按钮几个"抓不住"每重试一次多堆一条
      // 原始错误正文"（SDK 出错时先吐 result 再抛异常，走查截图抓到过）
      const msgsBefore = await win.evaluate(async () => (await window.api.chat.list())[0].messages.length)
      // 点重试：错误气泡就地换掉、提问只留一条（重发不是"再打一遍"）。
      // 「确实重发过」用 MutationObserver 抓那一瞬间的"错误气泡消失过"——重试前后两条
      // 错误消息的 DOM 长得一模一样，只对比最终态区分不出"真重发"和"什么都没发生"
      await win.evaluate(() => {
        window.__m11Gone = 0
        new MutationObserver(() => {
          if (!document.querySelector('[data-testid="retry-answer"]')) window.__m11Gone++
        }).observe(document.body, { subtree: true, childList: true })
      })
      await win.click('[data-testid="retry-answer"]')
      await win.waitForTimeout(1200)
      await win.locator('[data-testid="retry-answer"]').waitFor({ timeout: ERR_WAIT })
      const gone = await win.evaluate(() => window.__m11Gone)
      if (!gone) throw new Error('点了重试，错误气泡从没被撤掉过（这次重发根本没发生）')
      const counts = await win.evaluate(() => {
        const bubbles = [...document.querySelectorAll('.max-w-3xl > div')]
        return {
          user: bubbles.filter((b) => b.className.includes('justify-end')).length,
          err: document.querySelectorAll('[data-testid="retry-answer"]').length,
        }
      })
      if (counts.user !== 1) throw new Error(`重试把用户的提问复制成了 ${counts.user} 条`)
      if (counts.err !== 1) throw new Error(`重试后错误气泡堆成了 ${counts.err} 条（旧的没撤掉）`)
      const msgsAfter = await win.evaluate(async () => (await window.api.chat.list())[0].messages.length)
      if (msgsAfter !== msgsBefore)
        throw new Error(`重试让消息条数变了：${msgsBefore} → ${msgsAfter}（失败那轮的残留没清干净）`)
      await snap('41b-AI出错-重试后不重复提问', 200)
      console.log('M-11 错误重试 ✓', JSON.stringify({ ...counts, 气泡撤掉次数: gone }))

      // ---- 增强档失败时的出口：气泡里除了「重试」还要有「切换到标准模式重试」----
      if (!(await win.locator('[data-testid="retry-standard"]').count()))
        throw new Error('增强档出错时没有「切换到标准模式重试」的引导')
      await snap('45d-增强档出错-切标准重试引导', 200)

      // ---- 档位按会话记忆：新会话回到标准，切回刚才那个会话仍然是增强 ----
      const failedTitle = (await win.locator('aside div.group button').first().innerText()).trim()
      await win.click('button[title="新对话"]')
      await win.waitForTimeout(600)
      if ((await win.locator('[data-testid="tier-selector"]').getAttribute('data-tier')) !== 'standard')
        throw new Error('新会话没有回到标准档（档位不该跨会话粘住）')
      await win.locator(`aside button:has-text("${failedTitle.slice(0, 8)}")`).first().click()
      await win.waitForTimeout(600)
      if ((await win.locator('[data-testid="tier-selector"]').getAttribute('data-tier')) !== 'enhanced')
        throw new Error('切回旧会话后档位没记住（会话级记忆失效）')
      // 主进程侧也认账：档位随会话一起落盘
      const savedTier = await win.evaluate(async () => {
        const list = await window.api.chat.list()
        return list.find((c) => c.messages.some((m) => m.text.includes('M-11 重试走查')))?.tier ?? null
      })
      if (savedTier !== 'enhanced') throw new Error(`会话档位没落盘：${savedTier}`)
      console.log('档位按会话记忆 ✓', JSON.stringify({ 失败会话: failedTitle, 落盘: savedTier }))

      // ---- 那颗「切换到标准模式重试」真点一次：出口得能走通，不能只是长在那儿 ----
      // 顺带把失败的 agent 任务收干净：本地模式的 `bail` 走的是 `tasks.drop`（Dock 上不留痕），
      // 而 CHAT 模式这两轮是真失败（`tasks.finish('failed')`），会在 Dock 上挂 30 分钟
      // （`RECENT_TTL_MS`，且按钮文案里失败优先于「N 条待同步」），不收的话后面 41e 与 M-03
      // 的断言会被它挡掉——这正是走查历史上踩过的坑。**必须放在档位记忆断言之后**：
      // 换档重试会把会话的档位记忆改成 standard，先点就把上面那条验没了
      if (CHAT) {
        enhStub.close()
        await win.evaluate((b) => window.api.ai.setTierConfig('enhanced', { baseUrl: b }), enhOrigBase)
        const restoredEnh = await win.evaluate(async () => {
          const r = await window.api.ai.tiers()
          return r.tiers.find((t) => t.id === 'enhanced').baseUrl
        })
        if (restoredEnh !== enhOrigBase) throw new Error(`增强档地址没还原：${restoredEnh}`)
        await win.click('[data-testid="retry-standard"]')
        await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {})
        const switched = await win.evaluate(async (title) => {
          const c = (await window.api.chat.list()).find((x) => x.title.startsWith(title.slice(0, 8)))
          return { tier: c?.tier, msgs: c?.messages.length, hasErr: c?.messages.some((m) => m.error) }
        }, failedTitle)
        if (switched.hasErr) throw new Error('切到标准模式重试之后仍然是错误：' + JSON.stringify(switched))
        if (switched.tier !== 'standard') throw new Error(`换档重试没把会话档位改过来：${switched.tier}`)
        if (switched.msgs !== 2)
          throw new Error(`换档重试后应当只剩「提问 + 回答」两条：${JSON.stringify(switched)}`)
        const stillFailed = await win.evaluate(async () => {
          const s = await window.api.tasks.list()
          return s.tasks.filter((t) => t.kind === 'agent' && t.status === 'failed').map((t) => t.title)
        })
        if (stillFailed.length)
          throw new Error('增强档那两轮失败没被收干净，会挡掉后面的断言：' + JSON.stringify(stillFailed))
        console.log('45d 出口真点一次 ✓', JSON.stringify({ ...switched, 还原地址: restoredEnh }))
      }

      // 回到标准档再往下走，别把后面的步骤带偏
      await win.click('button[title="新对话"]')
      await win.waitForTimeout(400)

      // ---- 同一条路的**异步**分支：错误不是预检 bail，而是真的发起了请求之后才失败 ----
      // key 是好的（过得了预检）、地址指到 127.0.0.1:9（连接被拒），于是 chat:send 已经回执 ok、
      // 任务也建起来了，错误在之后才异步到达——这正是"提问被错误消息盖掉"那条竞态最宽的窗口。
      // 只有 E2E_CHAT 跑得到：本地模式压根没有 key，走的是预检那条短路
      if (CHAT) {
        // 用一个**秒回 401** 的本地桩当端点，而不是"连接被拒"的端口 9：
        // ECONNREFUSED 会让 SDK 一路重试退避，实测单次要 2~4 分钟（第一版走查就是这么超时的）；
        // 401 属于不重试的 4xx，请求发出去就立刻失败——同样是"过了预检之后才出错"，但只要几秒
        const { createServer: createHttpServer } = await import('http')
        const stub = createHttpServer((_req, res) => {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'e2e 模拟鉴权失败' } }))
        })
        await new Promise((r) => stub.listen(0, '127.0.0.1', r))
        const stubPort = stub.address().port
        const origBase = await win.evaluate(async () => {
          const r = await window.api.ai.tiers()
          return r.tiers.find((t) => t.id === 'standard').baseUrl
        })
        await win.click('button[title="新对话"]')
        await win.waitForTimeout(400)
        await win.evaluate(
          (port) => window.api.ai.setTierConfig('standard', { baseUrl: `http://127.0.0.1:${port}` }),
          stubPort
        )
        await chatInput.fill('M-11 异步出错走查：这一条连不上服务器')
        await chatInput.press('Enter')
        // 任务先建起来（说明过了预检、错误确实来自请求链路），再等错误落成气泡
        await win.locator('button[title="停止生成"]').waitFor({ timeout: 20000 }).catch(() => {})
        await win.locator('[data-testid="retry-answer"]').waitFor({ timeout: 180000 })
        const async1 = await win.evaluate(() => ({
          user: [...document.querySelectorAll('.max-w-3xl > div')].filter((b) => b.className.includes('justify-end')).length,
          err: document.querySelectorAll('[data-testid="retry-answer"]').length,
        }))
        if (async1.user !== 1)
          throw new Error(`异步出错时提问被盖掉了：user 气泡 ${async1.user} 个（竞态回归）`)
        await snap('41c-流式出错-提问仍在且可重试', 200)
        // 重试同样走真实请求链路：还是 401，但提问不许被复制、失败那轮的残留不许越堆越多
        const asyncMsgsBefore = await win.evaluate(async () => (await window.api.chat.list())[0].messages.length)
        await win.evaluate(() => {
          window.__m11bGone = 0
          new MutationObserver(() => {
            if (!document.querySelector('[data-testid="retry-answer"]')) window.__m11bGone++
          }).observe(document.body, { subtree: true, childList: true })
        })
        await win.click('[data-testid="retry-answer"]')
        await win.locator('[data-testid="retry-answer"]').waitFor({ timeout: 180000 })
        const async2 = await win.evaluate(() => ({
          gone: window.__m11bGone,
          user: [...document.querySelectorAll('.max-w-3xl > div')].filter((b) => b.className.includes('justify-end')).length,
          err: document.querySelectorAll('[data-testid="retry-answer"]').length,
        }))
        if (!async2.gone) throw new Error('异步出错时点重试，错误气泡从没被撤掉过（重发没发生）')
        if (async2.user !== 1) throw new Error(`重试把提问复制成了 ${async2.user} 条`)
        if (async2.err !== 1) throw new Error(`重试后错误气泡堆成了 ${async2.err} 条`)
        const asyncMsgsAfter = await win.evaluate(async () => (await window.api.chat.list())[0].messages.length)
        if (asyncMsgsAfter !== asyncMsgsBefore)
          throw new Error(
            `异步出错重试让消息条数变了：${asyncMsgsBefore} → ${asyncMsgsAfter}（SDK 先吐的那条原始错误正文没被清掉）`
          )
        await snap('41d-流式出错-重试后不重复提问', 200)
        console.log('M-11 异步出错分支 ✓', JSON.stringify({ 首次: async1, 重试后: async2 }))

        // 端点恢复后再点一次重试：这次必须真的拿到回答。
        // 这条不只是"锦上添花"——失败的 agent 任务会一直挂在 Dock 上（按钮文案里失败优先于
        // 「N 条待同步」），不收干净的话后面 M-03 的可见性断言会被它挡掉
        stub.close()
        await win.evaluate((b) => window.api.ai.setTierConfig('standard', { baseUrl: b }), origBase)
        await win.waitForTimeout(300)
        const restored = await win.evaluate(async () => {
          const r = await window.api.ai.tiers()
          return r.tiers.find((t) => t.id === 'standard').baseUrl
        })
        if (restored !== origBase) throw new Error(`base URL 没还原：${restored}`)
        await win.click('[data-testid="retry-answer"]')
        await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {})
        const healed = await win.evaluate(async () => {
          const c = (await window.api.chat.list())[0]
          return {
            msgs: c.messages.length,
            hasErr: c.messages.some((m) => m.error),
            last: (c.messages[c.messages.length - 1]?.text ?? '').slice(0, 30),
          }
        })
        if (healed.hasErr) throw new Error('端点恢复后重试仍然是错误：' + JSON.stringify(healed))
        if (healed.msgs !== 2) throw new Error(`恢复后的对话应当只剩「提问 + 回答」两条：${JSON.stringify(healed)}`)
        await snap('41e-出错重试-端点恢复后成功', 300)
        // Dock 上不能再挂着「AI 回答出错」
        const dockAfter = await win.evaluate(async () => {
          const s = await window.api.tasks.list()
          return s.tasks.filter((t) => t.status === 'failed').map((t) => t.title)
        })
        if (dockAfter.length) throw new Error('重试成功后仍有失败任务残留：' + JSON.stringify(dockAfter))
        console.log('M-11 恢复后重试成功 ✓', JSON.stringify(healed))
      }
    }

    // ＋新对话必须复位：空态问候可见 + 输入框清空（回归 2026-07-16 用户报障）
    await win.click('button[title="新对话"]')
    await win.waitForTimeout(500)
    const emptyOk = await win.locator('text=问你的库，或直接说要做什么').count()
    const inputVal = await win.locator('textarea').first().inputValue()
    if (!emptyOk || inputVal !== '') throw new Error(`＋新对话未复位：空态=${emptyOk} 输入残留="${inputVal}"`)
    await snap('01d2-新对话复位', 300)
  }

  // 知识库页
  await win.click('text=个人知识库')
  await snap('02-知识库-默认大图谱', 2500)
  await assertNoOldBrand('个人知识库')
  await assertNoRose('个人知识库')

  // 文件树默认宽度收窄到 ~220px（第二轮精修项）
  const treeW0 = await win.locator('[data-testid="tree-col"]').evaluate((el) => el.offsetWidth)
  if (treeW0 < 200 || treeW0 > 240) throw new Error(`文件树默认宽度不是 ~220px：${treeW0}`)
  console.log('文件树默认宽度 ✓', treeW0)

  // 展开树 + 点开一篇笔记
  const dirBtn = win.locator('button:has-text("▸")').first()
  if (await dirBtn.count()) {
    await dirBtn.click()
    await snap('03-树展开', 400)
  }
  // 点开达人档案里的笔记（maggie 库）或任意叶子
  const leaf = win.locator('button.block.truncate').first()
  if (await leaf.count()) {
    await leaf.click()
    await snap('04-笔记打开-图谱缩小', 1200)
    // 头部操作：编辑常驻，重命名/删除收进 ···
    if (await win.locator('button:has-text("重命名")').count()) throw new Error('重命名没收进 ··· 菜单')
    if (!(await win.locator('button:has-text("编辑")').count())) throw new Error('笔记头部缺「编辑」按钮')
    await win.click('button[title="更多操作"]')
    await win.waitForTimeout(300)
    const menuItems = await win.locator('[role="menuitem"]').allInnerTexts()
    if (!menuItems.includes('重命名') || !menuItems.includes('删除'))
      throw new Error('··· 菜单项不对：' + JSON.stringify(menuItems))
    await snap('04b-笔记头部-更多菜单', 200)
    // 删除必须二次确认，且弹窗里要看得见是哪一个文件
    await win.locator('[role="menuitem"]:has-text("删除")').click()
    await win.locator('text=确认删除这篇笔记？').waitFor({ timeout: 5000 })
    const confirmText = await win.locator('.whitespace-pre-line').first().innerText()
    if (!confirmText.includes('.md')) throw new Error(`删除确认弹窗没显示文件名：「${confirmText}」`)
    await snap('04c-删除二次确认', 200)
    await win.click('button:has-text("取消")')
    await win.waitForTimeout(300)
    if (!(await win.locator('button[title="关闭文件"]').count())) throw new Error('取消删除后笔记被关掉了')
    console.log('笔记头部 ··· / 删除确认 ✓', JSON.stringify({ menuItems, confirmText: confirmText.split('\n')[0] }))
  }

  // 应用内弹窗（替代系统 prompt 的验证）＋ 新建→删除的完整危险路径
  await win.click('button[title="新建笔记"]')
  await snap('03b-应用内弹窗', 500)
  await win.fill('input[placeholder="笔记名称"]', 'e2e待删除笔记')
  await win.click('button:has-text("确定")')
  await win.locator('text=e2e待删除笔记').first().waitFor({ timeout: 8000 })
  await win.click('button[title="更多操作"]')
  await win.locator('[role="menuitem"]:has-text("删除")').click()
  await win.locator('text=确认删除这篇笔记？').waitFor({ timeout: 5000 })
  await win.click('button:has-text("删除")')
  await win.locator('text=可在废纸篓找回').waitFor({ timeout: 5000 })
  await snap('03c-删除完成toast', 200)
  await grabToastGeo('删除笔记(info)')
  await win.waitForTimeout(1200)
  if (await win.locator('button.block.truncate:has-text("e2e待删除笔记")').count())
    throw new Error('删除后文件树里还留着这篇笔记')
  console.log('新建 → ··· → 删除（含二次确认）✓')

  // ---- H-11 搜索三态 + M-13 结果计数 ----
  // 旧版是 `hits.length > 0 ? 结果 : <Tree/>`：搜一个库里没有的词，左栏显示整棵文件树，
  // 和没搜一样——用户只会以为搜索框坏了。检索期间也没有加载态。
  {
    // 未搜索态：文件树在，计数/空态都不该出现
    if (await win.locator('[data-testid="search-count"], [data-testid="search-empty"]').count())
      throw new Error('还没搜索就出现了搜索结果态')
    // 检索中：探针先跑起来再输入（探针内部会 await，React 有机会渲染），
    // 断言"输入框有词之后，左栏一次都不许再出现文件树叶子"——这正是 H-11 的病灶
    const probe = win.evaluate(async () => {
      const seen = { loading: false, treeWhileSearching: false }
      for (let i = 0; i < 200; i++) {
        const q = document.querySelector('input[placeholder="搜索库…"]')?.value ?? ''
        if (q) {
          if (document.querySelector('[data-testid="search-loading"]')) seen.loading = true
          if (document.querySelectorAll('[data-testid="tree-col"] button.block.truncate').length)
            seen.treeWhileSearching = true
          if (document.querySelector('[data-testid="search-count"]')) break
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      return seen
    })
    await win.fill('input[placeholder="搜索库…"]', '灰太太')
    const seen = await probe
    if (seen.treeWhileSearching) throw new Error('有搜索词时左栏还在显示整棵文件树（H-11 的病灶）')
    if (!seen.loading) throw new Error('搜索期间没有出现「检索中…」加载态')
    console.log('H-11 检索中/不落回文件树 ✓', JSON.stringify(seen))
  }
  await snap('05-搜索结果', 2500)
  // M-13：结果头部要有「N / 共 M 条」（列表静默截断到 20 条，不给总数就分不清"只有这些"和"还有更多"）
  if (await win.locator('[data-testid="search-count"]').count()) {
    const countText = await win.locator('[data-testid="search-count"]').innerText()
    const m = /^(\d+)\s*\/\s*共\s*(\d+)\s*条/.exec(countText.replace(/\s+/g, ' ').trim())
    if (!m) throw new Error(`搜索结果头部没有「N / 共 M 条」计数：「${countText}」`)
    const shown = await win.locator('[data-testid="tree-col"] .line-clamp-2').count()
    if (Number(m[1]) !== shown) throw new Error(`计数与实际条数对不上：显示 ${m[1]}，列表 ${shown} 条`)
    if (Number(m[1]) > Number(m[2])) throw new Error(`当前条数比总数还大：${countText}`)
    // total 必须是**截断前**的命中数：拿一个宽泛的词直接问一次 IPC，
    // 命中过 20 条时 hits 停在 20 而 total 更大——这才证明「共 M 条」不是把 20 抄了一遍
    const broad = await win.evaluate(() => window.api.vault.search('的'))
    if (broad.hits.length > 20) throw new Error(`检索没有截断到 20 条：${broad.hits.length}`)
    if (broad.total < broad.hits.length) throw new Error('total 比返回的条数还小：' + JSON.stringify(broad.total))
    if (broad.hits.length === 20 && broad.total <= 20)
      throw new Error(`total 没有反映截断前的命中数：hits=${broad.hits.length} total=${broad.total}`)
    console.log(
      'M-13 结果计数 ✓',
      JSON.stringify({ 计数: countText.replace(/\s+/g, ' ').trim(), 列表条数: shown, 宽泛词: { hits: broad.hits.length, total: broad.total } })
    )
  } else {
    // 零命中也必须是三态里的一态，绝不能掉回文件树
    if (!(await win.locator('[data-testid="search-empty"]').count()))
      throw new Error('搜索既没有结果计数也没有「没找到」（三态缺一）')
    console.log('⚠️ 「灰太太」零命中（这个库里没有这份数据），M-13 计数断言跳过')
  }
  const snippets = await win.locator('.line-clamp-2').allInnerTexts()
  const dirty = snippets.filter((s) => /\[\[|\||^---|doc_type:/.test(s))
  if (dirty.length) throw new Error('搜索摘要仍有 md/frontmatter 噪音：' + JSON.stringify(dirty.slice(0, 3)))
  console.log('搜索摘要 ✓', JSON.stringify(snippets.slice(0, 2)))
  // 固定点标题正好是「灰太太」的那条（达人档案：既有空表格又有空字段，正好验空值处理）
  const hit = win.locator('button:has(div:text-is("灰太太"))').first()
  if (await hit.count()) {
    await hit.click()
    await snap('06-搜索命中打开', 1200)
    // 空值渲染：属性卡片与正文的空字段给破折号，空表格折叠成「暂无数据」
    const noteText = await win.locator('.md-article').first().innerText()
    const emptyTable = await win.locator('text=暂无数据').count()
    const hasEmptyMark = noteText.includes('—')
    if (!emptyTable) throw new Error('只有表头的空表格没有折叠成「暂无数据」')
    if (!hasEmptyMark) throw new Error('空字段没有显示破折号')
    const ghostTable = await win.evaluate(() =>
      [...document.querySelectorAll('.md-article table')].some(
        (t) => !t.querySelectorAll('tbody tr').length ||
          [...t.querySelectorAll('tbody tr')].every((r) => !r.innerText.trim())
      )
    )
    if (ghostTable) throw new Error('仍然渲染了只有表头的空表格')
    await snap('06d-空值与空表格处理', 300)
    console.log('空值渲染 ✓', JSON.stringify({ 暂无数据: emptyTable, 破折号: hasEmptyMark }))
  }

  // ---- H-11 第三态：有词但零命中 → 「没找到「X」」+ 清空按钮，绝不能画成整棵文件树 ----
  {
    // **必须是真·生造词**：原来用的 'zzz这个词库里一定没有zzz' 是常用词拼的句子
    // （这个/词库/一定/没有），B-1 的模糊回退会正常地捞到东西，零命中态就永远测不到。
    // 也别用「霍格沃茨」这类真实存在的专名——哪天库里进了本小说它就撞了。
    // 生僻字组合才是稳的：真实语料里不会出现，也不会哪天变成真词
    const nonsense = 'zzqx月半仚'
    const leavesBefore = await win.locator('[data-testid="tree-col"] button.block.truncate').count()
    await win.fill('input[placeholder="搜索库…"]', nonsense)
    await win.locator('[data-testid="search-empty"]').waitFor({ timeout: 15000 })
    const emptyText = await win.locator('[data-testid="search-empty"]').innerText()
    if (!emptyText.includes(nonsense)) throw new Error(`「没找到」没带上搜索词：「${emptyText}」`)
    if (await win.locator('[data-testid="tree-col"] button.block.truncate').count())
      throw new Error('零命中时左栏还是整棵文件树（H-11 未修复）')
    await snap('05b-搜索零命中-没找到与清空', 300)
    // 清空按钮真点：回到文件树，输入框也跟着空
    await win.click('[data-testid="search-clear"]')
    await win.waitForTimeout(500)
    if ((await win.locator('input[placeholder="搜索库…"]').inputValue()) !== '')
      throw new Error('点「清空搜索」后输入框没清空')
    if (leavesBefore && !(await win.locator('[data-testid="tree-col"] button.block.truncate').count()))
      throw new Error('点「清空搜索」后没有回到文件树')
    await snap('05c-清空搜索-回到文件树', 300)
    console.log('H-11 零命中三态 ✓', JSON.stringify(emptyText.replace(/\s+/g, ' ').trim()))
  }

  // 投递箱：真实拷一个文件进投递箱目录，观察面板
  const settings = await win.evaluate(() => window.api.settings.get())
  if (settings.vaultPath) {
    const inboxCandidates = ['95_待入库', '00_投递箱']
    for (const c of inboxCandidates) {
      const dir = join(settings.vaultPath, c)
      if (existsSync(dir)) {
        // 分区投递覆盖层：合成 dragenter 触发（**不是 dragover**——覆盖层的显示挂在
        // dragenter 上，dragover 只负责 preventDefault 好让 drop 能派发，见 useDragOver）
        await win.evaluate(() => {
          // 从搜索框往上冒泡，比 querySelector 撞根容器稳（根容器的 class 组合可能被其他页面命中）
          const el = document.querySelector('input[placeholder="搜索库…"]') ?? document.querySelector('main .relative.flex.h-full')
          el?.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }))
          el?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }))
        })
        await win.waitForTimeout(400)
        const zoneBiz = await win.locator('text=业务资料').count()
        const zoneRef = await win.locator('text=主题打标 · 概念建链').count()
        if (!zoneBiz || !zoneRef) throw new Error(`分区投递覆盖层缺失：业务区=${zoneBiz} 分流区=${zoneRef}`)
        // 静态下两个投递区必须长得一模一样（此前业务区是粉底，像"已选中"）
        const zoneStyles = await win.evaluate(() =>
          [...document.querySelectorAll('.z-30 > div')].map((el) => {
            const st = getComputedStyle(el)
            return `${st.borderColor}|${st.backgroundColor}`
          })
        )
        if (new Set(zoneStyles).size !== 1)
          throw new Error('分区投递静态样式不一致：' + JSON.stringify(zoneStyles))
        await snap('06b-分区投递覆盖层', 200)
        // 悬停在某个区上方，才高亮那个区
        await win.evaluate(() => {
          document
            .querySelectorAll('.z-30 > div')[1]
            ?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }))
        })
        await win.waitForTimeout(300)
        const hotStyles = await win.evaluate(() =>
          [...document.querySelectorAll('.z-30 > div')].map((el) => getComputedStyle(el).borderColor)
        )
        if (hotStyles[0] === hotStyles[1]) throw new Error('悬停的投递区没有高亮：' + JSON.stringify(hotStyles))
        await snap('06b2-分区投递-悬停高亮', 200)
        console.log('分区投递 ✓ 静态同款 / 悬停才高亮', JSON.stringify({ idle: zoneStyles[0], hot: hotStyles[1] }))
        /**
         * **拖出窗口，覆盖层必须消失**（2026-08-18 真人测试反馈）。
         *
         * 老写法是 `onDragLeave: if (currentTarget === target) 隐藏`——覆盖层一出现，
         * 指针就压在覆盖层的子元素上，拖出窗口时最后一次 dragleave 的 target 是那个子元素，
         * 条件不成立，覆盖层就永远挂在屏幕上。这里刻意**从覆盖层内部的分区**发 dragleave
         * （正是老写法漏掉的那条路径），再断言它真的没了。
         */
        await win.evaluate(() => {
          const zone = document.querySelector('.z-30 > div') ?? document.querySelector('.z-30')
          zone?.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))
        })
        await win.waitForTimeout(300)
        if (await win.locator('.z-30').count())
          throw new Error('文件拖出窗口后分区投递覆盖层没有消失（dragleave 判定又退回 currentTarget===target 了？）')
        console.log('拖出窗口覆盖层消失 ✓')

        const sample = join(root, 'e2e', 'sample.docx')
        if (existsSync(sample)) {
          copyFileSync(sample, join(dir, `e2e测试文档_${Date.now()}.docx`))
          // 外部资料分流：走 enqueue 子目录 API（即分区投递松手后的真实链路）
          await win.evaluate((p) => window.api.inbox.enqueue([p], '参考资料'), sample)
          const { renameSync } = await import('fs')
          // enqueue 以原名拷贝：把落进 参考资料/ 的 sample.docx 改名成断言目标
          await win.waitForTimeout(500)
          if (existsSync(join(dir, '参考资料', 'sample.docx'))) {
            renameSync(join(dir, '参考资料', 'sample.docx'), join(dir, '参考资料', 'e2e参考书籍.docx'))
          }
          await snap('07-投递箱-收到文件', 4000)
          // 五阶段进度条：等它真出现再截，别靠 sleep 赌时机（旧版固定等 8s 常常截了个空面板）
          let barSeen = false
          for (let i = 0; i < 140 && !barSeen; i++) {
            barSeen = (await win.locator('.inbox-bar-fill').count()) > 0
            if (!barSeen) await win.waitForTimeout(300)
          }
          if (!barSeen) throw new Error('投递箱处理中没有出现阶段进度条')
          // 再等它真正走过第一段，截图才有信息量（刚出现时是「准备中 0/6」）
          for (let i = 0; i < 200; i++) {
            const t = await win.locator('.inbox-bar-fill').locator('xpath=../..').innerText().catch(() => '')
            if (/[1-9]\/\d/.test(t)) break
            await win.waitForTimeout(300)
          }
          const stageText = await win.locator('.inbox-bar-fill').locator('xpath=../..').innerText()
          if (!/\d\/\d/.test(stageText)) throw new Error(`进度条没有阶段计数：「${stageText}」`)
          await snap('08-投递箱-处理中', 0)
          console.log('投递箱进度条 ✓', JSON.stringify(stageText.replace(/\s+/g, ' ')))

          // ---- 全局任务状态层：投递跑着的时候切页面 / 刷新，状态都不能丢 ----
          {
            const dockBox = win.locator('[data-testid="task-dock"]')
            const dockText = () => win.locator('[data-testid="task-dock-btn"]').innerText()
            const dockOpen = async () =>
              (await dockBox.evaluate((el) => getComputedStyle(el).maxHeight)) !== '0px'

            // 上一轮可能已经跑完了（任务进终态、Dock 收起），所以这里自己再投一个文件，
            // 保证接下来的断言有一个确定处于活跃态的任务可看
            await win.evaluate((pth) => window.api.inbox.enqueue([pth]), sample)
            let live = false
            for (let i = 0; i < 120 && !live; i++) {
              live = await dockOpen()
              if (!live) await win.waitForTimeout(500)
            }
            if (!live) throw new Error('投了文件之后 TaskDock 仍然没出现')

            /**
             * **关掉浮窗 → 点 Dock → 浮窗必须回来**（2026-08-18 真人测试反馈）。
             *
             * 放在这里是因为**此刻任务确定是活跃的**：Dock 上才有东西可点，浮窗也才会被
             * 自动展开。放到 reload 之后不行——那时任务可能已经跑完、Dock 收起、
             * 面板本就该是关的，断言会假红（第一版就是这么挂的）。
             *
             * 两件事一起验：① 跑批期间 ✕ 真能关掉（可见性以前是 `showInbox || inboxRunning`，
             * `inboxRunning` 会立刻把面板顶回来，关闭按钮等于摆设）；② 关掉之后 Dock 是唯一
             * 还能回到这个任务的入口，而它原来只 `setPage('vault')`——人本来就在知识库页，
             * 于是「点了没反应」。
             */
            const panel = win.locator('[data-testid="inbox-panel"]')
            await panel.waitFor({ timeout: 15000 })
            await win.locator('[data-testid="inbox-panel-close"]').click()
            await win.waitForTimeout(400)
            if (await panel.count())
              throw new Error('点了 ✕ 投递箱浮窗没关掉（跑批期间被 inboxRunning 顶回来了？）')
            await win.locator('[data-testid="task-dock-btn"]').click()
            await panel.waitFor({ timeout: 8000 })
            await snap('27b-Dock唤回投递箱浮窗', 300)
            console.log('Dock 唤回浮窗 ✓')

            // 上面这几步会吃掉十几秒，本地模式一轮 pipeline 很短，等做完任务多半已经结束了。
            // 后面 H-07/H-08/reload 那几条都要求**有一个活跃任务**，所以这里把前提重新架起来。
            // **必须投一个新文件名**：同名文件再拷一次，chokidar 报的是 change 不是 add，
            // 不触发 file-added，也就不会有新任务（第一版就是这么假红的）
            // 用 copyFileSync 而不是 writeFileSync：本文件后面 1655 行有个
            // `const { writeFileSync } = await import('fs')`，同一函数作用域里的
            // 块级声明会把顶层那个 import 整个遮住，在它之前用就是 TDZ 报错
            const rearm = join('/tmp', `mcnai-rearm-${Date.now()}.docx`)
            copyFileSync(sample, rearm)
            await win.evaluate((pth) => window.api.inbox.enqueue([pth]), rearm)
            let live2 = false
            for (let i = 0; i < 120 && !live2; i++) {
              live2 = await dockOpen()
              if (!live2) await win.waitForTimeout(500)
            }
            if (!live2) throw new Error('唤回断言之后重新投文件，TaskDock 没有再次出现')

            // 渲染层刷新后状态照样在（主进程内存是真相源，reload 只是重拉一次 snapshot）。
            // 必须趁任务刚活起来这一刻 reload——等它跑完再 reload 测的就是"收起"那条分支了
            await win.reload()
            await win.waitForTimeout(2500)
            const after = await win.evaluate(async () => {
              const st = await window.api.tasks.list()
              const act = st.tasks.filter((t) => t.status === 'queued' || t.status === 'running')
              const dock = document.querySelector('[data-testid="task-dock"]')
              return {
                active: act.length,
                titles: act.map((t) => t.title),
                dockOpen: dock ? getComputedStyle(dock).maxHeight !== '0px' : false,
              }
            })
            if (!after.active) throw new Error('reload 后主进程的活跃任务没了（任务层没扛住刷新）')
            if (!after.dockOpen) throw new Error('reload 后仍有活跃任务，但 Dock 没显示出来')
            await snap('27-reload后-任务状态恢复', 200)
            console.log('reload 恢复 ✓', JSON.stringify(after))

            // Dock 出现/消失走高度过渡（批注 2）：走查开着 reduced-motion，所以只断言
            // 过渡属性接上了 + 展开态高度不为 0（duration 在降级块里被归零，不影响这两条）
            const tp = await dockBox.evaluate((el) => getComputedStyle(el).transitionProperty)
            if (!tp.includes('max-height')) throw new Error('TaskDock 没有接高度过渡：' + tp)
            console.log('Dock 高度过渡 ✓', tp)


            // H-07：切到对话工作台，全局条必须还在（旧代码切走就没有任何在处理中的痕迹）。
            // 注意两轮 pipeline 之间有 3 秒去抖窗口，那一刻确实没有活跃任务、Dock 本就该收起，
            // 所以这里轮询而不是采样一次——采样会偶发落进那个窗口里
            await win.locator('button[title="新对话"]').click() // 侧栏没有"工作台"条目，新对话即入口
            let onWorkbench = ''
            for (let i = 0; i < 80; i++) {
              if (await dockOpen()) {
                onWorkbench = await dockText()
                if (/投递箱/.test(onWorkbench)) break
              }
              onWorkbench = ''
              await win.waitForTimeout(500)
            }
            if (!onWorkbench)
              throw new Error('切到工作台后一直看不到投递任务的全局条（H-07）')
            await snap('25-工作台-全局任务条', 200)
            console.log('H-07 跨页面出口 ✓', JSON.stringify(onWorkbench.replace(/\s+/g, ' ')))

            // 真相源一致：Dock 显示的条数必须等于主进程 tasks:list 里的活跃任务数
            // 任务随时可能结束，一次采样撞上跃迁很正常；连续对得上才算数
            let cmp = null
            let uiCount = -1
            for (let i = 0; i < 20; i++) {
              cmp = await win.evaluate(async () => {
                const st = await window.api.tasks.list()
                // sync 按设计 §1.3 全程静默、不进 Dock，所以对账时也要把它排除
                const act = st.tasks.filter(
                  (t) => (t.status === 'queued' || t.status === 'running') && t.kind !== 'sync'
                )
                return { active: act.length, titles: act.map((t) => t.title) }
              })
              if (!(await dockOpen())) {
                uiCount = 0
              } else {
                const dockNow = await dockText()
                const many = /(\d+) 项进行中/.exec(dockNow)
                uiCount = many ? Number(many[1]) : 1
              }
              if (uiCount === cmp.active) break
              await win.waitForTimeout(300)
            }
            if (uiCount !== cmp.active)
              throw new Error(`Dock 与 tasks:list 始终对不上：UI=${uiCount} 主进程=${cmp.active} ${JSON.stringify(cmp.titles)}`)
            console.log('真相源一致 ✓', JSON.stringify({ ...cmp, uiCount }))

            // H-08：切回知识库页，运行态与进度条必须还在（旧代码回来是空白或上一轮的静态日志）
            await win.click('text=个人知识库')
            await win.waitForTimeout(2000)
            if (!(await win.locator('.inbox-bar-fill').count())) {
              const btn = win.locator('button[title="投递箱"]')
              if (await btn.count()) await btn.click()
              await win.waitForTimeout(600)
            }
            if (!(await win.locator('.inbox-bar-fill').count()))
              throw new Error('切回知识库页后进度条不见了（H-08）')
            const backText = await win.locator('.inbox-bar-fill').locator('xpath=../..').innerText()
            if (!/\d\/\d/.test(backText)) throw new Error(`切回后进度条没有阶段计数：「${backText}」`)
            await snap('26-切回知识库-运行态还在', 200)
            console.log('H-08 运行态不丢 ✓', JSON.stringify(backText.replace(/\s+/g, ' ')))
          }

          /**
           * 完成态：等「处理中…」消失但面板还在（run-end 后面板还留 4 秒），趁这个窗口截。
           * **预算给足 5 分钟**（2026-08-18 从 60 秒放宽）：`E2E_CHAT` 下 `tag_llm` 是真实
           * LLM 打标，4 个文件就要几十秒；再加上新的「实体建卡」一格，60 秒常常只走到
           * 第 2 格（PII守卫 2/8），于是下面找「上云」那行必然落空，
           * 报成"阶段日志把 message 丢了"——方向完全指错（连着假红两轮才看出来）。
           */
          for (let i = 0; i < 600; i++) {
            const panelUp = (await win.locator('.inbox-bar-fill').count()) > 0
            const busy = (await win.locator('span:has-text("处理中")').count()) > 0
            const text = panelUp
              ? await win.locator('.inbox-bar-fill').locator('xpath=../..').innerText().catch(() => '')
              : ''
            /**
             * 完成态判据**不许写死阶段数**（2026-08-18 被 A-3 打脸）：
             * 原来写的是 `/6\/6/`，而 INBOX_FLOW 现在是 8 格（加「实体建卡」之前就已是 7 格），
             * 这个正则永远不成立 → 只能靠 `!busy` 落空 → 在 PII 守卫那一刻就采样了，
             * 下面找「上云」那行自然找不到，报成"阶段日志把 message 丢了"，方向完全指错。
             * 改成读进度条自己报的 done/total（分母是多少就跟到多少），
             * 并且等「上云」那行真出现——那才是这段断言要看的东西。
             */
            const m = text.match(/(\d+)\s*\/\s*(\d+)/)
            const finished = !!m && m[1] === m[2]
            const cloudRowUp = panelUp
              ? await win.evaluate(() =>
                  [...document.querySelectorAll('[data-testid="inbox-panel"] .fade-up')].some((el) =>
                    (el.textContent ?? '').replace(/\s+/g, '').startsWith('上云')
                  )
                )
              : false
            if (panelUp && (cloudRowUp || finished || !busy)) break
            await win.waitForTimeout(500)
          }
          /**
           * **阶段日志必须把 message 说出来，且同一阶段不许连着堆好几行**（2026-08-18 反馈）。
           *
           * 用户报「右下角出现多次上云进度」。查实是呈现问题：一次整包拖入只跑一轮 pipeline、
           * 只调一次 cloudSync（96 个文件实测 1 轮 1 次 1 条任务），但 cloudSync 分批推、
           * 每批发一条带「20/61 篇」的事件，而日志只画阶段名、把 message 丢了 ——
           * 屏幕上就是几行一模一样的「上云」。
           * 本地模式没登录，cloud_sync 是 `skipped` 带 message「未登录」，正好验同一条链路。
           */
          const logRows = await win.evaluate(() =>
            [...document.querySelectorAll('[data-testid="inbox-panel"] .fade-up')].map((el) =>
              (el.textContent ?? '').replace(/\s+/g, '')
            )
          )
          const cloudRow = logRows.find((t) => t.startsWith('上云'))
          if (!cloudRow || cloudRow === '上云')
            throw new Error(`阶段日志把 message 丢了（只剩光秃秃的阶段名）：${JSON.stringify(logRows)}`)
          const stageName = (t) => t.replace(/[·（(].*$/, '')
          for (let i = 1; i < logRows.length; i++) {
            if (stageName(logRows[i]) && stageName(logRows[i]) === stageName(logRows[i - 1]))
              throw new Error(`同一阶段连着堆了两行，没有折叠：${logRows[i - 1]} / ${logRows[i]}`)
          }
          console.log('阶段日志 ✓', JSON.stringify({ 上云行: cloudRow, 行数: logRows.length }))
          await snap('09-投递箱-完成后', 0)
          await win.locator('span:has-text("处理中")').waitFor({ state: 'hidden', timeout: 180000 }).catch(() => {})
          const extMd = join(settings.vaultPath, '70_外部资料', 'e2e参考书籍.md')
          if (!existsSync(extMd)) throw new Error('外部资料分流失败：' + extMd + ' 未生成')
          console.log('外部资料分流 ✓ →', extMd)

          // 回归 2026-07-23：文件树必须显示真实文件夹（含无 md 的文件夹）
          // 客户报障——外部资料文件夹在磁盘上有、app 里看不到，因为旧版树只由 md 建
          // 2026-07-24 0号用户：原件不进树（太多太乱），只显示文件夹和笔记
          const { writeFileSync } = await import('fs')
          const noMdDir = join(settings.vaultPath, '70_外部资料', 'e2e视频课')
          const { mkdirSync } = await import('fs')
          mkdirSync(noMdDir, { recursive: true })
          writeFileSync(join(noMdDir, 'e2e某老师直播.mp4'), Buffer.alloc(2048))
          await win.waitForTimeout(1500) // 等 watcher addDir 冒泡刷新树
          const treeHasExt = await win.evaluate(async () => {
            const t = await window.api.vault.tree()
            const flat = []
            const walk = (ns) => ns.forEach((n) => { flat.push(n); if (n.children) walk(n.children) })
            walk(t)
            const extNode = flat.find((n) => n.name.includes('外部资料') && n.children)
            const videoDir = flat.find((n) => n.name === 'e2e视频课' && n.children)
            const originals = flat.filter((n) => !n.children && /\.(docx|pptx|xlsx|pdf|mp4|jsonl)$/i.test(n.name)).map((n) => n.name)
            const hidden = flat.filter((n) => n.name.startsWith('.')).map((n) => n.name)
            return { ext: !!extNode, videoDir: !!videoDir, originals, hidden }
          })
          if (!treeHasExt.ext) throw new Error('文件树未显示 外部资料 文件夹')
          if (!treeHasExt.videoDir) throw new Error('文件树未显示 无md的子文件夹 e2e视频课')
          if (treeHasExt.originals.length) throw new Error('文件树不应显示原件：' + treeHasExt.originals.slice(0, 5).join(', '))
          if (treeHasExt.hidden.length) throw new Error('文件树混入隐藏文件：' + treeHasExt.hidden.join(', '))
          // 树里展开外部资料并截图，人工复核
          const extBtn = win.locator('button:has-text("外部资料")').first()
          if (await extBtn.count()) await extBtn.click()
          await snap('06c-文件树显示外部资料文件夹', 600)
          console.log('文件树 ✓（外部资料/无md子文件夹可见；原件与隐藏文件不显示）')

          // ---- H-13 停止本轮：杀整个 pipeline 进程组，ps 查无残留，已落位的 md 不回滚 ----
          {
            const mdCount = () =>
              win.evaluate(() =>
                window.api.vault.tree().then((t) => {
                  const n = []
                  const walk = (ns) => ns.forEach((x) => (x.children ? walk(x.children) : n.push(x.path)))
                  walk(t)
                  return n.length
                })
              )
            const cancelFiles = []
            let pgid = null
            let mdBefore = 0
            // 面板先开着：按钮出现的那一刻就能点，不用先去找入口
            if (!(await win.locator('.inbox-bar-fill').count())) {
              const btn = win.locator('button[title="投递箱"]')
              if (await btn.count()) await btn.click()
            }
            for (let attempt = 1; attempt <= 3 && !pgid; attempt++) {
              // 必须从"完全闲下来"开始，否则抓到的是上一轮马上要结束的 pid
              if (!(await waitInboxIdle(win))) throw new Error('投递箱一直没闲下来，取消断言没法开始')
              mdBefore = await mdCount()
              // 多丢几份才有足够的窗口去点停止（单份 docx 有时几秒就跑完了）
              for (let i = 0; i < 10; i++) {
                const name = `e2e取消测试_${Date.now()}_${attempt}_${i}.docx`
                copyFileSync(sample, join(dir, name))
                cancelFiles.push(name)
              }
              const p = await waitForPipelinePid(win, 180000)
              if (!p) throw new Error('投递箱一直没 spawn 出 pipeline（拿不到 pid，取消断言无从谈起）')
              if (!pipelineLeftovers(p).length) {
                console.log(`第 ${attempt} 次：pgid=${p} 在 ps 里已经不在了，重来`)
                continue
              }
              await snap('34-投递箱-运行中可停止', 100)
              // 面板上真点「停止本轮」（不是直接调 IPC）
              try {
                await win.click('[data-testid="inbox-cancel"]', { timeout: 4000 })
                pgid = p
              } catch {
                console.log(`第 ${attempt} 次没赶上（这一轮已经跑完了），再丢一批重来`)
              }
            }
            if (!pgid) throw new Error('三次都没赶在 pipeline 跑完之前点到「停止本轮」')
            console.log('pipeline 进程组 pgid =', pgid)
            await win.locator('[data-testid="inbox-canceled"]').waitFor({ timeout: 20000 })

            // 状态必须是 canceled 而不是 failed（用户主动的操作不该看起来像出错）
            const ct = await win.evaluate(async () => {
              const s = await window.api.tasks.list()
              const t = s.tasks.find((x) => x.kind === 'inbox')
              return t ? { status: t.status, title: t.title, canceled: t.canceled, error: t.error } : null
            })
            if (ct?.status !== 'canceled') throw new Error('停止后任务状态不是 canceled：' + JSON.stringify(ct))
            if (ct.error) throw new Error('取消却带上了 error（会被画成红色）：' + JSON.stringify(ct))
            const panelText = await win.locator('[data-testid="inbox-canceled"]').innerText()
            if (!/已停止/.test(panelText) || !/已完成的部分/.test(panelText))
              throw new Error(`停止后的面板文案不对：「${panelText}」`)
            // 中性灰不是红：进度条填充色不能是 danger
            const barColor = await win.locator('.inbox-bar-fill').first().evaluate((el) => getComputedStyle(el).backgroundColor)
            const dangerColor = await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-danger').trim())
            console.log('停止后进度条色', barColor, '（danger =', dangerColor, '）')
            await snap('34b-投递箱-已停止中性态', 200)

            // 进程组必须一个都不剩（SIGTERM → 3 秒 → SIGKILL）
            let left = pipelineLeftovers(pgid)
            for (let i = 0; i < 20 && left.length; i++) {
              await win.waitForTimeout(500)
              left = pipelineLeftovers(pgid)
            }
            if (left.length) throw new Error('停止后仍有 pipeline 进程残留：\n' + left.join('\n'))
            console.log(`H-13 停止本轮 ✓ pgid=${pgid} 进程组无残留（打包形态=${packagedBin ? '是' : '否'}）`)

            // 不做回滚：已落位的 md 一篇都不能少
            const mdAfter = await mdCount()
            if (mdAfter < mdBefore) throw new Error(`取消把已落位的笔记删掉了：${mdBefore} → ${mdAfter}`)
            console.log('取消不回滚 ✓', JSON.stringify({ mdBefore, mdAfter }))

            // 收尾：把没处理完的测试文件清掉，别影响后面的入库断言
            for (const n of cancelFiles) rmSync(join(dir, n), { force: true })
          }
        }
        break
      }
    }
  }

  // ---- 三栏可拖拽分隔线：真拖一次并断言宽度变化 + 记忆到 localStorage ----
  {
    // 图谱侧栏形态需要有笔记打开；前面的流程可能已关掉，兜底再点开一篇
    if (!(await win.locator('[data-testid="divider-graph"]').count())) {
      await win.locator('button.block.truncate').first().click()
      await win.waitForTimeout(1200)
    }
    const dragBy = async (testId, dx) => {
      const box = await win.locator(`[data-testid="${testId}"]`).boundingBox()
      if (!box) throw new Error(`分隔线 ${testId} 不存在`)
      const y = box.y + box.height / 2
      await win.mouse.move(box.x + box.width / 2, y)
      await win.mouse.down()
      await win.mouse.move(box.x + box.width / 2 + dx, y, { steps: 12 })
      await win.mouse.up()
      await win.waitForTimeout(200)
    }
    const widthOf = (testId) =>
      win.locator(`[data-testid="${testId}"]`).evaluate((el) => el.offsetWidth)

    const treeBefore = await widthOf('tree-col')
    await dragBy('divider-tree', 90)
    const treeAfter = await widthOf('tree-col')
    if (Math.abs(treeAfter - treeBefore - 90) > 12)
      throw new Error(`拖文件树分隔线宽度没跟上：${treeBefore} → ${treeAfter}（期望 +90）`)

    const graphBefore = await widthOf('graph-col')
    await dragBy('divider-graph', -80) // 图谱在右侧：往左拖 = 变宽
    const graphAfter = await widthOf('graph-col')
    if (Math.abs(graphAfter - graphBefore - 80) > 12)
      throw new Error(`拖图谱分隔线宽度没跟上：${graphBefore} → ${graphAfter}（期望 +80）`)
    await snap('18-三栏-拖拽分隔线后', 300)

    const saved = await win.evaluate(() => ({
      tree: localStorage.getItem('vault.treeWidth'),
      graph: localStorage.getItem('vault.graphWidth'),
    }))
    if (Math.abs(Number(saved.tree) - treeAfter) > 2 || Math.abs(Number(saved.graph) - graphAfter) > 2)
      throw new Error('拖拽后的宽度没写进 localStorage：' + JSON.stringify(saved))

    // 记忆验证：重载后回知识库，宽度应还是拖完的值
    await win.reload()
    await win.waitForTimeout(2000)
    await win.click('text=个人知识库')
    await win.waitForTimeout(2500)
    const treeReload = await widthOf('tree-col')
    if (Math.abs(treeReload - treeAfter) > 2)
      throw new Error(`重载后文件树宽度没记住：${treeAfter} → ${treeReload}`)
    await snap('18b-重载后-栏宽记忆', 300)
    console.log('分隔线拖拽 ✓', JSON.stringify({ treeBefore, treeAfter, graphBefore, graphAfter, saved, treeReload }))
  }

  /** 02d 放大时用的锚点：02e 拍整图要按同一点原路缩回（滚轮缩放以指针为中心） */
  let zoomAnchor = null

  // ---- 关系图配色特写：节点色是否融进暖色主题，需要人工看这张图确认 ----
  // 2026-08-18 重做后 token 换了一套：按**角色**取色（talent/product/partner/hub/doc），
  // 不再是 group-1..7 的哈希分组色。旧断言是按 group-* 写的，那套 token 已经删了
  {
    const groups = await win.evaluate(() => {
      const cs = getComputedStyle(document.documentElement)
      const names = [
        '--color-graph-link',
        '--color-graph-node',
        '--color-graph-talent',
        '--color-graph-product',
        '--color-graph-partner',
        '--color-graph-hub',
      ]
      return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]))
    })
    if (Object.values(groups).some((v) => !v)) throw new Error('图谱配色 token 缺失：' + JSON.stringify(groups))
    // 旧的 group-* 一支都不许留：留着就会有人以为还能用，配色又慢慢回到"人人抢颜色"
    const leftover = await win.evaluate(() => {
      const cs = getComputedStyle(document.documentElement)
      return Array.from({ length: 7 }, (_, i) => `--color-group-${i + 1}`).filter((n) => cs.getPropertyValue(n).trim())
    })
    if (leftover.length) throw new Error('旧的分组色 token 还在：' + leftover.join('、'))
    const cbox = await win.locator('canvas').first().boundingBox()
    if (!cbox) throw new Error('关系图 canvas 不存在')
    // 节点团不一定落在画布正中（力导布局每次落点不同），直接扫 canvas 像素求出
    // 非背景区域的中心，再把滚轮缩放对准那里——否则容易放大到一片空白
    const cluster = await win.evaluate(() => {
      const c = document.querySelector('canvas')
      const { width, height } = c
      const d = c.getContext('2d').getImageData(0, 0, width, height).data
      let minX = width, minY = height, maxX = 0, maxY = 0, n = 0
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const i = (y * width + x) * 4
          // 背景 #faf9f5；跟它差得够远的像素才算画上了东西（节点/边/标签）
          if (Math.abs(d[i] - 250) + Math.abs(d[i + 1] - 249) + Math.abs(d[i + 2] - 245) > 60) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            n++
          }
        }
      }
      const dpr = width / c.clientWidth
      return { n, cx: (minX + maxX) / 2 / dpr, cy: (minY + maxY) / 2 / dpr }
    })
    if (!cluster.n) throw new Error('关系图画布上没有画出任何节点')
    // 滚轮以指针为中心放大，放大后指针那一点的内容不动，正好用同一点当截图中心。
    // 锚点存到外层：下一段（02e 整图）要按同一个点、同样的格数原路缩回去
    zoomAnchor = { x: cbox.x + cluster.cx, y: cbox.y + cluster.cy }
    await win.mouse.move(zoomAnchor.x, zoomAnchor.y)
    for (let i = 0; i < 3; i++) {
      await win.mouse.wheel(0, -200)
      await win.waitForTimeout(250)
    }
    await win.waitForTimeout(1000)
    // 同 02e：先在画布内抖一下清掉 hover，否则这张特写拍到的是"压暗态"（大半张灰）
    await win.mouse.move(cbox.x + 12, cbox.y + cbox.height - 12)
    await win.waitForTimeout(200)
    await win.mouse.move(cbox.x + 14, cbox.y + cbox.height - 14)
    await win.waitForTimeout(500)
    const w = Math.min(820, Math.floor(cbox.width))
    const h = Math.min(560, Math.floor(cbox.height))
    const clipX = Math.max(cbox.x, Math.min(cbox.x + cluster.cx - w / 2, cbox.x + cbox.width - w))
    const clipY = Math.max(cbox.y, Math.min(cbox.y + cluster.cy - h / 2, cbox.y + cbox.height - h))
    await win.screenshot({
      path: join(shots, '02d-关系图-配色特写.png'),
      clip: { x: clipX, y: clipY, width: w, height: h },
    })
    record('02d-关系图-配色特写')
    console.log('shot: 02d-关系图-配色特写', JSON.stringify({ cluster, ...groups }))
  }

  /**
   * 关系图的角色配色（2026-08-18 重做：多数安静、少数发声）。
   *
   * **必须造一张产品卡**：走查库里产品卡的来源阈值（≥2 处提及）从来没够过，
   * 于是 `product` 那支绿色一次都不会出现——图例上却写着「产品」。
   * 不造的话这条分支永远没被验过，而"图例声称的颜色实际不存在"正是这次要消灭的东西。
   */
  {
    const tmpCard = join(vaultCopy, '30_实体', '产品', 'e2e走查产品卡.md')
    mkdirSync(dirname(tmpCard), { recursive: true })
    writeFileSync(
      tmpCard,
      ['---', 'doc_type: 产品页', 'entity_kind: product', 'entity_name: e2e走查产品卡', 'tags: ["实体", "产品"]', '---', '', '# 🛍 e2e走查产品卡', '', '关联：[[Home]]', ''].join('\n')
    )
    // 等 watcher 把这篇扫进索引（chokidar awaitWriteFinish 2s + 重建）
    let kinds = {}
    for (let i = 0; i < 30; i++) {
      await win.waitForTimeout(1000)
      kinds = await win.evaluate(async () => {
        const g = await window.api.vault.graph()
        const c = {}
        for (const n of g.nodes) c[n.kind ?? '?'] = (c[n.kind ?? '?'] ?? 0) + 1
        return c
      })
      if (kinds.product) break
    }
    for (const k of ['talent', 'product', 'partner', 'hub', 'doc']) {
      if (!kinds[k]) throw new Error(`关系图缺少角色 ${k}（实测分布 ${JSON.stringify(kinds)}）`)
    }
    // "多数安静"是这次配色的设计前提，不是修辞：普通文档必须占大头，
    // 否则说明角色判定把太多东西提成了"要发声的少数"
    const total = Object.values(kinds).reduce((a, b) => a + b, 0)
    const loud = total - kinds.doc
    if (kinds.doc / total < 0.5)
      throw new Error(`安静的普通文档只占 ${Math.round((kinds.doc / total) * 100)}%，"多数安静"不成立：${JSON.stringify(kinds)}`)
    // 图例：五项齐全，且每个色点的颜色**就是**对应 token 的值（图例与画布同源，不许各画各的）
    const legend = await win.evaluate(() => {
      const box = document.querySelector('[data-testid="graph-legend"]')
      if (!box) return null
      const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
      const toRgb = (hex) => {
        const m = hex.replace('#', '')
        return `rgb(${parseInt(m.slice(0, 2), 16)}, ${parseInt(m.slice(2, 4), 16)}, ${parseInt(m.slice(4, 6), 16)})`
      }
      const MAP = {
        talent: '--color-graph-talent',
        product: '--color-graph-product',
        partner: '--color-graph-partner',
        hub: '--color-graph-hub',
        doc: '--color-graph-node',
      }
      return [...box.querySelectorAll('[data-legend]')].map((el) => ({
        kind: el.dataset.legend,
        label: el.textContent.trim(),
        dot: getComputedStyle(el.querySelector('i')).backgroundColor,
        want: toRgb(css(MAP[el.dataset.legend])),
      }))
    })
    // 三期硬约束：**品牌橙不许再当任何类别的常态色**（只留给交互态的高亮环）。
    // 二期把达人卡定成品牌橙，结果 169 个达人节点跟界面主色抢戏
    const brandClash = await win.evaluate(() => {
      const cs = getComputedStyle(document.documentElement)
      const accent = cs.getPropertyValue('--color-accent').trim().toLowerCase()
      return ['talent', 'product', 'partner', 'hub', 'node']
        .map((k) => [k, cs.getPropertyValue(`--color-graph-${k}`).trim().toLowerCase()])
        .filter(([, v]) => v === accent)
        .map(([k]) => k)
    })
    if (brandClash.length)
      throw new Error(`品牌橙又被拿去当节点常态色了：${brandClash.join('、')}（橙只留给选中/悬停高亮环）`)
    if (!legend) throw new Error('关系图角落没有图例（颜色语义不许让用户猜）')
    if (legend.length !== 5) throw new Error(`图例应有 5 项，实为 ${legend.length}`)
    for (const it of legend) {
      if (it.dot !== it.want) throw new Error(`图例「${it.label}」的色点 ${it.dot} 与 token ${it.want} 对不上`)
    }
    /**
     * 这张是**整图**（用户验收看的就是它）：前一步 02d 为了拍特写把画布放大过、
     * 而且鼠标还压在某个节点上（一度邻居提亮、其余压暗）。不复位的话拍出来是
     * "放大 + 悬停态"的局部，看不出"多数安静"到底成没成立。
     */
    {
      const cb = await win.locator('canvas').first().boundingBox()
      // **原样退回 02d 放大的那 3 格**（滚轮缩放是指数的：多退几格就把整张图缩成一个点，
      // 实测退 12 格拍出来是空白画布中间一个小点）。指针位置也要和放大时同一点，
      // 否则以不同中心缩放会把图推出视野
      if (zoomAnchor) await win.mouse.move(zoomAnchor.x, zoomAnchor.y)
      for (let i = 0; i < 3; i++) {
        await win.mouse.wheel(0, 200)
        await win.waitForTimeout(200)
      }
      /**
       * 清 hover 的压暗态（留着拍出来大半张图是灰的）。**必须在画布内再动一次鼠标**：
       * Playwright 的 mouse.move 是瞬移，直接跳到画布外不会在 canvas 里产生 mousemove，
       * force-graph 就不会重算 hover——2026-08-18 拍图时被这个坑了两张。
       */
      await win.mouse.move(cb.x + 12, cb.y + cb.height - 12)
      await win.waitForTimeout(200)
      await win.mouse.move(cb.x + 14, cb.y + cb.height - 14)
      await win.waitForTimeout(600)
    }
    await snap('02e-关系图-角色配色与图例', 1200)
    console.log('关系图角色配色 ✓', JSON.stringify({ kinds, 发声占比: `${Math.round((loud / total) * 100)}%`, legend: legend.map((l) => l.label) }))
    rmSync(tmpCard, { force: true })
  }

  // ---- markdown 表格样式：造一篇带表格的笔记，看圆角/表头暖灰底/行 hover ----
  {
    const rel = await win.evaluate(async () => {
      const p = await window.api.vault.createNote('', 'e2e表格样式')
      await window.api.vault.write(
        p,
        [
          '# 表格样式走查',
          '',
          '| 达人 | 场次 | GMV | 备注 |',
          '| --- | --- | --- | --- |',
          '| 灰太太 | 12 | 86,400 | 主推 |',
          '| 皮蛋 | 8 | 43,100 | 稳定 |',
          '| 一只啤酒猫 | 5 | 21,700 | 新号 |',
          '',
        ].join('\n')
      )
      return p
    })
    await win.locator('button.block.truncate:has-text("e2e表格样式")').first().click()
    await win.locator('.md-article table').first().waitFor({ timeout: 8000 })
    await win.waitForTimeout(500)
    const tbl = await win.evaluate(() => {
      const t = document.querySelector('.md-article table')
      const th = t.querySelector('th')
      const st = getComputedStyle(t)
      return { radius: st.borderTopLeftRadius, thBg: getComputedStyle(th).backgroundColor }
    })
    if (parseFloat(tbl.radius) < 6) throw new Error('markdown 表格没有圆角：' + JSON.stringify(tbl))
    await snap('19-markdown表格样式', 200)
    const rowBgOf = () =>
      win.evaluate(
        () =>
          getComputedStyle(document.querySelectorAll('.md-article tbody tr')[1].querySelector('td'))
            .backgroundColor
      )
    const idleBg = await rowBgOf()
    await win.locator('.md-article tbody tr').nth(1).hover()
    await win.waitForTimeout(200)
    const hoverBg = await rowBgOf()
    if (idleBg === hoverBg) throw new Error(`表格行 hover 没有高亮：${idleBg}`)
    await snapHover('19b-表格行hover高亮')
    console.log('markdown 表格 ✓', JSON.stringify({ ...tbl, idleBg, hoverBg, note: rel }))
  }

  // ---- H-05 保存三态：保存成功要有轻 toast（以前成功失败长得一模一样，写盘失败是静默的）----
  {
    await win.click('button:has-text("编辑")')
    await win.locator('textarea').first().waitFor({ timeout: 5000 })
    await win.locator('textarea').first().fill('# 表格样式走查\n\nH-05 保存三态走查：这一行是编辑后写进去的。\n')
    await snap('20-笔记编辑态', 300)
    await win.click('button:has-text("保存")')
    await win.locator('text=已保存').waitFor({ timeout: 5000 })
    await snap('20b-保存成功toast', 200)
    await grabToastGeo('保存成功(ok/绿)')
    // 保存成功必须退出编辑态，且内容真的落盘（不是只把按钮变灰）
    if (await win.locator('textarea').count()) throw new Error('保存成功后没有退出编辑态')
    const saved = await win.evaluate(async () => window.api.vault.readRaw('e2e表格样式.md'))
    if (!saved.includes('H-05 保存三态走查')) throw new Error('保存内容没落盘：' + saved.slice(0, 80))
    console.log('H-05 保存成功 toast + 落盘 ✓')
  }

  // ---- H-04 未保存确认：编辑中切到另一篇笔记必须先问，取消要留在原地且草稿还在 ----
  {
    await win.click('button:has-text("编辑")')
    await win.locator('textarea').first().waitFor({ timeout: 5000 })
    const dirtyText = '# 表格样式走查\n\nH-04 这段改动没保存，切走时必须弹确认。\n'
    await win.locator('textarea').first().fill(dirtyText)
    // 换一篇笔记：找一个不是当前这篇的叶子
    const other = win.locator('button.block.truncate').filter({ hasNotText: 'e2e表格样式' }).first()
    const otherName = (await other.innerText()).trim()
    await other.click()
    await win.locator('text=放弃未保存的修改？').waitFor({ timeout: 5000 })
    await snap('21-未保存确认弹窗', 200)
    // 取消：应留在原来那篇的编辑态，草稿一个字都不能少
    // （编辑态头部也有个「取消」，弹窗按钮一律收敛到 [data-testid="modal"] 里点，否则撞 strict mode）
    await win.click('[data-testid="modal"] button:has-text("取消")')
    await win.waitForTimeout(400)
    const stillEditing = await win.locator('textarea').count()
    if (!stillEditing) throw new Error('取消未保存确认后编辑态没了')
    // 编辑态 + 草稿原样还在 = 确实没跳走（跳走的话 NoteView 会换 key 重挂，根本不在编辑态）
    const keptDraft = await win.locator('textarea').first().inputValue()
    if (keptDraft !== dirtyText) throw new Error('取消后草稿被改了：' + JSON.stringify(keptDraft.slice(0, 40)))
    await snap('21b-未保存确认-取消后留在原地', 200)
    // 再切一次并选「放弃修改」：这次应该真的跳过去，且磁盘上的内容仍是上一次保存的
    await other.click()
    await win.locator('text=放弃未保存的修改？').waitFor({ timeout: 5000 })
    await win.click('[data-testid="modal"] button:has-text("放弃修改")')
    await win.waitForTimeout(800)
    if (await win.locator('textarea').count()) throw new Error('放弃修改后没退出编辑态')
    const onDisk = await win.evaluate(async () => window.api.vault.readRaw('e2e表格样式.md'))
    if (onDisk.includes('H-04 这段改动没保存')) throw new Error('放弃的改动竟然写进了磁盘')
    await snap('21c-放弃修改后切到另一篇', 300)
    console.log('H-04 未保存确认 ✓', JSON.stringify({ 切到: otherName }))
  }

  // ---- M-27 编辑冲突：外部脚本真改文件 → 非模态提示条 → 保存弹三选一 → 另存为副本 ----
  {
    const rel = 'e2e表格样式.md'
    const abs = join(settings.vaultPath, rel)
    // 回到那篇笔记并进编辑态（进编辑时记基线 hash）
    await win.locator(`button.block.truncate:has-text("e2e表格样式")`).first().click()
    await win.waitForTimeout(600)
    await win.click('button:has-text("编辑")')
    await win.locator('textarea').first().waitFor({ timeout: 5000 })

    // ① 自触发抑制：应用自己保存一次，**不能**报冲突（否则每次保存都自己给自己报警）
    const mine = '# 表格样式走查\n\nM-27：这一行是我在应用里写的。\n'
    await win.locator('textarea').first().fill(mine)
    await win.click('button:has-text("保存")')
    await win.locator('text=已保存').waitFor({ timeout: 8000 })
    await win.waitForTimeout(2500) // 给 watcher 的 awaitWriteFinish(800ms) 足够时间冒事件
    if (await win.locator('[data-testid="conflict-bar"]').count())
      throw new Error('应用自己保存竟然触发了冲突条（自触发抑制失效）')
    console.log('M-27 自触发抑制 ✓ 自己写盘不算冲突')

    // ② 编辑中，外部脚本真的改磁盘上的同一个文件
    await win.click('button:has-text("编辑")')
    await win.locator('textarea').first().waitFor({ timeout: 5000 })
    const myDraft = '# 表格样式走查\n\nM-27：这是「我的」版本，冲突时要能保住。\n'
    await win.locator('textarea').first().fill(myDraft)
    // 不传文本、用脚本里的默认值：换行符经 shell 传参会变成字面量 \n（踩过一次，
    // 结果"对方版本"里显示的是两个字符的 \n 而不是真的换行）
    const THEIR_LINE = '这一行是外部程序（模拟 Obsidian）写进去的。'
    execSync(`node ${JSON.stringify(join(root, 'e2e', 'external-edit.mjs'))} ${JSON.stringify(abs)}`)

    // 非模态：提示条要出现，而且**不能**弹模态（用户正在打字）
    await win.locator('[data-testid="conflict-bar"]').waitFor({ timeout: 20000 })
    if (await win.locator('[data-testid="modal"]').count()) throw new Error('外部改动时弹了模态（应该只挂非模态提示条）')
    if (!(await win.locator('textarea').count())) throw new Error('冲突提示条把编辑态顶掉了')
    const keep = await win.locator('textarea').first().inputValue()
    if (keep !== myDraft) throw new Error('挂出冲突条时草稿被改了：' + JSON.stringify(keep.slice(0, 40)))
    await snap('37-编辑冲突-非模态提示条', 300)
    // 「查看对方版本」真点：就地展开磁盘那一版
    await win.click('[data-testid="conflict-view-theirs"]')
    await win.locator('[data-testid="conflict-theirs"]').waitFor({ timeout: 5000 })
    const theirs = await win.locator('[data-testid="conflict-theirs"]').innerText()
    if (!theirs.includes(THEIR_LINE)) throw new Error('「查看对方版本」显示的不是磁盘上那一版')
    await snap('37b-冲突-查看对方版本', 200)

    // ③ 点保存 → 弹三选一，默认高亮「另存为副本」（唯一零数据丢失的选项）
    await win.click('button:has-text("保存")')
    await win.locator('text=这个文件已在外部被修改').waitFor({ timeout: 8000 })
    const opts = await win.locator('[data-testid="modal"] [data-testid^="choose-"]').allInnerTexts()
    if (opts.length !== 3) throw new Error('冲突弹窗不是三选一：' + JSON.stringify(opts))
    const primary = await win.locator('[data-testid="modal"] [data-primary="1"]').innerText()
    if (!primary.includes('另存为副本'))
      throw new Error(`默认高亮的不是「另存为副本」，而是「${primary}」`)
    const accent = await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim())
    const primaryBg = await win.locator('[data-testid="modal"] [data-primary="1"]').evaluate((el) => getComputedStyle(el).backgroundColor)
    await snap('37c-冲突-保存三选一', 200)
    console.log('M-27 三选一 ✓', JSON.stringify({ opts, primary: primary.trim(), primaryBg, accent }))

    // ④ 选「另存为副本」：磁盘那一版原样留着，我的那一版进副本 —— 两份都在
    await win.click('[data-testid="modal"] [data-testid="choose-copy"]')
    await win.locator('text=已另存为副本').waitFor({ timeout: 10000 })
    await win.waitForTimeout(1200)
    const copies = readdirSync(settings.vaultPath).filter((f) => /^e2e表格样式 \(冲突副本 .+\)\.md$/.test(f))
    if (copies.length !== 1) throw new Error('没产生（或产生了多个）冲突副本：' + JSON.stringify(copies))
    const originalNow = readFileSync(abs, 'utf-8')
    const copyNow = readFileSync(join(settings.vaultPath, copies[0]), 'utf-8')
    if (!originalNow.includes(THEIR_LINE)) throw new Error('原文件里对方那一版被覆盖掉了（应该保住）')
    if (!copyNow.includes('这是「我的」版本')) throw new Error('副本里不是我的那一版：' + copyNow.slice(0, 80))
    await snap('37d-冲突-另存为副本后两份都在', 500)
    console.log('M-27 另存为副本 ✓ 两份都在', JSON.stringify({ 副本: copies[0] }))
  }

  // ---- M-02 笔记读取失败：toast + 正文区错误态（带重试），不再"点了没反应" ----
  // 用 chmod 000 造一次真实的读失败（文件还在树里，只是读不了），比删文件更贴近真实故障
  {
    const rel = await win.evaluate(() => window.api.vault.createNote('', 'e2e读取失败'))
    await win.locator('button.block.truncate:has-text("e2e读取失败")').first().waitFor({ timeout: 10000 })
    const abs = join(settings.vaultPath, rel)
    // 先关掉当前笔记，保证点击是一次真正的"打开"
    const closeBtn = win.locator('button[title="关闭文件"]')
    if (await closeBtn.count()) await closeBtn.click()
    await win.waitForTimeout(400)
    chmodSync(abs, 0o000)
    await win.locator('button.block.truncate:has-text("e2e读取失败")').first().click()
    await win.locator('[data-testid="note-error"]').waitFor({ timeout: 10000 })
    const errToast = await win.locator('[data-testid="toast"]').first().innerText()
    if (!/打不开这篇笔记/.test(errToast)) throw new Error(`读失败没有 toast：「${errToast}」`)
    const errBody = await win.locator('[data-testid="note-error"]').innerText()
    if (!errBody.includes(rel)) throw new Error(`错误态没显示是哪篇笔记：「${errBody}」`)
    if (!(await win.locator('[data-testid="note-retry"]').count())) throw new Error('错误态没有重试按钮')
    await snap('42-笔记读取失败-错误态与重试', 200)
    // 修好权限后点「重试」：正文必须真的出来
    chmodSync(abs, 0o644)
    await win.click('[data-testid="note-retry"]')
    await win.locator('.md-article').first().waitFor({ timeout: 10000 })
    if (await win.locator('[data-testid="note-error"]').count())
      throw new Error('重试成功后错误态还挂着')
    await snap('42b-笔记读取失败-重试成功', 300)
    console.log('M-02 读取失败三态 ✓', JSON.stringify({ toast: errToast.trim(), 笔记: rel }))
    await win.evaluate((p) => window.api.vault.deleteNote(p), rel)
    await win.waitForTimeout(600)
  }

  // ---- M-04 打开库内附件失败：以前 openFile 返回 false 被直接丢掉，点了纯粹没反应 ----
  {
    const rel = await win.evaluate(async () => {
      const p = await window.api.vault.createNote('', 'e2e断链附件')
      await window.api.vault.write(
        p,
        '# 断链附件\n\n[打不开的附件](./e2e这个附件不存在.pdf)\n'
      )
      return p
    })
    await win.locator('button.block.truncate:has-text("e2e断链附件")').first().click()
    await win.locator('.md-article a').first().waitFor({ timeout: 10000 })
    await win.locator('[data-testid="toast"]').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
    await win.locator('.md-article a').first().click()
    await win.locator('[data-testid="toast"]').first().waitFor({ timeout: 8000 })
    const linkToast = await win.locator('[data-testid="toast"]').first().innerText()
    if (!/找不到文件/.test(linkToast)) throw new Error(`断链附件点击没有提示：「${linkToast}」`)
    if (!/e2e这个附件不存在\.pdf/.test(linkToast)) throw new Error(`提示里没写是哪个文件：「${linkToast}」`)
    await snap('43-断链附件-找不到文件提示', 200)
    console.log('M-04 附件断链提示 ✓', JSON.stringify(linkToast.trim()))
    await win.evaluate((p) => window.api.vault.deleteNote(p), rel)
    await win.waitForTimeout(600)
  }

  // ---- H-02 换库出口：换库要先确认，向导里要有「返回当前库」能退回来 ----
  {
    await win.click('button[title="切换知识库"]')
    await win.locator('text=切换到另一个知识库？').waitFor({ timeout: 5000 })
    const switchMsg = await win.locator('.whitespace-pre-line').first().innerText()
    if (!switchMsg.includes(settings.vaultPath)) throw new Error(`换库确认没显示当前库路径：「${switchMsg}」`)
    await snap('22-换库二次确认', 200)
    // 取消：应该还在原来的库里（文件树还在）
    await win.click('[data-testid="modal"] button:has-text("取消")')
    await win.waitForTimeout(400)
    if (!(await win.locator('[data-testid="tree-col"]').count())) throw new Error('取消换库后离开了当前库')
    // 确认进向导：必须有退出口
    await win.click('button[title="切换知识库"]')
    await win.click('[data-testid="modal"] button:has-text("去换库")')
    await win.locator('text=建立你的知识库').waitFor({ timeout: 5000 })
    if (!(await win.locator('button:has-text("返回当前库")').count()))
      throw new Error('换库向导没有「返回当前库」出口（点了系统对话框取消就回不去了）')
    await snap('22b-换库向导-有返回出口', 300)
    await win.click('button:has-text("返回当前库")')
    await win.locator('[data-testid="tree-col"]').waitFor({ timeout: 8000 })
    await snap('22c-返回当前库', 800)
    console.log('H-02 换库确认 + 返回当前库 ✓')
  }

  // 设置页
  await win.click('text=设置')
  await snap('10-设置页', 600)
  await assertNoOldBrand('设置页')
  await assertNoRose('设置页')

  // ---- 设置页分组重构：四组卡片 + 管理员区默认不可见 ----
  {
    for (const [id, name] of [
      ['settings-group-account', '账号'],
      ['settings-group-model', '模型服务'],
      ['settings-group-vault', '知识库'],
      ['settings-group-usage', '用量'],
    ]) {
      if (!(await win.locator(`[data-testid="${id}"]`).count())) throw new Error(`设置页缺少「${name}」分组卡片`)
    }
    if (await win.locator('[data-testid="admin-zone"]').count())
      throw new Error('管理员区默认就露出来了（应当靠版本号连点 7 次才解锁）')
    // 普通模式下「模型服务」只说一句话：好 / 不好。线路地址与模型串一律不许出现在这里
    const modelCard = await win.locator('[data-testid="settings-group-model"]').innerText()
    if (/https?:\/\/|deepseek|claude|opus|aihubmix|inferera/i.test(modelCard))
      throw new Error(`模型服务卡片在普通模式下泄露了线路/模型：「${modelCard}」`)
    const ready = await win.locator('[data-testid="ai-ready"]').count()
    const broken = await win.locator('[data-testid="ai-broken"]').count()
    if (ready + broken !== 1) throw new Error(`模型服务状态不是唯一一行：ready=${ready} broken=${broken}`)
    if (broken && !(await win.locator('[data-testid="ai-reconnect"]').count()))
      throw new Error('服务异常时没有「重新连接」按钮')
    // 「导出诊断报告」仍然是页面底部的独立区域
    if (!(await win.locator('button:has-text("导出诊断报告到桌面")').count()))
      throw new Error('设置页底部缺少「导出诊断报告」区域')
    console.log('设置页四组 ✓', JSON.stringify({ AI服务: ready ? '已就绪' : '服务异常' }))
  }

  // ---- 管理员区：版本号连点 7 次解锁（少一次都不行）----
  {
    const badge = win.locator('[data-testid="version-badge"]')
    if (!(await badge.count())) throw new Error('设置页底部没有版本号')
    for (let i = 0; i < 6; i++) {
      await badge.click()
      await win.waitForTimeout(60)
    }
    if (await win.locator('[data-testid="admin-zone"]').count())
      throw new Error('点了 6 次就解锁了（约定是 7 次）')
    await badge.click()
    await win.locator('[data-testid="admin-zone"]').waitFor({ timeout: 8000 })
    const zone = await win.locator('[data-testid="admin-zone"]').innerText()
    if (!zone.includes('运维配置，请勿改动')) throw new Error(`管理员区没有警示标题：「${zone.slice(0, 60)}」`)
    // 截图前滚到位：管理员区在页面很下面，不滚的话这张和上一张长得一模一样（人工看截图等于白看）
    await win.locator('[data-testid="admin-zone"]').scrollIntoViewIfNeeded()
    await snap('10g-管理员区-7连点解锁', 400)
    console.log('管理员区 7 连点解锁 ✓')
  }

  // ---- 档位映射（运维口）：两档的线路地址与模型串都在管理员区，且模型是钉死的 ----
  {
    const val = (t) => win.locator(`[data-testid="${t}"]`).inputValue()
    for (const id of ['standard', 'enhanced']) {
      if (!(await win.locator(`[data-testid="tier-config-${id}"]`).count()))
        throw new Error(`管理员区缺少「${id}」档的映射配置`)
    }
    const std = {
      base: await val('tier-baseurl-standard'),
      model: await val('tier-model-standard'),
      fast: await val('tier-fastmodel-standard'),
    }
    const enh = {
      base: await val('tier-baseurl-enhanced'),
      model: await val('tier-model-enhanced'),
      fast: await val('tier-fastmodel-enhanced'),
    }
    // 走查用的是全新 userData（老用户迁移不触发），所以两档都应是出厂映射
    if (std.model !== 'deepseek-v4-pro') throw new Error(`标准档主模型没钉死：${std.model}`)
    if (std.fast !== 'deepseek-v4-flash') throw new Error(`标准档轻量模型不对：${std.fast}`)
    if (!std.base.includes('api.deepseek.com')) throw new Error(`标准档线路不对：${std.base}`)
    if (enh.model !== 'claude-opus-5') throw new Error(`增强档主模型没钉死成 claude-opus-5：${enh.model}`)
    if (!enh.base.includes('aihubmix.com')) throw new Error(`增强档线路不对：${enh.base}`)
    await win.locator('[data-testid="tier-config-enhanced"]').scrollIntoViewIfNeeded()
    await snap('10h-管理员区-档位映射', 300)
    // 线路检测按钮真点一次：结论必须落到界面上（可用 / 不可用+原因）
    await win.click('[data-testid="tier-check-enhanced"]')
    await win.locator('[data-testid="tier-health-enhanced"]').waitFor({ timeout: 20000 })
    const health = (await win.locator('[data-testid="tier-health-enhanced"]').innerText()).trim()
    if (!/线路可用|不可用/.test(health)) throw new Error(`线路检测没有给出结论：「${health}」`)
    console.log('档位映射 ✓', JSON.stringify({ 标准: std, 增强: enh, 增强线路检测: health }))
  }

  // ---- 计价配置（美元单价 + 汇率）只在管理员区，且改完用量页跟着变 ----
  {
    if (!(await win.locator('[data-testid="pricing-config"]').count()))
      throw new Error('管理员区没有计价配置')
    const rate = await win.locator('[data-testid="price-usdcny"]').inputValue()
    if (Number(rate) !== 7.2) throw new Error(`默认汇率不是 7.2：${rate}`)
    /**
     * B-2 起计价**按线路**配，不再按档位：钱是按线路收的，同一个 deepseek-v4-pro
     * 在官方 ¥4.5、在中转站 $1.69≈¥12.2，差 2.7 倍。所以这里断言的是线路而不是档位。
     *
     * 单价必须逐个钉死数值，不能只断言"存在"：这几个数是从真实账单抄来的，
     * 被顺手改回估值也不会有任何报错——只会让用量页安静地少算一半的钱。
     */
    const dsIn = await win.locator('[data-testid="price-in-deepseek"]').inputValue()
    const dsOut = await win.locator('[data-testid="price-out-deepseek"]').inputValue()
    const dsCache = await win.locator('[data-testid="price-cacheread-deepseek"]').inputValue()
    if (Number(dsIn) !== 4.5 || Number(dsOut) !== 13.5 || Math.abs(Number(dsCache) - 1 / 30) > 1e-4)
      throw new Error(`DeepSeek 官方线路默认价不对：输入 ${dsIn} / 输出 ${dsOut} / 缓存读倍率 ${dsCache}`)
    const ahIn = await win.locator('[data-testid="price-in-aihubmix"]').inputValue()
    const ahCache = await win.locator('[data-testid="price-cacheread-aihubmix"]').inputValue()
    if (Number(ahIn) !== 5 || Number(ahCache) !== 1)
      throw new Error(`aihubmix 线路默认价不对：输入 ${ahIn} / 缓存读倍率 ${ahCache}`)
    // 币种跟着线路走：官方原生人民币不过汇率，中转站按美元折算。
    // 这条错了不会崩，只会让官方线路的估算整体差 7 倍——必须断言到界面上看得见的那句话
    const dsCur = await win.locator('[data-testid="price-currency-deepseek"]').innerText()
    const ahCur = await win.locator('[data-testid="price-currency-aihubmix"]').innerText()
    if (!dsCur.includes('人民币') || !ahCur.includes('美元'))
      throw new Error(`线路币种标注不对：deepseek「${dsCur}」aihubmix「${ahCur}」`)
    // 落盘之后脚本才读得到同一份（usage-report.mjs 的单一真相源）
    const onDisk = await win.evaluate(() => window.api.usage.pricing())
    if (onDisk.usdCny !== 7.2 || onDisk.routes?.deepseek?.default?.in !== 4.5)
      throw new Error('计价配置没有落盘：' + JSON.stringify(onDisk))
    if (onDisk.routes.deepseek.currency !== 'CNY' || onDisk.routes.aihubmix.currency !== 'USD')
      throw new Error('线路币种没落盘：' + JSON.stringify(onDisk.routes.deepseek.currency))
    // 出厂价版本号：错价靠它才能盖过老机器上的存档（见 pricing.ts 的 PRICING_REV）
    if (onDisk.rev !== 3) throw new Error(`计价配置版本不对：${onDisk.rev}`)
    // 缓存读倍率必须分线路存——两条线合成一个数就等于把 B-2 的核心抹掉了
    if (onDisk.routes.deepseek.cacheRead === onDisk.routes.aihubmix.cacheRead)
      throw new Error('两条线路的缓存读倍率相同，按线路分表没生效')
    await win.locator('[data-testid="pricing-config"]').scrollIntoViewIfNeeded()
    await snap('10i-管理员区-计价配置', 300)
    console.log('计价配置 ✓', JSON.stringify(onDisk))
  }

  // ---- H-06 手填 key（现在在管理员区）：输入框 + 重新获取按钮（以前下发失败 = 死路）----
  {
    const keyInput = win.locator('[data-testid="tier-key-input-standard"]')
    if (!(await keyInput.count())) throw new Error('管理员区没有手填 API Key 的输入框')
    if (!(await win.locator('button:has-text("重新获取服务端配置")').count()))
      throw new Error('管理员区没有「重新获取服务端配置」按钮')
    if (!(await win.locator('[data-testid="admin-apibase"]').count()))
      throw new Error('管理员区没有服务器地址输入框')
    const E2E_KEY = 'sk-e2e-manual-key-0123456789'
    await keyInput.fill(E2E_KEY)
    // ---- M-29：保存 key 不再挡路 ----
    // 旧版这颗按钮的 invoke 里同步调 safeStorage，进程内首次调用会把主进程冻住
    // （实测 6s→35s→68s，主进程一卡 CDP 也跟着停），当时只能把这次点击的超时放宽到 10 分钟。
    // 现在写入转成后台任务，点击必须秒回——这里就用它当断言：超过 20s 视为回归。
    const tClick = Date.now()
    await win.click('[data-testid="tier-key-save-standard"]', { timeout: 20000 })
    const clickMs = Date.now() - tClick
    // toast 的等待要给足：点击返回后主进程才开始那次同步加密，冷调用最长实测 60s，
    // 期间 CDP 也停（Playwright 走主进程），所以这里不能拿来当"快不快"的证据——
    // 证据是上面那次 click 的耗时（旧版这里要 10 分钟超时才点得动）
    await win.locator('text=/Key 已生效|未重复写入/').first().waitFor({ timeout: 180000 })
    // 等待态：系统缓存热的时候整个落盘只要几十毫秒，「正在保存」会一闪而过，所以界面在成功后
    // 还会留 3 秒的「已安全保存 ✓」——两态都算数，截图截到哪一态都行
    let hintState = ''
    for (let i = 0; i < 40 && !hintState; i++) {
      if (await win.locator('[data-testid="key-writing"]').count()) hintState = 'writing'
      else if (await win.locator('[data-testid="key-saved"]').count()) hintState = 'saved'
      else await win.waitForTimeout(200)
    }
    const sawHint = !!hintState
    if (sawHint) await rawShot(cdp, '10d-管理员区-密钥保存状态')
    else await snap('10d-管理员区-密钥保存状态', 100)
    if (await win.locator('[data-testid="key-write-failed"]').count())
      throw new Error('密钥落盘失败（界面出了失败提示）')
    // 落盘任务必须走完（写入期间主进程是冻的，evaluate 会一直等，等到了就说明已经解冻）
    const secretTasks = await win.evaluate(async () => {
      const s = await window.api.tasks.list()
      return s.tasks.filter((t) => t.kind === 'secret').map((t) => ({ id: t.id, status: t.status, title: t.title }))
    })
    if (!secretTasks.length) throw new Error('写 key 没有登记 secret 任务（渲染层就没有等待态可显示）')
    if (secretTasks.some((t) => t.status === 'failed'))
      throw new Error('密钥落盘任务失败：' + JSON.stringify(secretTasks))
    console.log('M-29 保存不挡路 ✓', JSON.stringify({ clickMs, 状态提示: hintState || '(没赶上)', tasks: secretTasks }))
    if (!sawHint) throw new Error('保存 key 期间界面没有任何状态提示（等待态/已保存都没出现）')

    const afterKey = await win.evaluate(() => window.api.settings.get())
    if (!afterKey.aiReady) throw new Error('手填 key 保存后默认档仍然不可用（aiReady=false）')
    // 普通模式那一行必须跟着变成「已就绪 ✓」——两处说法不一致是最容易糊弄过去的洞
    await win.locator('[data-testid="ai-ready"]').waitFor({ timeout: 15000 })
    await snap('10b-管理员区-手填key已保存', 300)

    // ---- M-29 写前判重：同一把 key 再存一次，必须零写入 ----
    // 这条就是"老用户重复登录不再冻结"的核心——provisionKeys 每次启动都会走同一条路
    const repeat = await win.evaluate((k) => window.api.settings.setKey(k, 'standard'), E2E_KEY)
    if (repeat.outcome !== 'unchanged')
      throw new Error(`重复保存同一把 key 竟然又写了一次：outcome=${repeat.outcome}`)
    const afterRepeat = await win.evaluate(async () => {
      const s = await window.api.tasks.list()
      return s.tasks.filter((t) => t.kind === 'secret').length
    })
    if (afterRepeat !== secretTasks.length)
      throw new Error(`重复保存新增了 secret 任务：${secretTasks.length} → ${afterRepeat}`)
    console.log('M-29 写前判重 ✓ 同 key 重复保存零写入')
    // 「重新获取」真点：本地模式会失败（未登录），登录态会成功，两种都必须有可见反馈
    await win.click('button:has-text("重新获取服务端配置")')
    // 三种反馈都算数：本地模式=获取失败；登录且配置有变=已重新获取；登录且配置没变=无变化
    // （最后这条是 M-29 判重的直接体现，E2E_CHAT 跑到的就是它）
    await win.locator('text=/已重新获取服务端配置|获取失败|无变化/').first().waitFor({ timeout: 15000 })
    const provText = await win.locator('text=/已重新获取服务端配置|获取失败|无变化/').first().innerText()
    await snap('10c-管理员区-重新获取反馈', 200)
    console.log('H-06 手填 key + 重新获取 ✓', JSON.stringify({ 反馈: provText.trim() }))
  }

  // ---- 用量：设置页摘要 → 用量页（先验空态，再用桩数据验读取链路）----
  {
    // 空态：本地模式没跑过真实 AI 调用，本月就该是零记录
    const brief0 = (await win.locator('[data-testid="usage-brief"]').innerText()).trim()
    // 前面几步（解锁、存 key、重新获取）留下的 toast 会糊在页头上，等它们散掉再进用量页截图
    await win.locator('[data-testid="toast"]').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
    await win.click('[data-testid="open-usage"]')
    await win.locator('[data-testid="usage-empty"], [data-testid="usage-daily"]').first().waitFor({ timeout: 15000 })
    if (CHAT) {
      // E2E_CHAT 跑过真实对话，这里本来就该有数据（空态那张截图由本地模式那轮刷）
      console.log('用量页（E2E_CHAT，有真实记录）', JSON.stringify({ 摘要: brief0 }))
    } else {
      if (!(await win.locator('[data-testid="usage-empty"]').count()))
        throw new Error('本月零记录时用量页没有空态引导')
      await snap('47-用量页-空态', 400)
      await assertNoOldBrand('用量页')
      await assertNoRose('用量页')
    }

    // 桩数据：直接往 userData/usage/YYYY-MM.jsonl 追加几条，验"落盘格式 → 汇总 → 页面"这条读取链路
    const ym = new Date().toISOString().slice(0, 7)
    const usageDir = join(userData, 'usage')
    mkdirSync(usageDir, { recursive: true })
    const stub = [
      // B-2 起记录带 `route`：钱按线路收，同一模型在官方与中转站差 6 倍
      { ts: Date.now() - 86400000, sessionId: 'e2e-1', taskType: 'chat', tier: 'standard', route: 'deepseek', expected_model: 'deepseek-v4-pro', resolved_model: 'deepseek-v4-pro', models: ['deepseek-v4-pro'], degraded: false, durationMs: 4200, usage: { usage: { input_tokens: 900, output_tokens: 300 }, modelUsage: { 'deepseek-v4-pro': { inputTokens: 900, outputTokens: 300 } } } },
      // 增强档带 100000 缓存读：B-2 的核心（缓存按模型倍率折价）此前完全没被走查覆盖，
      // 不给缓存 token 的话，把倍率改成 1 或 0.1 这条断言都发现不了
      { ts: Date.now() - 3600000, sessionId: 'e2e-2', taskType: 'make-ppt', tier: 'enhanced', route: 'aihubmix', expected_model: 'claude-opus-5', resolved_model: 'claude-opus-5', models: ['claude-opus-5'], degraded: false, durationMs: 52000, usage: { usage: { input_tokens: 22000, cache_read_input_tokens: 100000, output_tokens: 4000 }, modelUsage: { 'claude-opus-5': { inputTokens: 22000, cacheReadInputTokens: 100000, outputTokens: 4000 } } } },
      { ts: Date.now() - 600000, sessionId: 'e2e-3', taskType: 'ingest-tag', tier: null, expected_model: 'deepseek-v4-flash', resolved_model: null, durationMs: 91000, usage: null, calls: 1 },
    ]
    const before = await win.evaluate(() => window.api.usage.summary())
    writeFileSync(join(usageDir, `${ym}.jsonl`), stub.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: 'a' })
    await win.click('text=刷新')
    await win.waitForTimeout(800)
    const after = await win.evaluate(() => window.api.usage.summary())
    if (after.chatCount !== before.chatCount + 1)
      throw new Error(`桩数据没被算进对话次数：${before.chatCount} → ${after.chatCount}`)
    if (after.artifactCount !== before.artifactCount + 1)
      throw new Error(`桩数据没被算进产物数：${before.artifactCount} → ${after.artifactCount}`)
    // 归一化：两档的 token 合计要分开算（口径不同，不挑字段、汇总侧归一）
    const enhRow = after.byTier.find((t) => t.tier === 'enhanced')
    const stdRow = after.byTier.find((t) => t.tier === 'standard')
    if (!enhRow || enhRow.total < 26000) throw new Error(`增强档 token 合计不对：${JSON.stringify(enhRow)}`)
    if (!stdRow || stdRow.total < 1200) throw new Error(`标准档 token 合计不对：${JSON.stringify(stdRow)}`)
    // 拿不到 usage 的入库打标只记次数，token 显示「—」
    const tagRow = after.byType.find((r) => r.type === 'ingest-tag')
    if (!tagRow || tagRow.count < 1) throw new Error('入库打标那条没被记成次数')
    if (tagRow.tokens !== 0) throw new Error(`入库打标不该有 token：${tagRow.tokens}`)

    // 页面结构：三个大数字 / 14 天柱状图 / 档位对比 / 类型细分 / 两条脚注
    for (const [id, name] of [
      ['usage-chat-count', '本月对话大数字'],
      ['usage-artifact-count', '本月产物大数字'],
      ['usage-daily', '最近 14 天柱状图'],
      ['usage-by-tier', '按档位对比区'],
      ['usage-by-type', '按任务类型表'],
      ['usage-token-note', 'tokens 口径脚注'],
      // usage-cost / usage-cost-note 默认**不该存在**：金额对客户隐藏（2026-08-18），
      // 它们只在管理员区打开开关后出现，验在下面那段
    ]) {
      if (!(await win.locator(`[data-testid="${id}"]`).count())) throw new Error(`用量页缺少${name}`)
    }

    // ---- 金额对客户隐藏；管理员开关打开后按成本价正确显示 ----
    {
      /**
       * **金额默认不给客户看**（2026-08-18）：页面算的是成本价，摆出来等于把进货价摊开，
       * 而商业化定价还没定。所以普通模式下整页不许出现任何 ¥ 金额；
       * 计价能力本身没删，管理员区那颗开关打开后金额要能正确显示。
       */
      const noMoneyText = (await win.locator('main').innerText()).replace(/\s+/g, ' ')
      if (/¥/.test(noMoneyText))
        throw new Error(`普通模式的用量页出现了金额：「${noMoneyText.slice(0, 200)}」`)
      if (await win.locator('[data-testid="usage-cost"]').count())
        throw new Error('普通模式仍然渲染了「本月估算花费」卡片')
      // 量还得在：次数与 tokens 是客户判断消耗的依据，不能跟着金额一起藏掉
      const enhCost = (await win.locator('[data-testid="usage-tier-enhanced"]').innerText()).replace(/\s+/g, ' ')
      for (const col of ['次', 'tokens', '缓存读']) {
        if (!enhCost.includes(col)) throw new Error(`档位对比区缺「${col}」：「${enhCost}」`)
      }
      console.log('用量页金额默认隐藏 ✓', JSON.stringify({ 档位对比: enhCost.slice(0, 80) }))

      /**
       * 打开管理员区的开关后，金额要按**成本价**正确显示。
       * 桩数据：增强档走 aihubmix 的 claude-opus-5（$5/$25，**缓存读倍率 0.1**）
       *   纯 input 22000 × 5    = 0.110
       *   缓存读 100000 × 5 ×0.1 = 0.050
       *   output  4000 × 25     = 0.100
       *   合计 $0.26 × 7.2 ≈ **¥1.87**
       * 单价与倍率都来自 2026-08-18 的 aihubmix 账单反解（B-2）：旧值 $15/$75 是 Anthropic
       * 官方标价而我们走中转站；缓存倍率**按模型**——同线路上 opus 打 0.1、deepseek 不打折。
       * 倍率若被误设回 1.0，这里会算出 ¥4.46，被下面的区间挡住。
       */
      await win.evaluate(() => window.api.settings.setShowCost(true))
      await win.click('text=刷新')
      await win.waitForTimeout(600)
      const withCost = (await win.locator('[data-testid="usage-tier-enhanced"]').innerText()).replace(/\s+/g, ' ')
      const m = withCost.match(/¥([\d.]+)/)
      if (!m) throw new Error(`开关打开后仍未显示金额：「${withCost}」`)
      const cny = Number(m[1])
      if (!(cny > 1.6 && cny < 2.2))
        throw new Error(`增强档花费换算不对（期望 ¥1.87 上下；¥4.4 左右说明缓存倍率没生效）：¥${cny}`)
      console.log('管理员开关打开后金额 ✓', JSON.stringify({ 增强档: `¥${cny}` }))
      /**
       * 金额旁边这两句话是**对账查出来的**，不是凑文案：
       *  · 入库打标拿不到 token 就没计价——实测一天，账单上 flash 有 27.8 万 input，
       *    账本里只有 4,302，98.7% 的打标花费不在这个数里。不写明白，用户会拿它当总花费。
       *  · 官方分时计价，同一模型不同时段单价实测差一倍，固定单价估不准。
       * 两句都删得掉、删了也不会报错，所以在这里钉死。
       */
      const costNote = (await win.locator('[data-testid="usage-cost-note"]').innerText()).replace(/\s+/g, '')
      if (!/入库打标.*没有计入|没有计入/.test(costNote))
        throw new Error(`费用脚注没说明"打标不计入"：「${costNote}」`)
      if (!/分时计价/.test(costNote)) throw new Error(`费用脚注没说明分时计价：「${costNote}」`)
      if (/\*\*/.test(costNote)) throw new Error(`费用脚注里有没渲染的 Markdown 星号：「${costNote}」`)
      // 开金额是运维态，那两条「不含打标 / 分时有偏差」的说明只在这个态下才出现，
      // 单独留一张截图给人工验收——默认态那两张（47b/47c）里根本看不到它们
      await win.locator('[data-testid="usage-cost-note"]').scrollIntoViewIfNeeded()
      await snap('47d-用量页-管理员开金额与口径说明', 400)
      await win.evaluate(() => window.api.settings.setShowCost(false))
      await win.click('text=刷新')
      await win.waitForTimeout(400)
      // 关掉之后类型表只剩 tokens，不带金额
      const typeText = (await win.locator('[data-testid="usage-by-type"]').innerText()).replace(/\s+/g, ' ')
      if (/¥/.test(typeText)) throw new Error(`关掉开关后类型表仍有金额：「${typeText}」`)
      if (!/[\d,]+ tokens/.test(typeText)) throw new Error(`类型表没有 tokens 列：「${typeText}」`)
      // 整页不许出现美元单价（那是管理员区的事）
      const pageText = await win.evaluate(() => document.querySelector('main')?.innerText ?? '')
      if (/\$\d/.test(pageText)) throw new Error('用量页出现了美元单价（应当只在管理员区）')
      if (await win.locator('[data-testid="usage-cost-note"]').count())
        throw new Error('关掉开关后费用脚注仍在（脚注只在显示金额时才该出现）')
      console.log('用量页金额开关 ✓', JSON.stringify({ 默认: '无金额', 开关打开后增强档: `¥${cny}` }))
    }
    const bars = await win.locator('[data-testid="usage-daily"] > div').count()
    if (bars !== 14) throw new Error(`柱状图不是 14 根柱子：${bars}`)
    // 柱子必须**真的有高度**：百分比高度算不出来时整片图是空白，而"14 根 div 在"照样通过
    // （第一版就是这么漏过去的，靠人看截图才发现），所以这里量的是像素
    const barBox = await win.evaluate(() => {
      const cols = [...document.querySelectorAll('[data-testid="usage-daily"] > div')]
      const withData = cols.map((c) => c.firstElementChild).filter((b) => Number(b?.dataset.count) > 0)
      return {
        有记录的天数: withData.length,
        最高柱: Math.max(0, ...withData.map((b) => b.getBoundingClientRect().height)),
      }
    })
    if (barBox.有记录的天数 < 1) throw new Error('桩数据没落到最近 14 天里')
    if (barBox.最高柱 < 20) throw new Error(`柱状图渲染出来是平的（最高柱 ${barBox.最高柱}px）`)

    /**
     * 档位分段（同柱堆叠）。桩数据里今天有一条增强 + 一条无档位（老记录算标准），
     * 所以今天那根柱子**必须两段都在**；只有单档的日期照常单段。
     * 断言量的是**像素**不是 div 个数——分段高度算成 0 的话，"两个 div 都在"照样通过
     * （14 天柱状图第一版就是这么漏过去的）。
     */
    const seg = await win.evaluate(() => {
      const cols = [...document.querySelectorAll('[data-testid="usage-daily"] > div')]
      const bars = cols.map((c) => c.firstElementChild).filter((b) => Number(b?.dataset.count) > 0)
      const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
      const hex2rgb = (h) => {
        const m = h.replace('#', '')
        return `rgb(${parseInt(m.slice(0, 2), 16)}, ${parseInt(m.slice(2, 4), 16)}, ${parseInt(m.slice(4, 6), 16)})`
      }
      const both = bars.find((b) => Number(b.dataset.standard) > 0 && Number(b.dataset.enhanced) > 0)
      const segOf = (bar, name) => {
        const el = bar?.querySelector(`[data-seg="${name}"]`)
        return el ? { h: Math.round(el.getBoundingClientRect().height), bg: getComputedStyle(el).backgroundColor } : null
      }
      const legend = [...document.querySelectorAll('[data-testid="usage-daily-legend"] [data-legend]')].map((e) => ({
        k: e.dataset.legend,
        label: e.textContent.trim(),
        dot: getComputedStyle(e.querySelector('i')).backgroundColor,
      }))
      return {
        混合柱: both ? { std: segOf(both, 'standard'), enh: segOf(both, 'enhanced'), d: { ...both.dataset } } : null,
        单档柱数: bars.filter((b) => Number(b.dataset.standard) === 0 || Number(b.dataset.enhanced) === 0).length,
        legend,
        want: { standard: hex2rgb(css('--color-tier-standard')), enhanced: hex2rgb(css('--color-tier-enhanced')) },
      }
    })
    if (!seg.混合柱) throw new Error('没有一根柱子同时含标准与增强，分档断言等于空过')
    if (!seg.混合柱.std || seg.混合柱.std.h < 3) throw new Error(`标准档那一段没画出来：${JSON.stringify(seg.混合柱)}`)
    if (!seg.混合柱.enh || seg.混合柱.enh.h < 3) throw new Error(`增强档那一段没画出来：${JSON.stringify(seg.混合柱)}`)
    if (seg.混合柱.std.bg !== seg.want.standard || seg.混合柱.enh.bg !== seg.want.enhanced)
      throw new Error(`分段颜色与 token 对不上：${JSON.stringify({ 实际: seg.混合柱, 期望: seg.want })}`)
    if (seg.legend.length !== 2) throw new Error(`柱状图图例应有两项，实为 ${seg.legend.length}`)
    for (const it of seg.legend) {
      if (it.dot !== seg.want[it.k]) throw new Error(`图例「${it.label}」色点 ${it.dot} 与 token 对不上`)
    }
    console.log('用量柱状图分档 ✓', JSON.stringify({ 混合柱: seg.混合柱.d, 单档柱数: seg.单档柱数, 图例: seg.legend.map((l) => l.label) }))

    /**
     * 深色仪表盘卡片（2026-08-18 微调）：**只有这一张卡是深色**，页面其余部分维持暖白纸面。
     * 断言取渲染态的实际颜色比 token，不认 class 名——`.chart-dark` 是靠就地改写 CSS 变量生效的，
     * 类名写对了但变量没接上，界面会安静地退回浅色（同 `bg-x/60` 那类坑）。
     */
    const dash = await win.evaluate(() => {
      const card = document.querySelector('[data-testid="usage-daily"]')?.closest('.chart-dark')
      if (!card) return null
      const cs = getComputedStyle(card)
      const axis = card.parentElement?.querySelector('[data-testid="usage-daily-legend"]')
      const dateAxis = [...card.querySelectorAll('div')].find((d) => /^\d{2}\/\d{2}$/.test(d.textContent.trim()))
      // 页面其余区域必须还是浅色：拿「按模式对比」那张卡对照
      const light = document.querySelector('[data-testid="usage-by-tier"]')?.closest('.rounded-xl')
      return {
        cardBg: cs.backgroundColor,
        cardInk: cs.color,
        axisText: dateAxis ? getComputedStyle(dateAxis).color : null,
        gridCount: card.querySelectorAll('[aria-hidden] .border-t').length,
        legendInDark: !!axis && !!axis.closest('.chart-dark'),
        lightCardBg: light ? getComputedStyle(light).backgroundColor : null,
      }
    })
    if (!dash) throw new Error('用量页找不到深色仪表盘卡片（.chart-dark）')
    if (dash.cardBg !== 'rgb(33, 31, 28)') throw new Error(`仪表盘卡片底色不是炭黑：${dash.cardBg}`)
    if (dash.lightCardBg !== 'rgb(255, 255, 255)')
      throw new Error(`页面其余卡片应保持浅色，实为 ${dash.lightCardBg}（深色只该有一块，两块就没有焦点了）`)
    if (dash.gridCount < 3) throw new Error(`网格线只有 ${dash.gridCount} 条`)
    if (!dash.legendInDark) throw new Error('两色图例没跟着进深色卡')
    console.log('深色仪表盘卡 ✓', JSON.stringify(dash))

    // 悬停出明细：日期 + 两档次数（原生 title 换成了自绘 tooltip，深底上才统一）
    {
      const col = win.locator('[data-testid="usage-daily"] > div').nth(13)
      await col.hover()
      await win.locator('[data-testid="usage-bar-tooltip"]').waitFor({ timeout: 4000 })
      const tip = (await win.locator('[data-testid="usage-bar-tooltip"]').innerText()).replace(/\s+/g, ' ')
      if (!/\d{4}-\d{2}-\d{2}/.test(tip) || !/标准 \d+ 次/.test(tip) || !/增强 \d+ 次/.test(tip))
        throw new Error(`悬停明细没说清日期与两档次数：「${tip}」`)
      await snapHover('47e-用量页-柱状图悬停明细')
      console.log('柱状图悬停明细 ✓', JSON.stringify({ tip }))
      await win.mouse.move(4, 4)
    }
    const note = (await win.locator('[data-testid="usage-token-note"]').innerText()).replace(/\s+/g, '')
    // tokens 含哪几项、以及打标为什么显示「—」，两件事都得写出来
    if (!/缓存读/.test(note) || !/只记次数/.test(note))
      throw new Error(`tokens 脚注没说清口径：「${note}」`)
    // 配额进度条本期是隐藏的占位（将来按量计费启用）
    if (await win.locator('[data-testid="usage-quota"]').count())
      throw new Error('配额进度条本期不该显示（只是预留组件位）')
    // 前面几步的 toast 会糊在页头上，等它们自己散掉再截（截图是拿来人工验收的）
    await win.locator('[data-testid="toast"]').first().waitFor({ state: 'detached', timeout: 12000 }).catch(() => {})
    await snap('47b-用量页-有数据', 500)
    // 类型表与口径脚注在首屏之下，单独截一张
    await win.locator('[data-testid="usage-token-note"]').scrollIntoViewIfNeeded()
    await snap('47c-用量页-按类型与口径脚注', 400)
    console.log(
      '用量页 ✓',
      JSON.stringify({ 摘要: brief0, 对话: after.chatCount, 产物: after.artifactCount, 档位: after.byTier })
    )

    // 回设置页，别把后面的步骤留在用量页上
    await win.click('text=设置')
    await win.waitForTimeout(500)
  }

  // ---- M-03 syncQueue 真重试：退避阶梯 → 转手动 → Dock「重试」→ 成功后自动清队 ----
  // 需要登录（未登录时 syncConversation 直接返回，本来就不算失败），所以只在 E2E_CHAT 下跑
  if (CHAT) {
    const readQueue = () => {
      try {
        return JSON.parse(readFileSync(join(userData, 'tasks.json'), 'utf-8')).syncQueue ?? []
      } catch {
        return []
      }
    }
    const waitQueue = async (pred, ms = 30000) => {
      const t0 = Date.now()
      let q = readQueue()
      while (Date.now() - t0 < ms && !pred(q)) {
        await win.waitForTimeout(400)
        q = readQueue()
      }
      return q
    }
    const badConv = crypto.randomUUID()
    // 制造一次**真实**的同步失败：messages.role 有 CHECK 约束（migration 001），
    // 'bogus' 必被 Postgres 拒。之后换成合法 role 再存一次就会成功——正好验"恢复后自动清空"
    const saveBad = () =>
      win.evaluate(
        (id) =>
          window.api.chat.save({
            id,
            title: 'e2e 同步失败样例',
            messages: [{ role: 'bogus', text: '这条会被 Supabase 拒掉' }],
            updatedAt: Date.now(),
          }),
        badConv
      )

    await saveBad()
    let q = await waitQueue((x) => x.some((i) => i.convId === badConv))
    let item = q.find((i) => i.convId === badConv)
    if (!item) throw new Error('同步失败没有落进 syncQueue（M-03 的"别蒸发"不成立）')
    // 退避阶梯第 1 档 = 1 分钟（设计 §3.5 写死的值）
    let delay = item.nextRetryAt - Date.now()
    if (item.tries !== 1 || delay < 30_000 || delay > 70_000)
      throw new Error('第 1 次失败的退避不是 ~1 分钟：' + JSON.stringify(item))
    console.log('syncQueue 入队 ✓', JSON.stringify({ tries: item.tries, 退避秒: Math.round(delay / 1000) }))

    // Dock 上必须看得见「N 条待同步」+「重试」出口
    const dockText = await (async () => {
      for (let i = 0; i < 40; i++) {
        const open = await win
          .locator('[data-testid="task-dock"]')
          .evaluate((el) => getComputedStyle(el).maxHeight !== '0px')
        if (open) {
          const t = await win.locator('[data-testid="task-dock-btn"]').innerText()
          if (/条待同步/.test(t)) return t
        }
        await win.waitForTimeout(500)
      }
      return ''
    })()
    if (!dockText) throw new Error('Dock 上看不到「N 条待同步」')
    if (!(await win.locator('[data-testid="sync-retry"]').count()))
      throw new Error('Dock 上没有「重试同步」出口（转手动之后就没救了）')
    await snap('39-Dock-待同步与重试入口', 200)
    console.log('M-03 可见性 ✓', JSON.stringify(dockText.replace(/\s+/g, ' ')))

    // 退避阶梯：5 分钟 → 30 分钟 → 转手动（nextRetryAt=0，不再自动重试）
    const LADDER = [
      [4.5 * 60_000, 5.5 * 60_000],
      [29 * 60_000, 31 * 60_000],
    ]
    for (let n = 0; n < LADDER.length; n++) {
      const before = item.tries
      await saveBad()
      q = await waitQueue((x) => (x.find((i) => i.convId === badConv)?.tries ?? 0) > before)
      item = q.find((i) => i.convId === badConv)
      delay = item.nextRetryAt - Date.now()
      if (delay < LADDER[n][0] || delay > LADDER[n][1])
        throw new Error(`第 ${item.tries} 次失败的退避不在阶梯上：${Math.round(delay / 1000)}s`)
    }
    await saveBad() // 第 4 次：超出阶梯 → 转手动
    q = await waitQueue((x) => (x.find((i) => i.convId === badConv)?.tries ?? 0) >= 4)
    item = q.find((i) => i.convId === badConv)
    if (item.tries !== 4 || item.nextRetryAt !== 0)
      throw new Error('第 4 次失败没有转手动：' + JSON.stringify(item))
    console.log('退避阶梯 ✓ 1m → 5m → 30m → 转手动')

    // 「重试」真点：整队 tries 归零并立刻跑一轮。这次还是会失败（role 依旧非法），
    // 所以 tries 从 4 变回 1 —— 这正是"真的重跑过一轮"的证据
    await win.click('[data-testid="sync-retry"]')
    q = await waitQueue((x) => (x.find((i) => i.convId === badConv)?.tries ?? 9) === 1, 40000)
    item = q.find((i) => i.convId === badConv)
    if (item?.tries !== 1) throw new Error('点「重试同步」后队列没有被真的重跑：' + JSON.stringify(item))
    console.log('手动重试 ✓ tries 4 → 归零 → 重跑失败回到 1')

    // 恢复后自动清队：同一条会话换成合法内容再存一次，成功即出队
    await win.evaluate(
      (id) =>
        window.api.chat.save({
          id,
          title: 'e2e 同步失败样例',
          messages: [{ role: 'user', text: 'e2e 同步恢复验证' }],
          updatedAt: Date.now(),
        }),
      badConv
    )
    q = await waitQueue((x) => !x.some((i) => i.convId === badConv), 40000)
    if (q.some((i) => i.convId === badConv)) throw new Error('同步成功后队列没清掉这条')
    // pendingSync 是队列长度的投影：这里不能直接断言 0（走查后面还会造别的失败会话），
    // 断言"跟盘上的队列一致"才是真相源一致性
    const pend = await win.evaluate(async () => (await window.api.tasks.list()).cloud.pendingSync)
    if (pend !== readQueue().length)
      throw new Error(`cloud.pendingSync(${pend}) 与盘上的队列(${readQueue().length}) 对不上`)
    console.log('M-03 恢复后自动清队 ✓')
  } else {
    console.log('⚠️ 未开 E2E_CHAT，跳过 syncQueue 重试断言（需要登录态才能制造真实同步失败）')
  }

  // ---- 首页「最近对话」卡片区：造两条历史会话，重载后应同时出现在侧栏和首页卡片区 ----
  await win.evaluate(async () => {
    const now = Date.now()
    await window.api.chat.save({ id: 'e2e-conv-1', title: 'e2e 历史会话一', messages: [], updatedAt: now })
    await window.api.chat.save({ id: 'e2e-conv-2', title: 'e2e 历史会话二', messages: [], updatedAt: now - 60000 })
  })
  await win.reload()
  await win.waitForTimeout(2000)
  if (!(await win.locator('text=最近对话').count())) throw new Error('首页缺「最近对话」卡片区')
  if (!(await win.locator('button:has-text("e2e 历史会话一")').count())) throw new Error('最近对话卡片没有渲染会话')
  await snap('16-首页-最近对话卡片区', 400)
  // 卡片真点：应切到那条会话（首页空态消失）
  await win.locator('button:has-text("e2e 历史会话二")').last().click()
  await win.waitForTimeout(500)
  await snap('17-最近对话卡片-点开会话', 200)
  await win.click('button[title="新对话"]')
  await win.waitForTimeout(600)

  // ---- H-03 删除对话：二次确认（带对话标题）+ 删除后 toast，与笔记删除同一套标准 ----
  {
    const row = win.locator('aside div.group').filter({ hasText: 'e2e 历史会话一' }).first()
    const delBtn = row.locator('button[title="删除对话"]')
    /**
     * ✕ 是 `group-hover:block` 才出的，**hover 一次不一定站得住**：
     * 上一步的 `snap()` 会把 `:hover` 清掉（§4-15），页面淡入期间元素还在动，
     * 于是偶发地 hover 完按钮仍是 `display:none`，click 就在"等它可见"上耗到 30 秒超时
     * （2026-08-19 撞到一次；同一份代码前两轮都过，属走查侧偶发）。
     * **断言没有放松**——仍然要求 hover 之后按钮真的可见才点，只是允许多试几次。
     */
    let hovered = false
    for (let i = 0; i < 10 && !hovered; i++) {
      await row.hover({ force: true }).catch(() => {})
      await win.waitForTimeout(200)
      hovered = await delBtn.isVisible().catch(() => false)
    }
    if (!hovered) throw new Error('侧栏会话 hover 后「删除对话」按钮始终不可见（group-hover 失效？）')
    await delBtn.click()
    await win.locator('text=确认删除这个对话？').waitFor({ timeout: 5000 })
    const delMsg = await win.locator('.whitespace-pre-line').first().innerText()
    if (!delMsg.includes('e2e 历史会话一')) throw new Error(`删除对话确认没显示标题：「${delMsg}」`)
    await snap('23-删除对话-二次确认', 200)
    // 取消：对话必须还在
    await win.click('[data-testid="modal"] button:has-text("取消")')
    await win.waitForTimeout(300)
    if (!(await win.locator('aside button:has-text("e2e 历史会话一")').count()))
      throw new Error('取消删除后对话却没了')
    // 确认删除：toast + 侧栏里消失
    await row.hover()
    await row.locator('button[title="删除对话"]').click()
    await win.locator('text=确认删除这个对话？').waitFor({ timeout: 5000 })
    await win.click('[data-testid="modal"] button:has-text("删除")')
    await win.locator('text=已删除对话').waitFor({ timeout: 5000 })
    await snap('23b-删除对话-完成toast', 200)
    await win.waitForTimeout(500)
    if (await win.locator('aside button:has-text("e2e 历史会话一")').count())
      throw new Error('确认删除后对话还在侧栏里')
    console.log('H-03 删除对话确认 + toast ✓')
  }

  // ---- 产物卡片：文件类型图标 + hover 出操作按钮，逐个真点 ----
  // 放在最后跑：「入库」会真的排队跑 pipeline，不让它影响前面的投递箱断言
  // 首页面板默认收起，先点收起态的入口把它展开
  await win.click('button[title="打开产物面板"]')
  await win.waitForTimeout(400)
  if (!(await win.locator('text=90_产物/').count())) throw new Error('点收起态入口后产物面板没展开')
  await snap('12b-产物面板-手动展开', 200)
  const cardPpt = win.locator('div.group:has([title="e2e课件.pptx"])').first()
  if (!(await cardPpt.count())) throw new Error('产物面板没有 e2e课件.pptx 卡片')
  // 静态时不应露出操作按钮（hover 才出）
  const beforeHover = await cardPpt.locator('button:has-text("入库")').isVisible().catch(() => false)
  const openBtn = cardPpt.locator('button:has-text("打开")').first()
  const ingestBtn = cardPpt.locator('button:has-text("入库")').first()
  /**
   * hover 态要轮询 + 重试一次，别采样一次就判死：光标停着不动时，
   * 产物列表被 watcher 事件刷新一次就可能把光标底下那个节点换掉，
   * 而 :hover 要等下一次鼠标移动才重算（2026-08-18 走查现场撞到一次，
   * 隔离脚本里怎么都复现不出来）。**失败时把现场 dump 出来**——
   * "没 hover 上"和"按钮压根没渲染"长得一模一样，只报一句话等于让下一个人重猜一遍。
   */
  await hoverUntilVisible(cardPpt, [openBtn, ingestBtn], '产物卡片「打开/入库」', 'div.group:has([title="e2e课件.pptx"])')
  if (beforeHover) throw new Error('产物卡片没 hover 时就露出了操作按钮')
  await snapHover('13-产物卡片-hover操作')
  console.log('产物卡片 hover ✓（静态隐藏 → hover 出「打开/入库」）')

  // ---- M-05 产物「打开」失败：以前 shell.openPath 的错误被丢掉，点了毫无反应 ----
  // 把磁盘上那个产物删掉（面板列表还留着这张卡，正是"链接指向已不在的文件"这个真实场景）
  {
    const gone = 'e2e数据表.xlsx'
    rmSync(join(artifactDir, gone), { force: true })
    const cardGone = win.locator(`div.group:has([title="${gone}"])`).first()
    if (!(await cardGone.count())) throw new Error('产物面板里找不到 e2e数据表.xlsx 卡片')
    // 刚 rmSync 掉一个产物 → watcher 会把列表重渲染一次，光标底下的节点被换掉、
    // hover 态跟着丢（同 hoverUntilVisible 的注释）。先等 toast 散掉再确认按钮真的在
    await win.locator('[data-testid="toast"]').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
    const goneOpen = cardGone.locator('button:has-text("打开")').first()
    await hoverUntilVisible(cardGone, goneOpen, '产物卡片「打开」（文件已被删）', `div.group:has([title="${gone}"])`)
    await goneOpen.click()
    await win.locator('[data-testid="toast"]').first().waitFor({ timeout: 8000 })
    const openToast = await win.locator('[data-testid="toast"]').first().innerText()
    if (!/打不开产物/.test(openToast)) throw new Error(`产物打不开时没有提示：「${openToast}」`)
    // 光说"不行"不够，得给出口
    const act = await win.locator('[data-testid="toast-action"]').first().innerText()
    if (!/Finder/.test(act)) throw new Error(`打不开产物的提示上没有兜底出口：「${act}」`)
    await snap('44-产物打开失败-提示与Finder出口', 200)
    await grabToastGeo('产物打不开(error/带按钮)')
    console.log('M-05 产物打开失败 ✓', JSON.stringify({ toast: openToast.trim(), 出口: act.trim() }))
  }

  // ---- 产物入库三态：未入库 →（点）入库中 → 已入库 ✓，并能点开落位笔记 ----
  {
    // 用真 docx（假 pptx 转换必失败，测不到「已入库」）
    const cardDoc = win.locator('div.group:has([title="e2e产物样例.docx"])').first()
    if (!(await cardDoc.count())) throw new Error('产物面板没有 e2e产物样例.docx 卡片')
    await cardDoc.hover()
    await win.waitForTimeout(200)
    if (await cardDoc.locator('[data-testid="ingest-done"]').count())
      throw new Error('还没入库就显示「已入库」')
    await cardDoc.locator('button:has-text("入库")').click()
    await win.locator('text=已送入投递箱').waitFor({ timeout: 5000 })
    await snap('14-产物卡片-入库toast', 200)

    // 入库中：任务层驱动的忙态（切页面回来也还在，因为状态不在这个组件里）
    await cardDoc.hover()
    await win.locator('[data-testid="ingest-busy"]').first().waitFor({ timeout: 20000 })
    await snapHover('29-产物入库-入库中')
    console.log('入库三态 · 入库中 ✓')

    /**
     * 已入库：等本轮 pipeline 跑完（真 docx 应当转换成功）。
     *
     * 上限 320 秒 → 600 秒（2026-08-18 品牌二期走查实测被这条卡住）：这一步排在
     * 投递箱/取消那些用例后面，入库任务往往**排在别人后面等**，而 A-3 之后每轮
     * pipeline 末尾还要给全库跑一遍实体建卡（日志：`建卡完成：扫 112 篇`）。
     * 实测那次入库在断言超时后 **18 秒**才落地——产品没坏，是这个上限成了临界值
     * （同 `waitInboxIdle` 从 5 分钟提到 10 分钟那次的成因）。
     * 顺带每 30 秒打一次任务状态：光等不打，超时了只能靠事后翻日志倒推。
     */
    let done = false
    for (let i = 0; i < 300 && !done; i++) {
      done = (await win.locator('[data-testid="ingest-done"]').count()) > 0
      if (!done) {
        if (i > 0 && i % 15 === 0) {
          const st = await win.evaluate(async () => {
            const s = await window.api.tasks.list()
            return s.tasks.filter((x) => x.kind === 'ingest').map((x) => `${x.title}=${x.status}`)
          })
          console.log(`  等入库 ${i * 2}s：${st.join(' / ') || '（没有 ingest 任务）'}`)
        }
        await win.waitForTimeout(2000)
      }
    }
    if (!done) {
      // 失败时把**三边**都打出来：主进程任务快照 / 落盘的已入库表 / 渲染层拿到的表。
      // 只打主进程那一边的话，"主进程说成了、界面没动"与"主进程压根没成"长得一模一样
      const t = await win.evaluate(async () => {
        const s = await window.api.tasks.list()
        return {
          主进程任务: s.tasks.filter((x) => x.kind === 'ingest').map((x) => ({ t: x.title, s: x.status, e: x.error })),
          已入库表: await window.api.artifacts.ingested(),
        }
      })
      throw new Error('产物入库没有走到「已入库」：' + JSON.stringify(t))
    }
    await cardDoc.hover()
    await snapHover('30-产物入库-已入库')

    // 落盘表：重载后仍然认得「已入库」（不是内存里的一次性状态）
    await win.reload()
    await win.waitForTimeout(2500)
    await win.click('button[title="打开产物面板"]').catch(() => {})
    await win.waitForTimeout(600)
    const card2 = win.locator('div.group:has([title="e2e产物样例.docx"])').first()
    await card2.hover()
    await win.waitForTimeout(300)
    if (!(await card2.locator('[data-testid="ingest-done"]').count()))
      throw new Error('reload 后「已入库」状态没了（ingested 表没落盘）')
    await snapHover('31-已入库状态-重载后仍在')
    // 点「已入库」应跳到知识库页并打开落位笔记
    const ing = await win.evaluate(() => window.api.artifacts.ingested())
    if (!ing['e2e产物样例.docx']?.noteRel)
      throw new Error('已入库表里没有落位笔记路径：' + JSON.stringify(ing['e2e产物样例.docx']))
    await card2.locator('[data-testid="ingest-done"]').click()
    await win.waitForTimeout(2500)
    if (!(await win.locator('[data-testid="tree-col"]').count()))
      throw new Error('点「已入库」没有跳到知识库页（noteRel=' + ing['e2e产物样例.docx'].noteRel + '）')
    await snap('32-已入库-点开落位笔记', 400)
    console.log('入库三态 ✓（未入库 → 入库中 → 已入库，且重载后仍在）')
    // 回工作台并把产物面板重新展开：后面还有 md 预览要测
    await win.locator('button[title="新对话"]').click()
    await win.waitForTimeout(600)
    await win.click('button[title="打开产物面板"]').catch(() => {})
    await win.waitForTimeout(400)
  }

  // md 产物的「预览」真点：卡片内应渲染出正文
  const cardMd = win.locator('div.group:has([title="e2e说明.md"])').first()
  await cardMd.hover()
  await win.waitForTimeout(200)
  await cardMd.locator('button:has-text("预览")').click()
  await win.locator('text=这是走查用的产物预览内容').waitFor({ timeout: 5000 })
  await cardMd.hover()
  await snapHover('15-产物卡片-md预览')

  // 「打开」真点：交系统默认应用打开（md → 文本编辑器），只验证点击链路不报错
  await cardMd.hover()
  await cardMd.locator('button:has-text("打开")').click()
  await win.waitForTimeout(800)
  console.log('产物卡片 打开/入库/预览 ✓')

  // ---- H-01 拖文件到「对话工作台」：以前整个应用会被那个文件替换（导航到 file://）----
  // 放最后跑：这一步会真的往投递箱丢文件、触发一轮 pipeline，不让它影响前面的投递箱断言
  {
    await win.click('button[title="新对话"]')
    await win.waitForTimeout(600)
    const hrefBefore = await win.evaluate(() => location.href)
    const dropSrc = join(root, 'e2e', 'sample.docx')
    const dropName = `e2e拖入工作台_${Date.now()}.docx`
    const stagedDrop = join('/tmp', dropName)
    copyFileSync(dropSrc, stagedDrop)
    // 上一步「入库」的 toast 文案也含「已送入投递箱」，等它自然消失再拖，别断言到旧 toast
    await win
      .locator('text=已送入投递箱')
      .waitFor({ state: 'detached', timeout: 8000 })
      .catch(() => {})

    // dragenter：工作台必须给覆盖层提示（以前拖进来什么反馈都没有，松手直接炸）
    // **触发的是 dragenter 不是 dragover**——覆盖层的显示挂在进出计数上，见 useDragOver
    await win.evaluate(() => {
      const dt = new DataTransfer()
      const el = document.querySelector('[data-testid="workbench-root"]') ?? document.querySelector('main .relative.flex.h-full')
      el?.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
      el?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await win.waitForTimeout(400)
    if (!(await win.locator('text=松手即入库').count())) throw new Error('工作台拖入没有覆盖层提示')
    // 工作台这条也验一次「拖出去覆盖层要消失」——两个拖入口用的是同一个 hook，
    // 但断言各自守各自的，别指望改一处两处都不会坏
    await win.evaluate(() => {
      const el = document.querySelector('[data-testid="workbench-root"]') ?? document.querySelector('main .relative.flex.h-full')
      el?.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))
    })
    await win.waitForTimeout(300)
    if (await win.locator('text=松手即入库').count())
      throw new Error('工作台：文件拖出窗口后覆盖层没有消失')
    // 验完再拖回来，后面还要真的松手投文件
    await win.evaluate(() => {
      const dt = new DataTransfer()
      const el = document.querySelector('[data-testid="workbench-root"]') ?? document.querySelector('main .relative.flex.h-full')
      el?.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await win.waitForTimeout(200)
    await snap('24-工作台-拖入覆盖层', 200)

    // drop：合成一个带真实磁盘路径的 File（渲染层读的就是 File.path，和真拖同一条链路）
    await win.evaluate((p) => {
      const f = new File(['x'], p.split('/').pop(), { type: 'application/octet-stream' })
      Object.defineProperty(f, 'path', { value: p })
      const dt = new DataTransfer()
      dt.items.add(f)
      document
        .querySelector('main .relative.flex.h-full')
        ?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, stagedDrop)
    await win.locator('text=已送入投递箱').waitFor({ timeout: 15000 })
    await snap('24b-工作台-拖入已送入投递箱', 200)

    // ① 应用没被替换掉：没发生导航，侧栏与工作台都还在
    const hrefAfter = await win.evaluate(() => location.href)
    if (hrefAfter !== hrefBefore) throw new Error(`拖入后发生了导航：${hrefBefore} → ${hrefAfter}`)
    if (!(await win.locator('aside button[title="新对话"]').count()))
      throw new Error('拖入后侧栏没了（应用被那个文件替换了）')
    if (!(await win.locator('textarea').count())) throw new Error('拖入后工作台输入框没了')

    // ② 文件真进了投递箱队列（enqueue 拷进投递箱目录，watcher 随后接管）
    let queued = false
    for (const c of ['95_待入库', '00_投递箱']) {
      if (existsSync(join(settings.vaultPath, c, dropName))) queued = true
    }
    if (!queued) throw new Error(`拖入的文件没进投递箱：${dropName}`)
    rmSync(stagedDrop, { force: true })
    console.log('H-01 工作台拖入 ✓（应用未被替换 + 文件进队列）', dropName)
  }

  // ---- toast 一家人检查：把整轮采到的几何样本统一比一遍（采集点见 grabToastGeo）----
  assertToastConsistency()

  // ---- before-quit：退出应用必须把 pipeline 进程组一起带走（当前就存在的孤儿进程 bug）----
  // 上一步刚往投递箱丢了文件，等它真的 spawn 起来，然后关掉应用再查 ps
  {
    let pgid = null
    for (let attempt = 1; attempt <= 3 && !pgid; attempt++) {
      const p = await waitForPipelinePid(win, 180000)
      if (!p) throw new Error('退出前拿不到 pipeline 的进程组（before-quit 断言无从谈起）')
      // 关之前必须确认它**真的活着**，否则这条断言会空过
      if (pipelineLeftovers(p).length) pgid = p
      else {
        console.log(`第 ${attempt} 次：pgid=${p} 已经退了，再丢一个文件让它重新跑起来`)
        await win.evaluate((s) => window.api.inbox.enqueue([s]), join(root, 'e2e', 'sample.docx'))
      }
    }
    if (!pgid) throw new Error('三次都没能在应用退出前抓到一个活着的 pipeline 进程组')
    console.log('退出前 pipeline pgid =', pgid, '（ps 里确认存活）')
    await app.close()
    closed = true
    let left = pipelineLeftovers(pgid)
    for (let i = 0; i < 20 && left.length; i++) {
      await new Promise((r) => setTimeout(r, 500))
      left = pipelineLeftovers(pgid)
    }
    if (left.length) throw new Error('退出应用后仍有 pipeline 孤儿进程：\n' + left.join('\n'))
    console.log(`before-quit 清理 ✓ pgid=${pgid} 无孤儿（打包形态=${packagedBin ? '是' : '否'}）`)
  }
} catch (err) {
  // 先把失败原因打出来：下面的 close 一旦挂住，抛出去的错要等 finally 走完才显示，
  // 实测被吞过一次（看着像"卡死在某一步"，其实早就断言失败了）
  console.error('❌ 走查失败：', err?.stack ?? err)
  throw err
} finally {
  // app.close() 偶尔挂住（SDK 子进程还在重试连接时），别让它把失败原因一起埋掉
  if (!closed) await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20000))])
}

// ---- 收尾体检：shots/ 里凡是本次没刷新的 png 一律报警（旧版本残留会污染验收基线） ----
// 别的走查脚本产的截图单独列，剩下的就是没人认领的旧版本残留
const OWNED_BY_OTHER_SCRIPT = {
  '00b-登录门.png': 'login-provision.mjs',
  '11-登录即用-key就绪.png': 'login-provision.mjs',
  '12-登录即用-对话成功.png': 'login-provision.mjs',
  // 投递链路验收单独一个脚本（desktop/CLAUDE.md 的验收铁律），别每轮都报它是残留
  'a1-拖入无可入库文件-明确提示.png': 'a1-enqueue.mjs',
  'assets-嵌图渲染.png': 'assets-render.mjs',
  'attach-附件缩略图.png': 'attachments.mjs',
  // 2026-08-19 发布前自测新增的三个专项脚本（见 docs/RELEASE-CHECK.md）
  '54-升级路径-老userData接管.png': 'upgrade-path.mjs',
  '55-离线恢复-恢复前.png': 'offline-recovery.mjs',
  '55b-离线恢复-等待后.png': 'offline-recovery.mjs',
  '60-新装-登录门.png': 'fresh-install.mjs',
  '60b-新装-登录后.png': 'fresh-install.mjs',
  '61-新装-建库向导两分支.png': 'fresh-install.mjs',
  '61b-新装-模板库已建.png': 'fresh-install.mjs',
  '62-新装-入库完成.png': 'fresh-install.mjs',
  '63-新装-问答.png': 'fresh-install.mjs',
  '64-新装-产物面板.png': 'fresh-install.mjs',
  '64b-新装-产物已入库.png': 'fresh-install.mjs',
}
/**
 * 只有 `E2E_CHAT=1`（真实 AI 调用）那一轮才刷得到的截图。
 * 本地模式跑完它们必然"没刷新"，但那是**归属问题不是残留**——
 * 不单独列出来的话，每次本地走查的收尾都会报一串假警，久而久之就没人看这段了。
 */
const ONLY_IN_CHAT_RUN = {
  '01d-工作台-流式中.png': '真实流式中途',
  '01d3-流式输出-行尾光标.png': '真实流式的行尾光标',
  '01e-工作台-回答完成.png': '真实回答完成态',
  '28-切回生成中的对话.png': 'H-10 生成中切走切回',
  '35-生成中重复发送-拒绝并给出口.png': 'H-10 重复发送被拒',
  '36-停止生成-半截回答留在对话里.png': 'H-09 停止留半截',
  '39-Dock-待同步与重试入口.png': 'M-03 syncQueue（需登录态造真实同步失败）',
  '41c-流式出错-提问仍在且可重试.png': 'M-11 异步出错分支（401 桩）',
  '41d-流式出错-重试后不重复提问.png': 'M-11 异步出错重试',
  '41e-出错重试-端点恢复后成功.png': 'M-11 端点恢复后重试成功',
  '46-会话恢复降级-照常回答.png': '过期 session 自动降级重开（要真答一轮才验得了上下文接没接上）',
  // 过程可见性：步骤流只有真调 AI 才会产生，本地模式一条都没有
  '48-步骤流-进行中.png': '步骤逐条出现、当前步骤转圈',
  '49-步骤流-折叠摘要.png': '回答开始输出后折叠成一行摘要',
  '50-步骤流-展开明细.png': '点摘要展开看明细',
  '51-步骤流-确认库中没有.png': '检索 0 命中后的验证性扫描',
  '52-产物步骤-无历史时长.png': '产物步骤（本机还没有历史耗时）',
  '52b-产物步骤-有历史时长.png': '产物步骤（秒数取自本机耗时中位数）',
  '53-步骤流-失败步骤.png': '工具失败的那一步标出来（靠模型肯照做，抓不到会打印跳过原因）',
  // 45e（老用户升级机的增强档回落）两轮都刷得到，不列进来
  // 47b/47c 两轮都刷得到，不列进来
}
/**
 * 反过来：只有**本地模式**才刷得到的。原来 `47-用量页-空态` 被塞在上面那张表里，
 * 可它的说明写的是"空态只在本地模式刷"——归属和判据正好相反，于是每跑一次 E2E_CHAT
 * 收尾都要报一条假警（"开了 E2E_CHAT 却没刷到"）。假警和真残留混在一起就没人看这段了。
 */
const ONLY_IN_LOCAL_RUN = {
  '47-用量页-空态.png': '空态只有本地模式刷得到（E2E_CHAT 那轮本月已经有真实记录了）',
}
const notWritten = readdirSync(shots).filter((f) => f.endsWith('.png') && !written.has(f))
const fromOthers = notWritten.filter((f) => OWNED_BY_OTHER_SCRIPT[f])
const chatOnly = notWritten.filter((f) => !OWNED_BY_OTHER_SCRIPT[f] && ONLY_IN_CHAT_RUN[f])
const localOnly = notWritten.filter((f) => !OWNED_BY_OTHER_SCRIPT[f] && ONLY_IN_LOCAL_RUN[f])
const orphans = notWritten.filter(
  (f) => !OWNED_BY_OTHER_SCRIPT[f] && !ONLY_IN_CHAT_RUN[f] && !ONLY_IN_LOCAL_RUN[f]
)
console.log(`\n本次刷新 ${written.size} 张`)
if (fromOthers.length) {
  console.log('ℹ️  以下截图由别的脚本产出，请确认它们也是本轮跑的：')
  for (const f of fromOthers) console.log(`   - ${f}  ←  ${OWNED_BY_OTHER_SCRIPT[f]}`)
}
if (chatOnly.length) {
  console.log(
    CHAT
      ? '⚠️  以下截图属于 E2E_CHAT 专属，但本轮开了 E2E_CHAT 却没刷到，请查上面的跳过原因：'
      : 'ℹ️  以下截图属于 E2E_CHAT 专属（本轮是本地模式，未刷新属正常，不算残留）。\n' +
        '    注：2026-08-19 的 E2E_CHAT 全量轮已把这批**全部刷成新配色**，\n' +
        '    「仍是品牌二期旧配色」那条已知状态已销账：'
  )
  for (const f of chatOnly) console.log(`   - ${f}  ←  ${ONLY_IN_CHAT_RUN[f]}`)
}
if (localOnly.length) {
  console.log(
    CHAT
      ? 'ℹ️  以下截图属于本地模式专属（本轮是 E2E_CHAT，未刷新属正常，不算残留）：'
      : '⚠️  以下截图属于本地模式专属，但本轮就是本地模式却没刷到，请查上面的跳过原因：'
  )
  for (const f of localOnly) console.log(`   - ${f}  ←  ${ONLY_IN_LOCAL_RUN[f]}`)
}
if (orphans.length) {
  console.log('⚠️  以下截图本次没刷新、也不属于任何脚本，八成是旧版本残留，删掉或补跑：')
  for (const f of orphans) console.log('   -', f)
} else {
  console.log('截图基线干净 ✓ 没有无人认领的残留')
}
console.log('walkthrough done →', shots)
