#!/usr/bin/env node
/**
 * 签名 / 公证验收（发版必跑，零 token）。
 *
 * 为什么要有这个脚本：electron-builder 在**三个环境变量一个都没设**时会
 * **静默跳过公证**——构建照样绿、dmg 照样出，客户双击才发现被 Gatekeeper 拦。
 * 所以「打包成功」不能当成「签名公证成功」，得有一道独立的硬断言。
 *
 * 跑法：
 *   node scripts/verify-signing.mjs                       # 默认查 release/ 下的 .app 与 .dmg
 *   node scripts/verify-signing.mjs <app路径> <dmg路径>
 *
 * 六条断言：
 *   1 codesign 深度校验通过
 *   2 签名主体是 Developer ID Application（不是 ad-hoc、不是自签）
 *   3 runtime 标志在（Hardened Runtime 真的开了）
 *   4 entitlements 就是 build/entitlements.mac.plist 那几条（多一条都要看见）
 *   5 spctl 判定 accepted 且 source = Notarized Developer ID
 *   6 stapler validate 对 .app 与 .dmg 都过（票据已订在包上 = 客户机离线也能过）
 *   7 包内**每一个 Mach-O**都签了（PyInstaller 那 89MB 是最容易漏的一片）
 */
import { spawnSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const RELEASE = join(process.cwd(), 'release')

/**
 * **stdout 与 stderr 必须合起来收**：`codesign -dv` / `spctl -vvv` / `stapler validate`
 * 这几个把结果全写在 **stderr** 上，只收 stdout 会拿到空串，
 * 于是断言全部假红（第一版就是这么错的，白查了一轮）。
 */
function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function findApp() {
  const dir = join(RELEASE, 'mac-arm64')
  if (!existsSync(dir)) return null
  const hit = readdirSync(dir).find((f) => f.endsWith('.app'))
  return hit ? join(dir, hit) : null
}
/**
 * **按修改时间取最新，不按文件名排序。**
 * 一度是 `.sort().pop()`，改名（mcn-ai → SamePage）之后立刻踩雷：
 * `release/` 里新旧两个 dmg 并存时，`'S'(83) < 'm'(109)`，`pop()` 拿到的是**旧包**——
 * 于是"验收全绿"验的根本不是要发出去的那个。
 */
function findDmg() {
  if (!existsSync(RELEASE)) return null
  const cands = readdirSync(RELEASE)
    .filter((f) => f.endsWith('.dmg'))
    .map((f) => ({ f, t: statSync(join(RELEASE, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return cands.length ? join(RELEASE, cands[0].f) : null
}

const appPath = process.argv[2] || findApp()
const dmgPath = process.argv[3] || findDmg()

let failed = 0
const ok = (label, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failed++
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log(`\n签名/公证验收`)
console.log(`  app: ${appPath ?? '（没找到）'}`)
console.log(`  dmg: ${dmgPath ?? '（没找到）'}\n`)
if (!appPath || !existsSync(appPath)) {
  console.log('❌ 找不到 .app，先跑 npm run dist')
  process.exit(1)
}

// 1 codesign 深度校验
const v = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
v.ok ? ok('codesign --verify --deep --strict') : bad('codesign 深度校验', v.out.trim().split('\n').slice(0, 3).join(' / '))

// 2/3 签名主体与 runtime 标志
const d = sh('codesign', ['-dv', '--verbose=4', appPath])
const info = d.out
const authority = /Authority=(.+)/.exec(info)?.[1]?.trim() ?? '(无)'
authority.startsWith('Developer ID Application')
  ? ok('签名主体', authority)
  : bad('签名主体不是 Developer ID Application', authority)
const flags = /CodeDirectory v=[^\n]*flags=([^\n(]*)\(?([^)\n]*)\)?/.exec(info)
// 一律走 has()，不让语句以正则字面量开头——那样少个分号就会被当成除法（ASI 陷阱，这脚本被坑过两次）
const has = (re, s) => re.test(s)
has(/runtime/, info) ? ok('Hardened Runtime 已开', (flags?.[2] || flags?.[1] || '').trim()) : bad('Hardened Runtime 未开')

// 4 entitlements
const ent = sh('codesign', ['-d', '--entitlements', ':-', appPath])
const wanted = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
]
const got = [...ent.out.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])
const missing = wanted.filter((w) => !got.includes(w))
const extra = got.filter((g) => !wanted.includes(g))
missing.length === 0 ? ok('entitlements 最小集齐全', `${got.length} 条`) : bad('entitlements 缺项', missing.join(', '))
if (extra.length) console.log(`  ⚠️  entitlements 多出：${extra.join(', ')}（确认每一条都有理由）`)

// 5 spctl（Gatekeeper 的真实判定）
const s = sh('spctl', ['-a', '-vvv', '-t', 'exec', appPath])
const spOut = s.out
has(/accepted/, spOut) ? ok('spctl 判定 accepted') : bad('spctl 未通过', spOut.trim().replace(/\n/g, ' | '))
has(/source=Notarized Developer ID/, spOut)
  ? ok('spctl source = Notarized Developer ID')
  : bad('spctl source 不是 Notarized Developer ID', /source=(.+)/.exec(spOut)?.[1] ?? spOut.trim())

// 6 stapler：票据订在包上 = 客户机断网也能过 Gatekeeper
const stA = sh('xcrun', ['stapler', 'validate', appPath])
has(/The validate action worked/, stA.out) ? ok('stapler validate（.app）') : bad('stapler .app', stA.out.trim().replace(/\n/g, ' | '))
if (dmgPath && existsSync(dmgPath)) {
  const stD = sh('xcrun', ['stapler', 'validate', dmgPath])
  has(/The validate action worked/, stD.out) ? ok('stapler validate（.dmg）') : bad('stapler .dmg', stD.out.trim().replace(/\n/g, ' | '))

  // 6b **dmg 也要过 spctl**。这条不能省，也不能拿上面那条 stapler 顶替：
  // dmg 只公证不签名时，`stapler validate` 照样报 "worked"，而 Gatekeeper 判
  // `rejected / no usable signature`（票按签名的 cdhash 校验，没签名就对不上）。
  // 客户实际撞到的是「打开 dmg」那一步的拦截，而那一步看的正是 spctl。
  const spD = sh('spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmgPath])
  has(/accepted/, spD.out)
    ? ok('spctl 判定 dmg accepted', /source=(.+)/.exec(spD.out)?.[1]?.trim() ?? '')
    : bad('spctl 判定 dmg 未通过（客户打开 dmg 那一步会被拦）', spD.out.trim().replace(/\n/g, ' | '))
} else {
  bad('没找到 dmg，跳过 dmg 的 stapler')
}

// 7 包内每一个 Mach-O 都签了（PyInstaller 的 _internal 是最容易漏的一片）
const machos = sh('bash', [
  '-c',
  `find "${appPath}" -type f -perm +111 -print0 | xargs -0 file 2>/dev/null | grep "Mach-O" | cut -d: -f1`,
]).out
  .split('\n')
  .map((x) => x.trim())
  .filter(Boolean)
const unsigned = []
for (const m of machos) {
  const r = sh('codesign', ['--verify', '--strict', m])
  if (!r.ok) unsigned.push(m.replace(appPath, ''))
}
unsigned.length === 0
  ? ok('包内 Mach-O 全部已签', `${machos.length} 个`)
  : bad(`包内有 ${unsigned.length}/${machos.length} 个 Mach-O 未签`, unsigned.slice(0, 5).join(' , '))

console.log(failed === 0 ? '\n✅ 全部通过\n' : `\n❌ ${failed} 条未通过\n`)
process.exit(failed === 0 ? 0 : 1)
