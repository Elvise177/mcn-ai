/**
 * GUI 验收走查：Playwright 驱动真实 Electron 应用，逐步截图。
 * 运行: node e2e/walkthrough.mjs   截图落在 e2e/shots/（AI 与人都用截图做验收）
 * 每个里程碑交付前必须跑一遍并人工/AI 检视截图——「构建通过」不等于「功能可用」。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, copyFileSync, existsSync, rmSync, cpSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shots = join(root, 'e2e', 'shots')
mkdirSync(shots, { recursive: true })

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

// MCNAI_APP_BIN 指向打包后的二进制时 = 打包形态回归；否则 dev 形态
const packagedBin = process.env.MCNAI_APP_BIN

// ---- 首跑引导环节：全新 userData 且不给库 → 登录门 → 建库引导 → 跳过 → 对话页 ----
{
  rmSync('/tmp/mcnai-e2e-firstrun', { recursive: true, force: true })
  const env2 = { ...process.env, MCNAI_USER_DATA: '/tmp/mcnai-e2e-firstrun' }
  delete env2.MCNAI_VAULT
  const app2 = await electron.launch({
    executablePath: packagedBin || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    args: packagedBin ? [] : [root],
    env: env2,
  })
  const w2 = await app2.firstWindow()
  await w2.setViewportSize({ width: 1440, height: 920 })
  await w2.waitForTimeout(1500)
  await w2.click('text=暂不登录')
  await w2.locator('text=建立你的知识库').waitFor({ timeout: 5000 })
  await w2.screenshot({ path: join(shots, '00c-首跑-建库引导.png') })
  console.log('shot: 00c-首跑-建库引导')
  await w2.click('text=暂时跳过')
  await w2.locator('text=问你的库，或直接说要做什么').waitFor({ timeout: 5000 })
  await w2.screenshot({ path: join(shots, '00d-首跑-跳过后落对话页.png') })
  console.log('shot: 00d-首跑-跳过后落对话页')
  await app2.close()
}

const app = await electron.launch({
  executablePath: packagedBin || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  args: packagedBin ? [] : [root],
  env: {
    ...process.env,
    MCNAI_USER_DATA: userData,
    MCNAI_VAULT: vaultCopy,
  },
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 920 })
const snap = async (name, ms = 600) => {
  await win.waitForTimeout(ms)
  await win.screenshot({ path: join(shots, name + '.png') })
  console.log('shot:', name)
}

try {
  await snap('00-登录门', 1500)
  const skip = win.locator('text=暂不登录')
  if (await skip.count()) {
    await skip.click()
    await win.waitForTimeout(800)
  }
  await snap('01-工作台首页', 800)

  // 对话工作台（默认页，无模块入口——新对话/Recents 即入口）：空态 + 输入 + 快捷指令
  await snap('01b-工作台-空态', 400)
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
    if (process.env.E2E_CHAT === '1') {
      await chatInput.press('Enter')
      await snap('01d-工作台-流式中', 6000)
      await win.locator('text=停止').waitFor({ state: 'hidden', timeout: 180000 }).catch(() => {})
      await snap('01e-工作台-回答完成', 800)
    } else {
      // ＋新对话必须复位：空态问候可见 + 输入框清空（回归 2026-07-16 用户报障）
      await win.click('text=＋ 新对话')
      await win.waitForTimeout(500)
      const emptyOk = await win.locator('text=问你的库，或直接说要做什么').count()
      const inputVal = await win.locator('textarea').first().inputValue()
      if (!emptyOk || inputVal !== '') throw new Error(`＋新对话未复位：空态=${emptyOk} 输入残留="${inputVal}"`)
      await snap('01d-新对话复位', 300)
    }
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
  }

  // 应用内弹窗（替代系统 prompt 的验证）
  await win.click('text=＋新建')
  await snap('03b-应用内弹窗', 500)
  await win.keyboard.press('Escape')

  // 搜索
  await win.fill('input[placeholder="搜索库…"]', '灰太太')
  await snap('05-搜索结果', 2500)
  const hit = win.locator('button:has-text("灰太太")').first()
  if (await hit.count()) {
    await hit.click()
    await snap('06-搜索命中打开', 1200)
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
          const el = document.querySelector('.relative.flex.h-full')
          el?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }))
        })
        await win.waitForTimeout(400)
        const zoneBiz = await win.locator('text=业务资料').count()
        const zoneRef = await win.locator('text=主题打标 · 概念建链').count()
        if (!zoneBiz || !zoneRef) throw new Error(`分区投递覆盖层缺失：业务区=${zoneBiz} 分流区=${zoneRef}`)
        await snap('06b-分区投递覆盖层', 200)
        await win.evaluate(() => {
          const el = document.querySelector('.relative.flex.h-full')
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
          await snap('08-投递箱-处理中', 8000)
          await snap('09-投递箱-完成后', 25000)
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

} finally {
  await app.close()
}
console.log('walkthrough done →', shots)
