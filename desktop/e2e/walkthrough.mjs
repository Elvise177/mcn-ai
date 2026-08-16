/**
 * GUI 验收走查：Playwright 驱动真实 Electron 应用，逐步截图。
 * 运行: node e2e/walkthrough.mjs   截图落在 e2e/shots/（AI 与人都用截图做验收）
 * 每个里程碑交付前必须跑一遍并人工/AI 检视截图——「构建通过」不等于「功能可用」。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, copyFileSync, existsSync, rmSync, cpSync, writeFileSync, readdirSync } from 'fs'
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

const app = await launch({
  ...process.env,
  MCNAI_USER_DATA: userData,
  MCNAI_VAULT: vaultCopy,
})
const win = await app.firstWindow()
const cdp = await prepWindow(app, win)
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

// E2E_CHAT=1 要真调 AI：本地模式没有 key，必须先用测试账号登录拿服务端下发的 key
const CHAT = process.env.E2E_CHAT === '1'
const E2E_EMAIL = process.env.E2E_EMAIL || 'mcnai-test-a@example.com'
const E2E_PASSWORD = process.env.E2E_PASSWORD || 'McnAi-Test-2026!'

try {
  await snap('00-登录门', 1500)
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
  if (!(await win.locator('button[title="添加附件（即将支持）"]').count())) throw new Error('输入框缺附件占位按钮')

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
      await chatInput.press('Enter')
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
        const bodyNow = await win.locator('.streaming-body').first().innerText().catch(() => '')
        if (bodyNow.trim()) {
          const convTitle = (await win.locator('aside div.group button').first().innerText()).trim()
          await win.locator('button[title="新对话"]').click() // 切走
          await win.waitForTimeout(800)
          if (await win.locator('button[title="停止生成"]').count())
            throw new Error('切到新对话后仍显示上一个会话的停止按钮')
          await win.locator(`aside button:has-text("${convTitle.slice(0, 8)}")`).first().click() // 切回
          await win.waitForTimeout(1200)
          if (!(await win.locator('button[title="停止生成"]').count()))
            throw new Error('切回生成中的对话后没有"进行中"状态（H-10）')
          const bodyBack = await win.locator('.streaming-body').first().innerText().catch(() => '')
          const head = bodyNow.trim().slice(0, 12)
          if (!bodyBack.includes(head))
            throw new Error(`切回后半截正文没接上（draft 基线失效）：期望含「${head}」，实得「${bodyBack.slice(0, 40)}」`)
          await snap('28-切回生成中的对话', 200)
          console.log('H-10 切走切回 ✓', JSON.stringify({ 切走前: head, 切回后长度: bodyBack.length }))
        } else {
          console.log('⚠️ 流式正文还没吐出来，跳过 H-10 切走切回断言')
        }
      }
      await win.locator('button[title="停止生成"]').waitFor({ state: 'hidden', timeout: 300000 }).catch(() => {})
      await snap('01e-工作台-回答完成', 1200)
      const answered = await win.locator('.md-article').count()
      if (!answered) throw new Error('E2E_CHAT：没有拿到任何回答正文')
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
  await win.waitForTimeout(1200)
  if (await win.locator('button.block.truncate:has-text("e2e待删除笔记")').count())
    throw new Error('删除后文件树里还留着这篇笔记')
  console.log('新建 → ··· → 删除（含二次确认）✓')

  // 搜索：摘要必须是正文纯文本（不带 frontmatter/双链括号/表格竖线）
  await win.fill('input[placeholder="搜索库…"]', '灰太太')
  await snap('05-搜索结果', 2500)
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

  // 投递箱：真实拷一个文件进投递箱目录，观察面板
  const settings = await win.evaluate(() => window.api.settings.get())
  if (settings.vaultPath) {
    const inboxCandidates = ['95_待入库', '00_投递箱']
    for (const c of inboxCandidates) {
      const dir = join(settings.vaultPath, c)
      if (existsSync(dir)) {
        // 分区投递覆盖层：合成 dragover 事件触发，断言业务区+分流区渲染
        await win.evaluate(() => {
          // 从搜索框往上冒泡，比 querySelector 撞根容器稳（根容器的 class 组合可能被其他页面命中）
          const el = document.querySelector('input[placeholder="搜索库…"]') ?? document.querySelector('main .relative.flex.h-full')
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
        await win.evaluate(() => {
          const el = document.querySelector('.z-30') ?? document.querySelector('main .relative.flex.h-full')
          el?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }))
        })

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
                const act = st.tasks.filter((t) => t.status === 'queued' || t.status === 'running')
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

          // 完成态：等「处理中…」消失但面板还在（run-end 后面板还留 4 秒），趁这个窗口截
          for (let i = 0; i < 200; i++) {
            const panelUp = (await win.locator('.inbox-bar-fill').count()) > 0
            const busy = (await win.locator('span:has-text("处理中")').count()) > 0
            const text = panelUp
              ? await win.locator('.inbox-bar-fill').locator('xpath=../..').innerText().catch(() => '')
              : ''
            // 走完最后一段（6/6）或整批跑完都算完成态
            if (panelUp && (/6\/6/.test(text) || !busy)) break
            await win.waitForTimeout(300)
          }
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

  // ---- 关系图配色特写：节点色是否融进暖色主题，需要人工看这张图确认 ----
  {
    const groups = await win.evaluate(() => {
      const cs = getComputedStyle(document.documentElement)
      const names = ['--color-graph-link', ...Array.from({ length: 7 }, (_, i) => `--color-group-${i + 1}`)]
      return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]))
    })
    if (Object.values(groups).some((v) => !v)) throw new Error('图谱配色 token 缺失：' + JSON.stringify(groups))
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
    // 滚轮以指针为中心放大，放大后指针那一点的内容不动，正好用同一点当截图中心
    await win.mouse.move(cbox.x + cluster.cx, cbox.y + cluster.cy)
    for (let i = 0; i < 3; i++) {
      await win.mouse.wheel(0, -200)
      await win.waitForTimeout(250)
    }
    await win.waitForTimeout(1000)
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
    // （编辑态头部也有个「取消」，弹窗按钮一律收敛到 .w-modal 里点，否则撞 strict mode）
    await win.click('.w-modal button:has-text("取消")')
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
    await win.click('.w-modal button:has-text("放弃修改")')
    await win.waitForTimeout(800)
    if (await win.locator('textarea').count()) throw new Error('放弃修改后没退出编辑态')
    const onDisk = await win.evaluate(async () => window.api.vault.readRaw('e2e表格样式.md'))
    if (onDisk.includes('H-04 这段改动没保存')) throw new Error('放弃的改动竟然写进了磁盘')
    await snap('21c-放弃修改后切到另一篇', 300)
    console.log('H-04 未保存确认 ✓', JSON.stringify({ 切到: otherName }))
  }

  // ---- H-02 换库出口：换库要先确认，向导里要有「返回当前库」能退回来 ----
  {
    await win.click('button[title="切换知识库"]')
    await win.locator('text=切换到另一个知识库？').waitFor({ timeout: 5000 })
    const switchMsg = await win.locator('.whitespace-pre-line').first().innerText()
    if (!switchMsg.includes(settings.vaultPath)) throw new Error(`换库确认没显示当前库路径：「${switchMsg}」`)
    await snap('22-换库二次确认', 200)
    // 取消：应该还在原来的库里（文件树还在）
    await win.click('.w-modal button:has-text("取消")')
    await win.waitForTimeout(400)
    if (!(await win.locator('[data-testid="tree-col"]').count())) throw new Error('取消换库后离开了当前库')
    // 确认进向导：必须有退出口
    await win.click('button[title="切换知识库"]')
    await win.click('.w-modal button:has-text("去换库")')
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

  // ---- H-06 AI 服务卡片：手填 key 输入框 + 重新获取按钮（以前下发失败 = 死路）----
  {
    const keyInput = win.locator('[data-testid="apikey-input"]')
    if (!(await keyInput.count())) throw new Error('设置页没有手填 API Key 的输入框')
    if (!(await win.locator('button:has-text("重新获取服务端配置")').count()))
      throw new Error('设置页没有「重新获取服务端配置」按钮')
    const E2E_KEY = 'sk-e2e-manual-key-0123456789'
    await keyInput.fill(E2E_KEY)
    // ---- M-29：保存 key 不再挡路 ----
    // 旧版这颗按钮的 invoke 里同步调 safeStorage，进程内首次调用会把主进程冻住
    // （实测 6s→35s→68s，主进程一卡 CDP 也跟着停），当时只能把这次点击的超时放宽到 10 分钟。
    // 现在写入转成后台任务，点击必须秒回——这里就用它当断言：超过 20s 视为回归。
    const tClick = Date.now()
    await win.click('[data-testid="apikey-save"]', { timeout: 20000 })
    const clickMs = Date.now() - tClick
    // toast 的等待要给足：点击返回后主进程才开始那次同步加密，冷调用最长实测 60s，
    // 期间 CDP 也停（Playwright 走主进程），所以这里不能拿来当"快不快"的证据——
    // 证据是上面那次 click 的耗时（旧版这里要 10 分钟超时才点得动）
    await win.locator('text=/Key 已生效|未重复写入/').first().waitFor({ timeout: 180000 })
    // 等待态：写入进行中要有明确文案。冷调用有时只要几毫秒（系统缓存热），
    // 那种情况下文案一闪而过，所以「看到文案」与「任务层留下了这条 secret 任务」二选一即可
    // 系统缓存热的时候整个落盘只要几十毫秒，「正在保存」会一闪而过，所以界面在成功后
    // 还会留 3 秒的「已安全保存 ✓」——两态都算数，截图截到哪一态都行
    let hintState = ''
    for (let i = 0; i < 40 && !hintState; i++) {
      if (await win.locator('[data-testid="key-writing"]').count()) hintState = 'writing'
      else if (await win.locator('[data-testid="key-saved"]').count()) hintState = 'saved'
      else await win.waitForTimeout(200)
    }
    const sawHint = !!hintState
    if (sawHint) await rawShot(cdp, '10d-设置页-密钥保存状态')
    else await snap('10d-设置页-密钥保存状态', 100)
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
    if (!afterKey.hasApiKey) throw new Error('手填 key 保存后 hasApiKey 仍为 false')
    await snap('10b-设置页-手填key已保存', 300)

    // ---- M-29 写前判重：同一把 key 再存一次，必须零写入 ----
    // 这条就是"老用户重复登录不再冻结"的核心——provisionKeys 每次启动都会走同一条路
    const repeat = await win.evaluate((k) => window.api.settings.setKey(k), E2E_KEY)
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
    await snap('10c-设置页-重新获取反馈', 200)
    console.log('H-06 手填 key + 重新获取 ✓', JSON.stringify({ 反馈: provText.trim() }))
  }

  // ---- 模型线路（provider 解耦）：三条线路可切，模型名显式可见可改 ----
  {
    const card = win.locator('[data-testid="provider-card"]')
    if (!(await card.count())) throw new Error('设置页没有「模型线路」卡片')
    for (const id of ['inferera', 'deepseek', 'custom']) {
      if (!(await win.locator(`[data-testid="provider-${id}"]`).count()))
        throw new Error(`模型线路里缺少 ${id}`)
    }
    await snap('10e-设置页-模型线路', 300)
    // 真切一次到 DeepSeek 官方：地址与模型必须跟着变，且主进程认账
    await win.click('[data-testid="provider-deepseek"]')
    await win.locator('text=已切换到').waitFor({ timeout: 8000 })
    await win.waitForTimeout(400)
    const shown = {
      baseUrl: await win.locator('[data-testid="provider-baseurl"]').inputValue(),
      model: await win.locator('[data-testid="provider-model"]').inputValue(),
      fastModel: await win.locator('[data-testid="provider-fastmodel"]').inputValue(),
    }
    if (shown.baseUrl !== 'https://api.deepseek.com/anthropic')
      throw new Error(`切到 DeepSeek 官方后 base URL 不对：${shown.baseUrl}`)
    if (shown.model !== 'deepseek-v4-pro') throw new Error(`主模型没钉死成 deepseek-v4-pro：${shown.model}`)
    if (shown.fastModel !== 'deepseek-v4-flash') throw new Error(`轻量模型不对：${shown.fastModel}`)
    const inMain = await win.evaluate(() => window.api.settings.get())
    if (inMain.aiProvider !== 'deepseek') throw new Error('主进程没记住切换后的 provider')
    await snap('10f-模型线路-切到DeepSeek官方', 300)
    console.log('模型线路切换 ✓', JSON.stringify(shown))
    // 切回默认线路，别把后面的步骤带偏
    await win.click('[data-testid="provider-inferera"]')
    await win.waitForTimeout(600)
    const back = await win.evaluate(() => window.api.settings.get())
    if (back.aiProvider !== 'inferera') throw new Error('切回 inferera 失败')
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
    await row.hover() // ✕ 是 group-hover 才出的
    await row.locator('button[title="删除对话"]').click()
    await win.locator('text=确认删除这个对话？').waitFor({ timeout: 5000 })
    const delMsg = await win.locator('.whitespace-pre-line').first().innerText()
    if (!delMsg.includes('e2e 历史会话一')) throw new Error(`删除对话确认没显示标题：「${delMsg}」`)
    await snap('23-删除对话-二次确认', 200)
    // 取消：对话必须还在
    await win.click('.w-modal button:has-text("取消")')
    await win.waitForTimeout(300)
    if (!(await win.locator('aside button:has-text("e2e 历史会话一")').count()))
      throw new Error('取消删除后对话却没了')
    // 确认删除：toast + 侧栏里消失
    await row.hover()
    await row.locator('button[title="删除对话"]').click()
    await win.locator('text=确认删除这个对话？').waitFor({ timeout: 5000 })
    await win.click('.w-modal button:has-text("删除")')
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
  await cardPpt.hover()
  await win.waitForTimeout(300)
  const openBtn = cardPpt.locator('button:has-text("打开")').first()
  const ingestBtn = cardPpt.locator('button:has-text("入库")').first()
  if (!(await openBtn.isVisible()) || !(await ingestBtn.isVisible()))
    throw new Error('产物卡片 hover 后「打开/入库」没出现')
  if (beforeHover) throw new Error('产物卡片没 hover 时就露出了操作按钮')
  await snapHover('13-产物卡片-hover操作')
  console.log('产物卡片 hover ✓（静态隐藏 → hover 出「打开/入库」）')

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

    // 已入库：等本轮 pipeline 跑完（真 docx 应当转换成功）
    let done = false
    for (let i = 0; i < 160 && !done; i++) {
      done = (await win.locator('[data-testid="ingest-done"]').count()) > 0
      if (!done) await win.waitForTimeout(2000)
    }
    if (!done) {
      const t = await win.evaluate(async () => {
        const s = await window.api.tasks.list()
        return s.tasks.filter((x) => x.kind === 'ingest').map((x) => ({ t: x.title, s: x.status, e: x.error }))
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

    // dragover：工作台必须给覆盖层提示（以前拖进来什么反馈都没有，松手直接炸）
    await win.evaluate(() => {
      const dt = new DataTransfer()
      document
        .querySelector('main .relative.flex.h-full')
        ?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await win.waitForTimeout(400)
    if (!(await win.locator('text=松手即入库').count())) throw new Error('工作台拖入没有覆盖层提示')
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

} finally {
  await app.close()
}

// ---- 收尾体检：shots/ 里凡是本次没刷新的 png 一律报警（旧版本残留会污染验收基线） ----
// 别的走查脚本产的截图单独列，剩下的就是没人认领的旧版本残留
const OWNED_BY_OTHER_SCRIPT = {
  '00b-登录门.png': 'login-provision.mjs',
  '11-登录即用-key就绪.png': 'login-provision.mjs',
  '12-登录即用-对话成功.png': 'login-provision.mjs',
}
const notWritten = readdirSync(shots).filter((f) => f.endsWith('.png') && !written.has(f))
const fromOthers = notWritten.filter((f) => OWNED_BY_OTHER_SCRIPT[f])
const orphans = notWritten.filter((f) => !OWNED_BY_OTHER_SCRIPT[f])
console.log(`\n本次刷新 ${written.size} 张`)
if (fromOthers.length) {
  console.log('ℹ️  以下截图由别的脚本产出，请确认它们也是本轮跑的：')
  for (const f of fromOthers) console.log(`   - ${f}  ←  ${OWNED_BY_OTHER_SCRIPT[f]}`)
}
if (orphans.length) {
  console.log('⚠️  以下截图本次没刷新、也不属于任何脚本，八成是旧版本残留，删掉或补跑：')
  for (const f of orphans) console.log('   -', f)
} else {
  console.log('截图基线干净 ✓ 没有无人认领的残留')
}
console.log('walkthrough done →', shots)
