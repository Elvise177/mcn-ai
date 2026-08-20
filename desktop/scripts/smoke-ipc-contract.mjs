#!/usr/bin/env node
/**
 * IPC 契约检查（零依赖、约 1 秒，`npm run smoke:ipc`）。
 *
 * **管的是 tsc 管不到的那一段**：渲染层调 `window.api.x.y` 有 `api.d.ts` 把关，
 * 但 `api.d.ts` 只是**声明**——它保证不了 preload 真的实现了、更保证不了主进程
 * 真的注册了那个 channel。少注册一个的表现是运行时
 * `Error: No handler registered for 'xxx'`，**只有真点到那个功能才炸**。
 *
 * 这一版一口气加了 8 个新通道（写权限确认/撤销、建文件夹、访达定位、
 * 待处理计数、旧标签统计与补齐、附件相关），正是最容易漏一个的时候。
 *
 * 三条断言：
 *   1 preload 里 invoke 的每个 channel，主进程都得 handle
 *   2 主进程 handle 了但没人 invoke 的，列出来（不算错，但值得看一眼是不是忘了接线）
 *   3 preload 里 on(...) 监听的下行事件，主进程得有对应的 send
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const preload = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8')

const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []
  )
const mainSrc = walk(join(ROOT, 'src/main'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

const uniq = (a) => [...new Set(a)]
const grab = (src, re) => uniq([...src.matchAll(re)].map((m) => m[1]))

const invoked = grab(preload, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)
const handled = grab(mainSrc, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)
const listened = grab(preload, /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g)
const sent = grab(mainSrc, /webContents\.send\(\s*['"]([^'"]+)['"]/g)

let bad = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const fail = (m) => {
  bad++
  console.log(`  ✗ ${m}`)
}

console.log('\nIPC 契约检查')
console.log(`  preload invoke ${invoked.length} 个 · 主进程 handle ${handled.length} 个`)
console.log(`  preload 监听 ${listened.length} 个下行事件 · 主进程 send ${sent.length} 个\n`)

const missing = invoked.filter((c) => !handled.includes(c))
missing.length === 0
  ? ok('preload 调用的每个 channel 主进程都注册了')
  : fail(`主进程没有注册这些 channel（一调就报 No handler）：${missing.join(', ')}`)

const noSender = listened.filter((c) => !sent.includes(c))
noSender.length === 0
  ? ok('preload 监听的每个下行事件主进程都会发')
  : fail(`preload 在监听但主进程从不发送：${noSender.join(', ')}`)

const orphan = handled.filter((c) => !invoked.includes(c))
if (orphan.length) console.log(`  ⚠️  主进程注册了但 preload 没调（不一定是错，确认不是忘了接线）：${orphan.join(', ')}`)

console.log(bad === 0 ? '\n✅ IPC 契约一致\n' : `\n❌ ${bad} 条不一致\n`)
process.exit(bad === 0 ? 0 : 1)
