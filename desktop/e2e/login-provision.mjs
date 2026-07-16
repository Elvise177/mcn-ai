/**
 * 「登录即用」端到端验收：全新用户（零 key 零配置）→ GUI 登录 → key 自动下发 →
 * 不碰任何高级设置直接对话可用。
 * 前置：webpage dev server 在 localhost:3000（含 CLIENT_*_API_KEY env）
 * 运行：node e2e/login-provision.mjs
 */
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shots = join(root, 'e2e', 'shots')
mkdirSync(shots, { recursive: true })

// 全新用户环境：干净 userData（无任何 key/会话）
const USERDATA = '/tmp/mcnai-e2e-fresh'
rmSync(USERDATA, { recursive: true, force: true })

// MCNAI_APP_BIN 指向打包后的二进制时 = 打包形态回归；否则 dev 形态
const packagedBin = process.env.MCNAI_APP_BIN
const app = await electron.launch({
  executablePath: packagedBin || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  args: packagedBin ? [] : [root],
  env: { ...process.env, MCNAI_USER_DATA: USERDATA, MCNAI_VAULT: '/tmp/mcnai-e2e-vault' },
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 920 })

const fail = async (msg) => {
  console.log('❌', msg)
  await win.screenshot({ path: join(shots, 'FAIL-现场.png') }).catch(() => {})
  await app.close()
  process.exit(1)
}

try {
  // 0. 初始状态：无 key
  await win.waitForTimeout(2000)
  let s = await win.evaluate(() => window.api.settings.get())
  console.log(s.hasApiKey || s.hasLlmKey ? '❌ 初始竟有 key（隔离失败）' : '✅ 全新环境：无任何 key')
  if (s.hasApiKey) await fail('隔离失败')

  // 1. 启动登录门上真实登录（Claude Desktop 式首屏）
  await win.waitForSelector('input[placeholder="邮箱"]', { timeout: 10000 }).catch(() => fail('登录门未出现'))
  await win.screenshot({ path: join(shots, '00b-登录门.png') })
  await win.fill('input[placeholder="邮箱"]', 'mcnai-test-a@example.com')
  await win.fill('input[placeholder="密码"]', 'McnAi-Test-2026!')
  await win.click('button:has-text("登录")')
  await win.waitForSelector('text=对话工作台', { timeout: 20000 }).catch(() => fail('登录后未进入主界面'))
  console.log('✅ 登录门登录成功，进入主界面')

  // 2. 等下发落库
  await win.waitForTimeout(4000)
  s = await win.evaluate(() => window.api.settings.get())
  console.log(s.hasApiKey ? '✅ 中转站 key 已自动下发（Keychain）' : '❌ 中转站 key 未下发')
  console.log(s.hasLlmKey ? '✅ DeepSeek key 已自动下发' : '❌ DeepSeek key 未下发')
  if (!s.hasApiKey) await fail('key 未下发')
  await win.screenshot({ path: join(shots, '11-登录即用-key就绪.png') })

  // 3. 零配置直接对话（用下发的 key 走真实模型）
  await win.click('text=对话工作台')
  // 提问不含期待答案词，且只认 AI 气泡（.md-article）——防止匹配用户自己的气泡造成假阳性
  await win.fill('textarea', '一加一等于几？只用一个中文数字回答，不要其他内容')
  await win.press('textarea', 'Enter')
  const t0 = Date.now()
  await win.waitForSelector('.md-article:has-text("二")', { timeout: 120000 }).catch(() => fail('对话无响应'))
  if (Date.now() - t0 < 1500) await fail('响应快得可疑，疑似假阳性')
  console.log(`✅ 零配置对话成功（${Math.round((Date.now() - t0) / 1000)}s，用的是下发的 key）`)
  await win.screenshot({ path: join(shots, '12-登录即用-对话成功.png') })
} finally {
  await app.close()
}
console.log('\n=== 登录即用 端到端验收通过 ===')
