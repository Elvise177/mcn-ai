/**
 * 更名影响面探针（二·3）：坐实 userData 路径与 Keychain 服务名到底跟谁走。
 *
 * 关键点：MCNAI_USER_DATA 只改 userData 的落点，**不改 app.getName()**，
 * 所以可以在完全隔离的实例里读出"默认会落在哪"，不碰真实数据。
 *
 * 打包形态跑法：MCNAI_APP_BIN=/Applications/mcn-ai.app/Contents/MacOS/mcn-ai node probe-name.mjs
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'path'

const bin = process.env.MCNAI_APP_BIN
const root = '/Users/tansenpeng/Documents/AI/mcn-ai/desktop'
const app = await electron.launch({
  executablePath: bin || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  args: bin ? [] : [root],
  env: { ...process.env, MCNAI_USER_DATA: '/tmp/mcnai-probe-name', MCNAI_VAULT: '/tmp/mcnai-probe-name-vault' },
})

const info = await app.evaluate(async ({ app, safeStorage }) => ({
  形态: app.isPackaged ? '打包' : 'dev',
  'app.getName()': app.getName(),
  'app.getVersion()': app.getVersion(),
  appData: app.getPath('appData'),
  '默认 userData（= appData/getName）': `${app.getPath('appData')}/${app.getName()}`,
  '本次实际 userData（被 MCNAI_USER_DATA 改过）': app.getPath('userData'),
  // safeStorage 在 macOS 上用的 Keychain 服务名 = `${app.getName()} Safe Storage`
  'Keychain 服务名（推导）': `${app.getName()} Safe Storage`,
  'safeStorage 可用': safeStorage.isEncryptionAvailable(),
}))
console.log(JSON.stringify(info, null, 2))
await app.close()
