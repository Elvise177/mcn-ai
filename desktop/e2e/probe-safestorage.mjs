/**
 * M-29 冷调用探针：量「进程内对 safeStorage 的**第一次调用**」到底多贵。
 *
 * 背景（HANDOFF §4-18）：贵的不是 encryptString，是**进程内首次触碰 safeStorage**
 * （读也一样贵），实测 8ms～60s 不等，取决于 securityd 的签名校验缓存冷热。
 * 当时的结论是「根因是 ad-hoc 签名，本来就在买开发者签名那条路上，
 * **签名后要复测一次再决定要不要上助手进程**」——这个脚本就是那次复测。
 *
 * 跑法：
 *   node e2e/probe-safestorage.mjs                                   # dev 形态
 *   MCNAI_APP_BIN=release/mac-arm64/mcn-ai.app/Contents/MacOS/mcn-ai \
 *     node e2e/probe-safestorage.mjs                                 # 打包+签名形态
 *
 * 注意两件事：
 * ① **Keychain 条目是按 app 名共享的**（服务名 = `${app.getName()} Safe Storage`），
 *    与 userData 隔离无关。所以本探针即使用隔离 userData，碰的仍是那一条真实条目——
 *    换签名之后第一次跑，macOS 可能弹授权框，那**正是要测的东西**
 * ② 首次之后 securityd 会缓存，所以"冷"只有第一次算数。脚本会连打三次，
 *    第一次是冷、后两次是热，三个数一起看才有意义
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'path'

const bin = process.env.MCNAI_APP_BIN
const root = '/Users/tansenpeng/Documents/AI/mcn-ai/desktop'
const t0 = Date.now()
const app = await electron.launch({
  executablePath: bin || join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  args: bin ? [] : [root],
  env: { ...process.env, MCNAI_USER_DATA: '/tmp/mcnai-probe-ss', MCNAI_VAULT: '/tmp/mcnai-probe-ss-vault' },
})
const launchMs = Date.now() - t0

const r = await app.evaluate(async ({ app, safeStorage }) => {
  const mark = () => Number(process.hrtime.bigint() / 1000000n)
  const out = { 形态: app.isPackaged ? '打包' : 'dev', name: app.getName(), 服务名: `${app.getName()} Safe Storage` }
  out['isEncryptionAvailable()'] = safeStorage.isEncryptionAvailable()

  const times = []
  for (let i = 0; i < 3; i++) {
    const a = mark()
    const enc = safeStorage.encryptString('probe')
    const b = mark()
    const dec = safeStorage.decryptString(enc)
    const c = mark()
    times.push({ 轮次: i === 0 ? '第1次（冷）' : `第${i + 1}次（热）`, 加密ms: b - a, 解密ms: c - b, 往返对得上: dec === 'probe' })
  }
  out.计时 = times
  return out
})

console.log(`\n启动到可用：${launchMs}ms`)
console.log(JSON.stringify(r, null, 2))
console.log(
  `\n结论口径：第 1 次（冷）的「加密ms」就是 M-29 那个数。` +
    `\n  · 个位数～几百 ms  → 签名解决了，助手进程不用上` +
    `\n  · 仍是几秒～几十秒 → 签名没解决，回去看 §4-18 的助手进程方案\n`
)
await app.close()
