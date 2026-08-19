/**
 * 升级路径验收（发布前专项，2026-08-18 新增）
 *
 * 验的是「大头那台机器」的形态：**老 userData + 已有配置 + 已登录态**，
 * 直接被新构建接管（覆盖安装等价于换掉 app、userData 原地不动）。
 *
 * 做法：把**本机真实 userData 整份拷进隔离目录**再让新构建打开它。
 * 拷贝而不是原件——测试实例会写 config/tasks，不能碰真实数据。
 * 拷完把 `vaultPath` 改指向走查库：真实 vaultPath 指着 maggie-vault，
 * 那是客户数据，测试实例的 watcher 不该盯上去。
 *
 * 断言七件事：
 *   ① 配置字段无损（不被出厂默认覆盖）
 *   ② 落盘的库路径被沿用（不掉进建库向导）
 *   ③ 会话历史条数不变
 *   ④ 两把 key 都还在（safeStorage 跨版本读得回来）
 *   ⑤ 登录态恢复（不要求重新登录）
 *   ⑥ `tierMigrated: true` 的机器**不再二次迁移**（档位映射原样保留）
 *   ⑦ 计价存档 `rev` 不倒退
 *
 * 跑法：node e2e/upgrade-path.mjs
 *   打包形态：MCNAI_APP_BIN=release/mac-arm64/mcn-ai.app/Contents/MacOS/mcn-ai node e2e/upgrade-path.mjs
 */
import { _electron as electron } from 'playwright-core'
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shots = join(root, 'e2e', 'shots')
mkdirSync(shots, { recursive: true })

const REAL = join(homedir(), 'Library', 'Application Support', 'mcn-ai-desktop')
const COPY = '/tmp/mcnai-upgrade-userdata'
/**
 * 专用的小库，**不复用走查库**：这份 userData 是登录态的，一旦它盯上的库里
 * 恰好有待处理的投递文件，就会真起一轮 pipeline（烧打标额度 + 往云端推），
 * 而走查库的投递箱里常有残留。用一个自己造的空库把这条路彻底断掉。
 */
const VAULT = '/tmp/mcnai-upgrade-vault'

