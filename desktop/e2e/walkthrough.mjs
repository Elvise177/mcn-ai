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
    await win.click('button:has-text("登录")')
    await win.locator('button[title="新对话"]').waitFor({ timeout: 30000 })
    await win.waitForTimeout(5000) // 等服务端下发 key 落库
    const s = await win.evaluate(() => window.api.settings.get())
    if (!s.hasApiKey) throw new Error('登录后没拿到 AI key，E2E_CHAT 跑不了（检查中转站/账号）')
    console.log('登录 ✓ key 已下发')
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
  await win.click('text=＋新建')
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

  // 设置页
  await win.click('text=设置')
  await snap('10-设置页', 600)

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

  // 「入库」真点：应弹 toast 并把产物送进投递箱队列
  await ingestBtn.click()
  await win.locator('text=已送入投递箱').waitFor({ timeout: 5000 })
  await snap('14-产物卡片-入库toast', 200)

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
