/**
 * 「登录即用」端到端验收：全新用户（零 key 零配置）→ GUI 登录 → key 自动下发 →
 * 不碰任何高级设置直接对话可用。
 * 前置：**不需要本地 dev server**。登录直连 Supabase，key 下发打的是
 *   `store.apiBaseUrl`（出厂值就是生产 `https://www.makeupai.top`），本脚本不改它。
 *   （这里原来写着「前置：webpage dev server 在 localhost:3000」——**是错的**，
 *   代码里从来没有把 apiBaseUrl 指到本地的动作。2026-08-18 核实后更正。）
 *   真要打本地，得自己先 `settings.setApiBase('http://localhost:3000')`。
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
  // 登录页动过（粉花换成对齐线 logo + SamePage 字标），这一屏必须自带断言，
  // 否则 00b 的基线只会告诉我们"长这样"，不会告诉我们"换对了没有"
  {
    const brand = await win.evaluate(() => {
      const svg = document.querySelector('[data-testid="brand-logo"]')
      const bar = svg?.querySelector('[data-testid="brand-logo-bar"]')
      return {
        has: !!svg,
        size: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
        lines: svg ? svg.querySelectorAll('line').length : 0,
        barColor: bar ? getComputedStyle(bar).stroke : '',
        name: [...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'SamePage'),
        oldBrand: /mcn[-\s]?ai|拉齐/i.test(document.body.innerText || ''),
      }
    })
    if (!brand.has || brand.lines !== 4) await fail('登录页 logo 不对：' + JSON.stringify(brand))
    if (brand.size < 48) await fail(`登录页 logo 只有 ${brand.size}px，不是大尺寸落点`)
    if (!brand.name) await fail('登录页没有 SamePage 字标')
    if (brand.oldBrand) await fail('登录页仍出现旧名（mcn-ai／拉齐）')
    console.log('✅ 登录页品牌 ✓', JSON.stringify(brand))
  }
  await win.fill('input[placeholder="邮箱"]', 'mcnai-test-a@example.com')
  await win.fill('input[placeholder="密码"]', 'McnAi-Test-2026!')
  const tLogin = Date.now()
  await win.click('button:has-text("登录")')
  // 登录后应直接落在对话页（＋新对话可见 + 空态问候）。
  // M-29 修好之后（会话与 key 的落盘都转成后台任务），这里不该再等几分钟——
  // 90s 还进不去就是回归：写入又跑回登录这条同步路径上了
  await win.waitForSelector('button[title="新对话"]', { timeout: 90000 }).catch(() => fail('登录后未进入主界面'))
  console.log(`登录到进主界面 ${Date.now() - tLogin}ms`)
  const chatHome = await win.locator('text=问你的知识库，或直接说要做什么').count()
  if (!chatHome) await fail('登录后没有落在对话页')
  console.log('✅ 登录门登录成功，直接落在对话页')

  // 2. 等下发落库：key 现在是先进内存（立刻可用）、再后台加密落盘，
  // 而落盘那一下的耗时随系统缓存冷热在 8ms~60s 之间跳，所以只能轮询
  for (let i = 0; i < 30; i++) {
    s = await win.evaluate(() => window.api.settings.get())
    if (s.hasApiKey && s.hasLlmKey) break
    await win.waitForTimeout(1000)
  }
  s = await win.evaluate(() => window.api.settings.get())
  console.log(s.hasApiKey ? '✅ 中转站 key 已自动下发（Keychain）' : '❌ 中转站 key 未下发')
  console.log(s.hasLlmKey ? '✅ DeepSeek key 已自动下发' : '❌ DeepSeek key 未下发')
  if (!s.hasApiKey) await fail('key 未下发')
  // 契约 v2（2026-09-03）：两档线路也是下发的，客户端不持写死地址。标准档 = 官方直连、增强档 = 中转站
  {
    const t = (await win.evaluate(() => window.api.ai.tiers())).tiers
    const std = t.find((x) => x.id === 'standard')
    const enh = t.find((x) => x.id === 'enhanced')
    const bad = []
    if (!std?.configured || !std.provisioned || !std.baseUrl.startsWith('https://api.deepseek.com')) bad.push(`标准档 ${JSON.stringify(std)}`)
    if (!enh?.configured || !enh.provisioned || !enh.baseUrl.startsWith('https://api.inferera.com')) bad.push(`增强档 ${JSON.stringify(enh)}`)
    if (/aihubmix/i.test(std?.baseUrl + enh?.baseUrl)) bad.push('线路里仍有 aihubmix')
    if (bad.length) await fail('服务端下发的档位线路不对：' + bad.join('；'))
    console.log(`✅ 两档线路已下发：标准 ${std.baseUrl} / ${std.model}，增强 ${enh.baseUrl} / ${enh.model}`)
  }
  await win.screenshot({ path: join(shots, '11-登录即用-key就绪.png') })

  // 3. 零配置直接对话（用下发的 key 走真实模型；对话页即首页无需切换）
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
