/**
 * GUI 验收走查：Playwright 驱动真实 Electron 应用，逐步截图。
 * 运行: node e2e/walkthrough.mjs   截图落在 e2e/shots/（AI 与人都用截图做验收）
 * 每个里程碑交付前必须跑一遍并人工/AI 检视截图——「构建通过」不等于「功能可用」。
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, copyFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shots = join(root, 'e2e', 'shots')
mkdirSync(shots, { recursive: true })

const app = await electron.launch({
  executablePath: join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  args: [root],
  env: {
    ...process.env,
    MCNAI_USER_DATA: '/tmp/mcnai-e2e-userdata',
    MCNAI_VAULT: process.env.E2E_VAULT || '/tmp/mcnai-e2e-vault',
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
  await snap('01-工作台首页', 1500)

  // 对话工作台：空态 + 输入 + 快捷指令
  await win.click('text=对话工作台')
  await snap('01b-工作台-空态', 800)
  const chatInput = win.locator('textarea').first()
  if (await chatInput.count()) {
    await chatInput.fill('灰太太最近的数据怎么样？')
    await snap('01c-工作台-输入态', 400)
    if (process.env.E2E_CHAT === '1') {
      await chatInput.press('Enter')
      await snap('01d-工作台-流式中', 6000)
      await win.locator('text=停止').waitFor({ state: 'hidden', timeout: 180000 }).catch(() => {})
      await snap('01e-工作台-回答完成', 800)
    } else {
      await chatInput.fill('')
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
        const sample = join(root, 'e2e', 'sample.docx')
        if (existsSync(sample)) {
          copyFileSync(sample, join(dir, `e2e测试文档_${Date.now()}.docx`))
          await snap('07-投递箱-收到文件', 4000)
          await snap('08-投递箱-处理中', 8000)
          await snap('09-投递箱-完成后', 25000)
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
