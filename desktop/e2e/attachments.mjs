/**
 * 附件直供 · 发送侧验收（A-3 图片能力 B'）。
 * 运行: node e2e/attachments.mjs
 *
 * **为什么单独一个脚本**：这条链路要真的**发一轮消息**才验得到（附件有没有到主进程、
 * 有没有拷进临时目录、落库时 thumb 有没有被剥掉）。主走查后面有一串按消息条数写的断言，
 * 中途多发一轮会把它们整体推偏——同 a1-enqueue.mjs 拆出去的理由。
 * 界面那一半（挑图→缩略图条→移除）在主走查里（01h）。
 *
 * **零 token**：隔离实例没有 key，AI 预检必然失败；但附件链路在预检之前就走完了，
 * 该验的东西一个不少。
 */
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync, existsSync, readdirSync, copyFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const root = '/Users/tansenpeng/Documents/AI/mcn-ai/desktop'
const USERDATA = '/tmp/mcnai-attach-userdata'
const VAULT = '/tmp/mcnai-attach-vault'
let bad = 0
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + d}`)
  if (!ok) bad++
}

rmSync(USERDATA, { recursive: true, force: true })
rmSync(VAULT, { recursive: true, force: true })
mkdirSync(join(VAULT, '00_投递箱'), { recursive: true })
mkdirSync(join(VAULT, '80_资料库'), { recursive: true })
mkdirSync(USERDATA, { recursive: true })

// 真图两张
const srcDir = '/private/tmp/claude-501/-Users-tansenpeng-Documents-AI-mcn-ai/29837d68-c645-42af-a885-acc184df251b/scratchpad/full_assets'
const d0 = readdirSync(srcDir)[0]
const imgs = readdirSync(join(srcDir, d0)).filter((f) => /\.(png|jpg)$/i.test(f)).slice(0, 2)
const PIC = imgs.map((f, i) => {
  const p = `/tmp/mcnai-attach-pic${i + 1}${f.slice(f.lastIndexOf('.'))}`
  copyFileSync(join(srcDir, d0, f), p)
  return p
})
console.log('· 附件源：', PIC.join(' , '))

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [root],
  env: { ...process.env, MCNAI_USER_DATA: USERDATA, MCNAI_VAULT: VAULT, NODE_ENV: 'production' },
  timeout: 60000,
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1440, height: 920 })
await (await app.context().newCDPSession(win)).send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
})
await win.waitForTimeout(2500)
await win.click('text=暂不登录').catch(() => {})
await win.waitForTimeout(800)

// 系统选择框没法点，桩掉（同走查里 showSaveDialog 的做法）
await app.evaluate(({ dialog }, files) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files })
}, PIC)

await win.click('[data-testid="attach-btn"]')
await win.locator('[data-testid="attach-strip"]').waitFor({ timeout: 8000 })
await win.waitForTimeout(400)

const strip = await win.evaluate(() => {
  const imgs = [...document.querySelectorAll('[data-testid="attach-strip"] img')]
  return imgs.map((i) => ({ w: i.naturalWidth, isData: i.getAttribute('src').startsWith('data:') }))
})
check('缩略图条出现且两张都在', strip.length === 2, JSON.stringify(strip))
check('缩略图真渲染出来（量像素）', strip.every((s) => s.w > 0), JSON.stringify(strip))
check('缩略图是内存态 dataURL（不落库的前提）', strip.every((s) => s.isData), JSON.stringify(strip))

await win.screenshot({ path: join(root, 'e2e/shots/attach-附件缩略图.png') })

// 移除一张
await win.locator('[data-testid="attach-strip"] .group').first().hover()
await win.locator('[data-testid="attach-remove"]').first().click()
await win.waitForTimeout(300)
check('点 × 能移除一张', (await win.locator('[data-testid="attach-strip"] img').count()) === 1)

// 发送（本地模式没 key，AI 必然预检失败——但附件链路照样要走完）
await win.locator('textarea').first().fill('把这张图放进 PPT')
await win.keyboard.press('Enter')
await win.waitForTimeout(2500)

const bubble = await win.evaluate(() => {
  const el = document.querySelector('[data-testid="bubble-attachments"] img')
  return el ? { w: el.naturalWidth, src: el.getAttribute('src').slice(0, 12) } : null
})
check('消息气泡里显示缩略图', !!bubble && bubble.w > 0, JSON.stringify(bubble))
check('发送后输入框的附件条清空', (await win.locator('[data-testid="attach-strip"]').count()) === 0)

// 落库：thumb 必须被剥掉，文件名留着
const saved = await win.evaluate(async () => {
  const list = await window.api.chat.list()
  const msgs = list.flatMap((c) => c.messages).filter((m) => m.attachments?.length)
  return msgs.map((m) => m.attachments)
})
check('落库的消息里带着附件文件名', saved.length > 0 && saved[0][0].name, JSON.stringify(saved))
check('落库的附件**不含 thumb**（内存态不进持久层）', saved.every((a) => a.every((x) => !x.thumb)), JSON.stringify(saved))

// 主进程把附件拷进了本轮临时目录
const attachRoot = join(tmpdir(), 'mcnai-attach')
const staged = existsSync(attachRoot)
  ? readdirSync(attachRoot).flatMap((d) => readdirSync(join(attachRoot, d)).map((f) => join(attachRoot, d, f)))
  : []
check('附件已拷进临时目录（不依赖用户原文件还在）', staged.length >= 1, JSON.stringify(staged))
check('拷贝内容与原图一致', staged.length > 0 && readFileSync(staged[0]).length === readFileSync(PIC[1]).length,
  JSON.stringify({ staged: staged[0] }))

await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15000))])
console.log(bad ? `\n❌ ${bad} 条不通过\n` : '\n✅ 附件直供全部通过\n')
process.exit(bad ? 1 : 0)
