/**
 * electron-builder 的 `afterAllArtifactBuild` 钩子：**给 dmg 签名 → 公证 → 订票**。
 *
 * 为什么需要它：electron-builder 只签名并公证 `.app`，然后用那个已订票的 app 去做 dmg，
 * **dmg 自己既没签名也没票**。客户从微信/网盘下载后，**打开 dmg 那一步**仍会被
 * Gatekeeper 拦一次（「Apple 无法验证是否包含恶意软件」），"双击直接开"就不成立了。
 *
 * **三步缺一不可，顺序也不能换**（2026-08-19 实测踩过）：
 *   1. `codesign` 给 dmg 签名 —— 只公证不签名时 `spctl` 判 `rejected / no usable signature`，
 *      因为公证票是按签名的 cdhash 校验的，没签名就对不上
 *   2. `notarytool submit --wait`
 *   3. `stapler staple`
 * **注意 `xcrun stapler validate <dmg>` 会骗人**：只公证不签名时它照样报 "validate worked"，
 * 而 `spctl` 判 rejected。**以 spctl 为准**——它才是 Gatekeeper 真正的判定引擎。
 *
 * **`latest-mac.yml` 的重算不在这里做**（第一版放在这里，错了）：
 * electron-builder 在本钩子返回**之后**还会再写一遍那个文件，把算好的值盖回订票前的旧哈希。
 * 实测证据：yml 的 mtime 比 dmg 晚 1 秒，里面的 size 比磁盘上的 dmg 小 13551 字节
 * （正好是那张公证票的体积）。所以那一步挪到了 `scripts/fix-latest-yml.mjs`，
 * 由 `npm run dist` 在 electron-builder 完全收工之后跑。
 *
 * 三个 APPLE_API_* 环境变量没设齐时**跳过并打警告**，不让构建失败——
 * 本地想快速出个未公证的包时不该被这一步挡住。真正的守门人是
 * `node scripts/verify-signing.mjs`。
 */
const { spawnSync } = require('child_process')
const { basename } = require('path')

module.exports = async function afterAllArtifactBuild(buildResult) {
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'))
  if (dmgs.length === 0) return []

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.log('  ⚠️  [notarize-dmg] APPLE_API_* 三个环境变量没设齐，跳过 dmg 公证——这个 dmg 没有票')
    return []
  }

  // 证书取自 electron-builder 配置里的 mac.identity（那里存的是去掉前缀的名字段）
  const idName = buildResult.configuration?.mac?.identity
  if (!idName) {
    console.log('  ⚠️  [notarize-dmg] 配置里没有 mac.identity，跳过 dmg 签名与公证')
    return []
  }
  const identity = `Developer ID Application: ${idName}`

  for (const dmg of dmgs) {
    console.log(`  • signing dmg     file=${basename(dmg)}  identity=${identity}`)
    const sign = spawnSync('codesign', ['--force', '--sign', identity, '--timestamp', dmg], { stdio: 'inherit' })
    if (sign.status !== 0) throw new Error(`dmg 签名失败：${basename(dmg)}`)

    console.log(`  • notarizing dmg  file=${basename(dmg)}`)
    const sub = spawnSync(
      'xcrun',
      ['notarytool', 'submit', dmg, '--key', APPLE_API_KEY, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER, '--wait'],
      { stdio: 'inherit' }
    )
    if (sub.status !== 0) throw new Error(`dmg 公证失败：${basename(dmg)}`)

    const staple = spawnSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
    if (staple.status !== 0) throw new Error(`dmg 订票失败：${basename(dmg)}`)
    console.log(`  • dmg 已公证并订票  file=${basename(dmg)}`)
  }

  return []
}
