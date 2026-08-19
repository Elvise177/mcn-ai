/**
 * 离线 → 恢复网络：离线条会不会自己消失（发布前专项，2026-08-18 新增）
 *
 * 主走查的 33 步只验了「断网时照常开窗 + 挂离线条」，**没验它怎么下去**。
 * 而客户的真实形态是「早上没网开了应用，中午网回来了」——那条说着
 * 「AI 检索已降级为本地全文」的黄条如果一直挂着，用户会以为云端一直没回来。
 *
 * 造法：先把 apiBaseUrl 指到黑洞端口（127.0.0.1:9）冷启动 → 离线条出现；
 * 再在运行期把地址改回真地址 = 等价于"网络恢复了"，然后**什么都不做**，
 * 只等，看条子会不会自己下去。
 *
 * 跑法：node e2e/offline-recovery.mjs
 */
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shots = join(root, 'e2e', 'shots')
mkdirSync(shots, { recursive: true })

const USERDATA = '/tmp/mcnai-offline-recovery'
rmSync(USERDATA, { recursive: true, force: true })
mkdirSync(USERDATA, { recursive: true })
// 冷启动就指黑洞：probeCloud 在 did-finish-load 之后跑，必然探失败
writeFileSync(join(USERDATA, 'config.json'), JSON.stringify({ apiBaseUrl: 'http://127.0.0.1:9', tierMigrated: true }))

const WAIT_MS = Number(process.env.RECOVERY_WAIT_MS || 90_000)
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(ok ? `  ✓ ${name}` : `  ❌ ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

const app = await electron.launch({
  executablePath: process.env.MCNAI_APP_BIN || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  args: process.env.MCNAI_APP_BIN ? [] : [root],
  env: { ...process.env, MCNAI_USER_DATA: USERDATA, MCNAI_VAULT: '/tmp/mcnai-e2e-vault' },
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1440, height: 920 })

const barText = () => win.evaluate(() => document.querySelector('[data-testid="offline-bar"]')?.textContent?.trim() ?? '')

try {
  // 先过登录门：离线条挂在主界面布局里，登录门那一屏根本没有它（同主走查第 33 步）
  await win.waitForTimeout(2500)
  const skip = win.locator('text=暂不登录')
  if (await skip.count()) await skip.click()

  // 1. 离线态：条子必须出现
  let text = ''
  for (let i = 0; i < 30 && !text; i++) {
    text = await barText()
    if (!text) await win.waitForTimeout(1000)
  }
  check('断网冷启动出现云端离线条', /云端离线/.test(text), `实得「${text}」`)
  await win.screenshot({ path: join(shots, '55-离线恢复-恢复前.png') })

  // 2. 把地址改回真地址 = 网络恢复。之后**不做任何操作**，纯等。
  await win.evaluate(() => window.api.settings.setApiBase('https://www.makeupai.top'))
  console.log(`  地址已改回真地址，开始纯等 ${WAIT_MS / 1000}s（期间不做任何操作）…`)
  const t0 = Date.now()
  let cleared = false
  while (Date.now() - t0 < WAIT_MS) {
    if (!(await barText())) { cleared = true; break }
    await win.waitForTimeout(3000)
  }
  check(`网络恢复后离线条自动消失（${WAIT_MS / 1000}s 内）`, cleared,
    `等了 ${Math.round((Date.now() - t0) / 1000)}s 仍挂着「${await barText()}」`)
  await win.screenshot({ path: join(shots, '55b-离线恢复-等待后.png') })

  // 3. 对照组：重启一次（`probeCloud` 只在启动与登录后跑）。
  //    这一步是用来**区分两种完全不同的毛病**的：
  //      重启后条子下去 = 恢复链路本身是好的，只是"不会自己好"（修法：加周期重探）
  //      重启后还挂着   = 恢复链路坏了（修法完全不同）
  //    不用「主动打一次云端请求」当对照：这份 userData 没登录，
  //    `auth.provision()` 拿不到 token 会**直接返回、根本不发请求**，证明不了任何事。
  if (!cleared) {
    console.log('  对照组：重启一次再看…')
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20000))])
    const app2 = await electron.launch({
      executablePath: process.env.MCNAI_APP_BIN || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
      args: process.env.MCNAI_APP_BIN ? [] : [root],
      env: { ...process.env, MCNAI_USER_DATA: USERDATA, MCNAI_VAULT: '/tmp/mcnai-e2e-vault' },
    })
    const w2 = await app2.firstWindow()
    await w2.waitForTimeout(3000)
    const skip2 = w2.locator('text=暂不登录')
    if (await skip2.count()) await skip2.click()
    await w2.waitForTimeout(9000)
    const after = await w2.evaluate(() => document.querySelector('[data-testid="offline-bar"]')?.textContent?.trim() ?? '')
    console.log(`  重启后 → ${after ? `仍然挂着「${after}」（= 恢复链路本身有问题）` : '条子下去了（= 只是不会自己好，修法 = 加周期重探）'}`)
    await Promise.race([app2.close(), new Promise((r) => setTimeout(r, 20000))])
    process.exit(failed ? 1 : 0)
  }
} catch (e) {
  console.log('❌ 离线恢复验收异常：', e)
  failed++
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 20000))])
}

console.log(failed ? `\n❌ 离线恢复 ${failed} 条不通过\n` : '\n✅ 离线恢复验收通过\n')
process.exit(failed ? 1 : 0)
