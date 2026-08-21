/**
 * 库内嵌图渲染验收：`02_convert` 抽出来的图必须**真的在应用里显示出来**。
 * 运行: node e2e/assets-render.mjs
 *
 * **为什么单独一个脚本**：它要一个"已经抽过图"的库当前提，而主走查那个库是
 * 现跑 pipeline 生成的——把它并进去就得先跑一轮真实入库，时序又会把后面按序写的
 * 断言推偏（同 a1-enqueue 拆出去的理由）。这里自己造一个最小库，零 pipeline、零 LLM。
 *
 * **断言一律量像素，不数标签**：`<img>` 在、但 `naturalWidth=0` 正是这条链路最典型的
 * 失败形态（CSP 拦掉、路径没对上、协议没注册，表现全都一样是"标签在、图不出来"）。
 * 用量页那 14 根柱子的教训：结构性断言对"算出来是 0"这类塌陷是瞎的。
 */
import { _electron as electron } from 'playwright-core'
import { rmSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'fs'
import { join } from 'path'

const root = '/Users/tansenpeng/Documents/AI/mcn-ai/desktop'
const USERDATA = '/tmp/mcnai-img-userdata'
const VAULT = '/tmp/mcnai-img-vault'
const say = (m) => console.log('· ' + m)
let bad = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + d}`); if (!ok) bad++ }

rmSync(USERDATA, { recursive: true, force: true })
rmSync(VAULT, { recursive: true, force: true })
mkdirSync(join(VAULT, '.mcnai'), { recursive: true })
mkdirSync(join(VAULT, '80_资料库/工作-管理类'), { recursive: true })
mkdirSync(join(VAULT, '_assets/带图笔记'), { recursive: true })
writeFileSync(join(VAULT, '.mcnai/layout.json'), JSON.stringify({ inbox: '00_投递箱', library: '80_资料库' }))
mkdirSync(join(VAULT, '00_投递箱'), { recursive: true })

/**
 * 真图一张，**取自仓库内已提交的素材**（原来指向某次会话的 scratchpad，
 * 那个目录被清掉后必炸——详见 attachments.mjs 里同一处的注释）。
 */
const src = join(import.meta.dirname, '..', 'build', 'icon-candidates')
const img = readdirSync(src).filter((f) => /\.(png|jpg)$/i.test(f)).sort()[0]
copyFileSync(join(src, img), join(VAULT, '_assets/带图笔记', 'img01' + img.slice(img.lastIndexOf('.'))))
const ref = `../../_assets/带图笔记/img01${img.slice(img.lastIndexOf('.'))}`
writeFileSync(join(VAULT, '80_资料库/工作-管理类/带图笔记.md'),
  `---\ndoc_type: 课件\nimages: 1\n---\n\n# 带图笔记\n\n正文一段。\n\n![](${ref})\n`)
say(`造好库：图 ${img}，正文引用 ${ref}`)

const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [root],
  env: { ...process.env, MCNAI_USER_DATA: USERDATA, MCNAI_VAULT: VAULT, NODE_ENV: 'production' },
  timeout: 60000,
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.setViewportSize({ width: 1440, height: 920 })
await win.waitForTimeout(2500)
await win.click('text=暂不登录').catch(() => {})
await win.waitForTimeout(800)
await win.click('text=个人知识库').catch(() => {})
await win.locator('input[placeholder="搜索库…"]').waitFor({ timeout: 20000 })
// 目录默认折叠：逐级展开再点笔记（笔记是嵌在 80_资料库/工作-管理类/ 里的，
// 正文里的引用正是 02_convert 真实产出的那种 ../../ 相对路径）
for (const dir of ['80_资料库', '工作-管理类']) {
  await win.locator(`[data-testid="tree-col"] button:has-text("${dir}")`).first().click()
  await win.waitForTimeout(400)
}
await win.locator('[data-testid="tree-col"] button.block.truncate:has-text("带图笔记")').first().click()
await win.waitForTimeout(1500)

const info = await win.evaluate(() => {
  const im = document.querySelector('.md-article img')
  return im ? { src: im.getAttribute('src'), w: im.naturalWidth, h: im.naturalHeight } : null
})
check('正文里有 <img>', !!info)
check('src 已改写成 mcnai-asset 协议', !!info && info.src.startsWith('mcnai-asset://'), info?.src)
check('图真的加载出来了（naturalWidth>0，量像素不数标签）', !!info && info.w > 0, JSON.stringify(info))

// 越界与非图片必须被挡。**不能用 fetch 验**：自定义协议对渲染进程是跨源的，
// fetch 一律 "Failed to fetch"，403 与 CORS 长得一模一样，等于什么都没断言。
// 改用 <img> 加载——图片加载不受同源限制，加载成功=真被服务了，失败=真被拒了。
const probeImg = (url) =>
  win.evaluate(
    (u) =>
      new Promise((res) => {
        const im = new Image()
        im.onload = () => res({ ok: true, w: im.naturalWidth })
        im.onerror = () => res({ ok: false })
        im.src = u
        setTimeout(() => res({ ok: false, timeout: true }), 4000)
      }),
    url
  )
const good = await probeImg(info.src)
check('对照组：正常图片经 <img> 能加载', good.ok && good.w > 0, JSON.stringify(good))
const traversal = await probeImg('mcnai-asset://v/../../../../etc/passwd')
check('路径穿越加载不出来', !traversal.ok, JSON.stringify(traversal))
const asMd = await probeImg('mcnai-asset://v/80_%E8%B5%84%E6%96%99%E5%BA%93/%E5%B7%A5%E4%BD%9C-%E7%AE%A1%E7%90%86%E7%B1%BB/%E5%B8%A6%E5%9B%BE%E7%AC%94%E8%AE%B0.md')
check('非图片扩展名加载不出来（不能变成任意读文件的口子）', !asMd.ok, JSON.stringify(asMd))

mkdirSync(join(root, 'e2e/shots'), { recursive: true })
await win.screenshot({ path: join(root, 'e2e/shots/assets-嵌图渲染.png') })
await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15000))])
console.log(bad ? `\n❌ ${bad} 条不通过\n` : '\n✅ 资产协议全部通过\n')
process.exit(bad ? 1 : 0)
