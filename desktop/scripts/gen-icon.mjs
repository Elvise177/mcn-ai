/**
 * 生成 macOS 应用图标（icns 全尺寸套件）—— SamePage 对齐线母题的圆角方形容器版。
 *
 * 跑法：node scripts/gen-icon.mjs
 *   产物：build/icon.iconset/*.png（10 张）→ build/icon.icns（iconutil 合成）
 *   依赖：Google Chrome（playwright-core 的 channel:'chrome'，本机已装）+ 系统自带 iconutil
 *
 * 几何与 src/renderer/src/components/Logo.tsx 是同一套（改一处要改两处，这里刻意不共享代码：
 * 渲染层是 tsx，这个脚本跑在 node 上且要出位图，走 import 只会给构建增加一条无谓的依赖）。
 * 小尺寸（16/32）走 dense 加粗系数，理由见 Logo.tsx 顶部注释。
 */
import { chromium } from 'playwright-core'
import { mkdirSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const iconset = join(root, 'build', 'icon.iconset')

// —— 品牌几何（同 Logo.tsx）——
const YS = [7, 12, 17]
const X1S = [4, 9.5, 6.75]
const X2 = 15
const BAR_X = 19
const BAR_TOP = 4
const BAR_BOT = 20
const LINE_W = 2
const BAR_W = 2.5
const DENSE_LINE = 1.15
const DENSE_BAR = 1.24

// —— 图标配色：深底 + 浅线条 + 橙基准线（深底上用提亮橙，#E8590C 压在 #1E1C1A 上会发闷）——
const ICON_BG = '#1E1C1A'
const ICON_LINE = '#E6E1D8'
const ICON_BAR = '#FF6B1A'

/** macOS 图标栅格：1024 画布里主体 824（内缩 9.77%），圆角 185.4（主体边长的 22.5%） */
const RADIUS_RATIO = 185.4 / 824
/**
 * 主体内缩比 / 标记占主体的比例：小尺寸要专门放大。
 * 16px 上按标准栅格算，标记只剩 ~8px 高，三条横线加两道缝根本挤不下（实测糊成一团），
 * 所以 ≤32px 减小内缩、放大标记，换取"三条线还数得出来"。
 */
const ratios = (S) =>
  S <= 16 ? { body: 0.94, mark: 0.84 } : S <= 32 ? { body: 0.9, mark: 0.74 } : { body: 824 / 1024, mark: 0.6 }
/** 墨迹（含线帽）水平中心是 11.625 而不是 12，不补这 0.375 图形会偏左 */
const INK_DX = 0.375

const svgFor = (S) => {
  const dense = S <= 32
  const lw = (LINE_W * (dense ? DENSE_LINE : 1)).toFixed(3)
  const bw = (BAR_W * (dense ? DENSE_BAR : 1)).toFixed(3)
  const rt = ratios(S)
  const body = S * rt.body
  const off = (S - body) / 2
  const r = body * RADIUS_RATIO
  const mark = body * rt.mark
  const mx = (S - mark) / 2
  const lines = YS.map(
    (y, i) =>
      `<line x1="${X1S[i] + INK_DX}" y1="${y}" x2="${X2 + INK_DX}" y2="${y}" stroke="${ICON_LINE}" stroke-width="${lw}" stroke-linecap="round"/>`,
  ).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect x="${off}" y="${off}" width="${body}" height="${body}" rx="${r}" ry="${r}" fill="${ICON_BG}"/>
  <svg x="${mx}" y="${mx}" width="${mark}" height="${mark}" viewBox="0 0 24 24">
    ${lines}
    <line x1="${BAR_X + INK_DX}" y1="${BAR_TOP}" x2="${BAR_X + INK_DX}" y2="${BAR_BOT}" stroke="${ICON_BAR}" stroke-width="${bw}" stroke-linecap="round"/>
  </svg>
</svg>`
}

/** iconset 清单：iconutil 认死这些文件名 */
const TARGETS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
for (const [name, size] of TARGETS) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}</style>${svgFor(size)}`,
  )
  // omitBackground：圆角外必须是透明的，否则 Dock 里会顶着一块白方块
  await page.screenshot({ path: join(iconset, name), omitBackground: true })
  console.log('✓', name, `${size}px`)
}
await browser.close()

execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build', 'icon.icns')])
console.log('✓ build/icon.icns')
