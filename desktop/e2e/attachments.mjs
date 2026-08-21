/**
 * 附件直供 · 发送侧验收（A-3 图片能力 B'）。
 * 运行: node e2e/attachments.mjs
 *
 * **为什么单独一个脚本**：这条链路要真的**发一轮消息**才验得到（附件有没有到主进程、
 * 有没有拷进临时目录、落库时 thumb 有没有被剥掉）。主走查后面有一串按消息条数写的断言，
 * 中途多发一轮会把它们整体推偏——同 a1-enqueue.mjs 拆出去的理由。
 * 界面那一半（挑图→缩略图条→移除）在主走查里（01h）。
 *
 * **零 token**：隔离实例没有 key，AI 预检必然失败；但附件链路在预检之前就走完了，
 * 该验的东西一个不少。
 */
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync, existsSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'

const root = '/Users/tansenpeng/Documents/AI/mcn-ai/desktop'
const USERDATA = '/tmp/mcnai-attach-userdata'
const VAULT = '/tmp/mcnai-attach-vault'
let bad = 0
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + d}`)
  if (!ok) bad++
}

rmSync(USERDATA, { recursive: true, force: true })
rmSync(VAULT, { recursive: true, force: true })
mkdirSync(join(VAULT, '00_投递箱'), { recursive: true })
mkdirSync(join(VAULT, '80_资料库'), { recursive: true })
mkdirSync(USERDATA, { recursive: true })

/**
 * 真图两张，**取自仓库内已提交的素材**。
 *
 * 这里原来指向某次会话的 scratchpad
 * （`/private/tmp/claude-501/…/29837d68-…/scratchpad/full_assets`）——
 * 那个目录一被清掉，这条走查就 ENOENT 必炸，而且报的是"文件夹不存在"，
 * 看着像环境坏了、不像测试写错了（2026-08-21 全量验收时真炸了）。
 * **测试素材只许来自仓库**：随代码走、跟着 git 走，任何机器上都在。
 */
const srcDir = join(import.meta.dirname, '..', 'build', 'icon-candidates')
const d0 = '.'
const imgs = readdirSync(srcDir).filter((f) => /\.(png|jpg)$/i.test(f)).sort().slice(0, 2)
const PIC = imgs.map((f, i) => {
  const p = `/tmp/mcnai-attach-pic${i + 1}${f.slice(f.lastIndexOf('.'))}`
  copyFileSync(join(srcDir, d0, f), p)
  return p
})
console.log('· 附件源：', PIC.join(' , '))

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [root],
  env: { ...process.env, MCNAI_USER_DATA: USERDATA, MCNAI_VAULT: VAULT, NODE_ENV: 'production' },
  timeout: 60000,
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1440, height: 920 })
await (await app.context().newCDPSession(win)).send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
})
await win.waitForTimeout(2500)
await win.click('text=暂不登录').catch(() => {})
await win.waitForTimeout(800)

// 系统选择框没法点，桩掉（同走查里 showSaveDialog 的做法）
await app.evaluate(({ dialog }, files) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files })
}, PIC)

await win.click('[data-testid="attach-btn"]')
await win.locator('[data-testid="attach-strip"]').waitFor({ timeout: 8000 })
await win.waitForTimeout(400)

const strip = await win.evaluate(() => {
  const imgs = [...document.querySelectorAll('[data-testid="attach-strip"] img')]
  return imgs.map((i) => ({ w: i.naturalWidth, isData: i.getAttribute('src').startsWith('data:') }))
})
check('缩略图条出现且两张都在', strip.length === 2, JSON.stringify(strip))
check('缩略图真渲染出来（量像素）', strip.every((s) => s.w > 0), JSON.stringify(strip))
check('缩略图是内存态 dataURL（不落库的前提）', strip.every((s) => s.isData), JSON.stringify(strip))

await win.screenshot({ path: join(root, 'e2e/shots/attach-附件缩略图.png') })

// 移除一张
await win.locator('[data-testid="attach-strip"] .group').first().hover()
await win.locator('[data-testid="attach-remove"]').first().click()
await win.waitForTimeout(300)
check('点 × 能移除一张', (await win.locator('[data-testid="attach-strip"] img').count()) === 1)

// 发送（本地模式没 key，AI 必然预检失败——但附件链路照样要走完）
await win.locator('textarea').first().fill('把这张图放进 PPT')
await win.keyboard.press('Enter')
await win.waitForTimeout(2500)

const bubble = await win.evaluate(() => {
  const el = document.querySelector('[data-testid="bubble-attachments"] img')
  return el ? { w: el.naturalWidth, src: el.getAttribute('src').slice(0, 12) } : null
})
check('消息气泡里显示缩略图', !!bubble && bubble.w > 0, JSON.stringify(bubble))
check('发送后输入框的附件条清空', (await win.locator('[data-testid="attach-strip"]').count()) === 0)

// 落库：thumb 必须被剥掉，文件名留着
const saved = await win.evaluate(async () => {
  const list = await window.api.chat.list()
  const msgs = list.flatMap((c) => c.messages).filter((m) => m.attachments?.length)
  return msgs.map((m) => m.attachments)
})
check('落库的消息里带着附件文件名', saved.length > 0 && saved[0][0].name, JSON.stringify(saved))
check('落库的附件**不含 thumb**（内存态不进持久层）', saved.every((a) => a.every((x) => !x.thumb)), JSON.stringify(saved))

// 主进程把附件拷进了本轮临时目录
const attachRoot = join(tmpdir(), 'mcnai-attach')
const staged = existsSync(attachRoot)
  ? readdirSync(attachRoot).flatMap((d) => readdirSync(join(attachRoot, d)).map((f) => join(attachRoot, d, f)))
  : []
check('附件已拷进临时目录（不依赖用户原文件还在）', staged.length >= 1, JSON.stringify(staged))
check('拷贝内容与原图一致', staged.length > 0 && readFileSync(staged[0]).length === readFileSync(PIC[1]).length,
  JSON.stringify({ staged: staged[0] }))

/**
 * ---- B7 文档附件：仅本轮参考、不入库（2026-08-19）----
 *
 * 三条都要**真验**，不许打印一行信息就算过（这一段第一版就是那么写的，被推翻重做）：
 *   ① 全链：选文档 → 发送 → 临时目录里出现**转换后的 .md**，内容是文档正文
 *   ② 失败要说话：损坏的 docx 必须给出人话原因
 *   ③ 清理：退出后临时目录不留东西
 */
{
  const DOC = join(root, 'e2e/sample.docx')

  // ① 全链：桩掉选择框喂 docx → 点附件 → **真发送一条消息**
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files })
  }, [DOC])
  await win.click('[data-testid="attach-btn"]')
  await win.locator('[data-testid="attach-strip"]').waitFor({ timeout: 8000 })
  const stripText = await win.locator('[data-testid="attach-strip"]').innerText().catch(() => '')
  check('文档附件出现在附件条上（显示文件名）', /sample/.test(stripText), JSON.stringify(stripText))

  await win.fill('textarea', '这份文档讲了什么')
  await win.keyboard.press('Enter')
  // 转换要起子进程，给足时间；不等 AI 回答（本地模式没 key，回不回都不影响这条断言）
  await win.waitForTimeout(12000)

  const attachRoot2 = join(tmpdir(), 'mcnai-attach')
  const walk = (x) => {
    try {
      return readdirSync(x, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(x, e.name)) : [join(x, e.name)]
      )
    } catch { return [] }
  }
  const files = existsSync(attachRoot2) ? walk(attachRoot2) : []
  const mds = files.filter((f) => f.endsWith('.md'))
  check('文档被转成了 markdown（临时目录里有 .md）', mds.length >= 1, JSON.stringify(files.map((f) => f.replace(attachRoot2, ''))))
  if (mds.length) {
    const text = readFileSync(mds[0], 'utf-8')
    check('转换出来的 md 有正文内容（不是空壳）', text.trim().length > 20, JSON.stringify(text.slice(0, 80)))
  }

  // ② 失败要说话：直接调冻结产物，验它给的是人话不是堆栈
  const BROKEN = join(tmpdir(), 'mcnai-b7-broken.docx')
  writeFileSync(BROKEN, '这不是一个真的 docx')
  // 转换失败时进程**应当**返回非 0（execFileSync 会抛），所以从异常里取 stdout——
  // 退出码不为 0 本身就是断言的一部分：静默成功才是错的
  let out = ''
  let exitedNonZero = false
  try {
    out = execFileSync(join(root, 'resources/pipeline/mcn-ingest'),
      ['convert-one', BROKEN, join(tmpdir(), 'mcnai-b7-out')], { encoding: 'utf-8' })
  } catch (e) {
    exitedNonZero = true
    out = String(e.stdout ?? '')
  }
  check('损坏文档 → 转换进程返回非 0（不许假装成功）', exitedNonZero)
  const lastLine = out.split('\n').filter((l) => l.startsWith('{')).pop() ?? ''
  let ev = {}
  try { ev = JSON.parse(lastLine) } catch { /* 下面的断言会报出来 */ }
  check('损坏文档 → 报错而不是静默', ev.status === 'error', lastLine)
  check('损坏文档 → 给的是人话原因', /损坏|无法解析|不支持/.test(String(ev.message ?? '')), String(ev.message))
  rmSync(BROKEN, { force: true })
  rmSync(join(tmpdir(), 'mcnai-b7-out'), { recursive: true, force: true })
}

await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15000))])
await new Promise((r) => setTimeout(r, 1500))

// ③ 退出后临时目录必须清干净——里面是**用户的真实文档**，不该留在磁盘上过夜
{
  const attachRoot3 = join(tmpdir(), 'mcnai-attach')
  const left = existsSync(attachRoot3) ? readdirSync(attachRoot3) : []
  check('退出后对话附件临时目录已清空', left.length === 0, JSON.stringify(left.slice(0, 5)))
}

console.log(bad ? `\n❌ ${bad} 条不通过\n` : '\n✅ 附件直供 + 文档附件全部通过\n')
process.exit(bad ? 1 : 0)
