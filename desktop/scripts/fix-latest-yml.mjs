#!/usr/bin/env node
/**
 * 订票之后重算 `latest-mac.yml` 里 dmg 的 sha512 / size。
 *
 * **为什么不放在 `afterAllArtifactBuild` 钩子里**（第一版就是那么写的，错了）：
 * electron-builder 在钩子返回**之后**还会再写一遍 `latest-mac.yml`，
 * 把钩子算好的值盖回**订票前**的旧哈希。实测证据：yml 的 mtime 比 dmg 晚 1 秒，
 * 而里面的 size 比磁盘上的 dmg 小 13551 字节（正好是那张公证票的体积）。
 * 所以这一步必须挂在 `npm run dist` 的**最后**，在 electron-builder 完全收工之后跑。
 *
 * **影响面要说清楚，别夸大**：macOS 的自动更新读的是顶层 `path:`（指向 zip），
 * zip 不参与订票、哈希一直是对的，所以更新链路本来就没坏。dmg 那条是清单里的附带信息——
 * 但清单里躺一个错哈希是迟早坑人的陷阱，该修。
 *
 * 跑法（`npm run dist` 已自动串上）：node scripts/fix-latest-yml.mjs
 */
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs'
import { join } from 'path'

const RELEASE = join(process.cwd(), 'release')
const YML = join(RELEASE, 'latest-mac.yml')

if (!existsSync(YML)) {
  console.log('  • 没有 latest-mac.yml，跳过（未配 publish？）')
  process.exit(0)
}

let text = readFileSync(YML, 'utf8')
let fixed = 0
let checked = 0

for (const name of readdirSync(RELEASE).filter((f) => f.endsWith('.dmg'))) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(- url: ${esc}\\n\\s*sha512: )(\\S+)(\\n\\s*size: )(\\d+)`)
  const m = re.exec(text)
  if (!m) continue
  checked++
  const file = join(RELEASE, name)
  const sha = createHash('sha512').update(readFileSync(file)).digest('base64')
  const size = statSync(file).size
  if (m[2] === sha && Number(m[4]) === size) {
    console.log(`  ✅ ${name} 清单已是最新`)
    continue
  }
  console.log(`  • ${name} 清单过期 → 重算`)
  console.log(`      size   ${m[4]} → ${size}`)
  console.log(`      sha512 ${m[2].slice(0, 16)}… → ${sha.slice(0, 16)}…`)
  text = text.replace(re, `$1${sha}$3${size}`)
  fixed++
}

if (fixed) {
  writeFileSync(YML, text)
  console.log(`  • latest-mac.yml 已按订票后的文件更新（${fixed}/${checked}）`)
} else if (checked === 0) {
  console.log('  • latest-mac.yml 里没有 dmg 条目，无需处理')
}