if (!existsSync(REAL)) {
  console.log('⏭️  本机没有真实 userData，跳过升级路径验收（这条只在装过老版本的机器上有意义）')
  process.exit(0)
}

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(ok ? `  ✓ ${name}` : `  ❌ ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

// —— 造一个干净的小库（空投递箱，保证不会踢起 pipeline）——
rmSync(VAULT, { recursive: true, force: true })
mkdirSync(join(VAULT, '.mcnai'), { recursive: true })
mkdirSync(join(VAULT, '00_投递箱'), { recursive: true })
writeFileSync(join(VAULT, '.mcnai', 'layout.json'), JSON.stringify({ library: '80_资料库', inbox: '00_投递箱' }, null, 2))
writeFileSync(join(VAULT, '欢迎.md'), '# 欢迎使用 SamePage\n\n升级路径验收用的最小库。\n')

// —— 拷一份真实 userData（不动原件），并把库路径改指这个小库 ——
rmSync(COPY, { recursive: true, force: true })
cpSync(REAL, COPY, { recursive: true })
const cfgPath = join(COPY, 'config.json')
const before = JSON.parse(readFileSync(cfgPath, 'utf-8'))
const realVaultPath = before.vaultPath
writeFileSync(cfgPath, JSON.stringify({ ...before, vaultPath: VAULT }, null, 2))
const expect = { ...before, vaultPath: VAULT }
const convBefore = existsSync(join(COPY, 'conversations.json'))
  ? JSON.parse(readFileSync(join(COPY, 'conversations.json'), 'utf-8'))
  : { conversations: [] }
const convCount = (convBefore.conversations ?? []).length

console.log(`老机器形态：config ${Object.keys(before).length} 个字段　会话 ${convCount} 条　真实库路径 ${realVaultPath}`)
console.log(`  tierMigrated=${before.tierMigrated}　标准档 baseUrl=${before.tierOverrides?.standard?.baseUrl}　pricing.rev=${before.pricing?.rev}`)

const packagedBin = process.env.MCNAI_APP_BIN
const app = await electron.launch({
  executablePath: packagedBin || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  args: packagedBin ? [] : [root],
  // 注意：**不给 MCNAI_VAULT**——就是要验"落盘的 vaultPath 被沿用"这条路
  env: { ...process.env, MCNAI_USER_DATA: COPY },
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 920 })

try {
  await win.waitForTimeout(6000)

  console.log('\n【1】配置无损')
  const after = JSON.parse(readFileSync(cfgPath, 'utf-8'))
  const KEYS = ['apiBaseUrl', 'llmBaseUrl', 'llmModel', 'vaultPath', 'sensitiveAllowAi', 'sensitiveAllowCloud',
    'artifactAutoIngest', 'bizSyncEnabled', 'showCost', 'tierMigrated']
  for (const k of KEYS) check(`${k} 无损`, JSON.stringify(after[k]) === JSON.stringify(expect[k]), `期望 ${JSON.stringify(expect[k])} 实得 ${JSON.stringify(after[k])}`)

  console.log('\n【2】库路径沿用（不掉进建库向导）')
  const s = await win.evaluate(() => window.api.settings.get())
  check('落盘的 vaultPath 被沿用', s.vaultPath === VAULT, `实得 ${s.vaultPath}`)
  const wizard = await win.locator('text=新建知识库').count()
  check('没有弹建库向导', wizard === 0)

  console.log('\n【3】会话历史还在')
  const convs = await win.evaluate(() => window.api.chat.list())
  check(`会话条数不变（${convCount}）`, convs.length === convCount, `实得 ${convs.length}`)

  console.log('\n【4】key 不丢（safeStorage 跨版本读得回来）')
  check('中转站 key 还在', !!s.hasApiKey)
  check('打标 key 还在', !!s.hasLlmKey)

  console.log('\n【5】登录态恢复（不要求重新登录）')
  const auth = await win.evaluate(() => window.api.auth.state())
  check('会话解密成功、仍是登录态', !!(auth?.email || auth?.user?.email), JSON.stringify(auth))
  const loginGate = await win.locator('input[placeholder="邮箱"]').count()
  check('没有被踢回登录门', loginGate === 0)

  console.log('\n【6】tierMigrated=true 的机器不再二次迁移')
  const tiers = await win.evaluate(() => window.api.ai.tiers()) // → { tiers: [...] }
  const std = tiers.tiers.find((t) => t.id === 'standard')
  check('标准档映射原样保留（没被出厂映射覆盖）',
    std?.baseUrl === expect.tierOverrides?.standard?.baseUrl,
    `期望 ${expect.tierOverrides?.standard?.baseUrl} 实得 ${std?.baseUrl}`)
  check('config 里的 tierOverrides 没被改写',
    JSON.stringify(after.tierOverrides) === JSON.stringify(expect.tierOverrides))

  console.log('\n【7】计价存档不倒退')
  check(`pricing.rev 不小于升级前（${expect.pricing?.rev}）`,
    (after.pricing?.rev ?? 0) >= (expect.pricing?.rev ?? 0), `实得 ${after.pricing?.rev}`)

  await win.screenshot({ path: join(shots, '54-升级路径-老userData接管.png') })
  console.log('\nshot: 54-升级路径-老userData接管')
} catch (e) {
  console.log('❌ 升级路径验收异常：', e)
  await win.screenshot({ path: join(shots, 'FAIL-升级路径.png') }).catch(() => {})
  failed++
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20000))])
}

console.log(failed ? `\n❌ 升级路径 ${failed} 条不通过\n` : '\n✅ 升级路径验收通过\n')
process.exit(failed ? 1 : 0)
