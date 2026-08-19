/**
 * SamePage 品牌标记（对齐线） —— 三条长短不一的横线 + 一条橙色垂直基准线（对齐线母题）。
 *
 * 几何是唯一真相源（也被 scripts/gen-icon.mjs 复用去出 icns，改这里要同步改那边）：
 *   横线 y=7/12/17（长/短/中），右端齐 x=15，线宽 2
 *   基准线 x=19，y=4~20，线宽 2.5（比横线重一档，主次分明）
 *   横线右端与基准线之间刻意留一道气口——基准线是"尺"，不是把横线焊死的框
 *
 * 小尺寸规则（≤20px 走 dense）：横线 ×1.15、基准线 ×1.24。
 * 两个系数是像素实测挑出来的，不是拍脑袋（16×16 光栅化后逐像素看）：
 *   - 同比 ×1.28 会把那道气口吃到 0.75px，糊成一块
 *   - 只加粗横线（基准线不动）气口是干净了，但橙线反而比横线细，主次倒挂
 * 改这两个系数必须重跑一次 16px 像素复验，别凭直觉调。
 */
const YS = [7, 12, 17]
const X1S = [4, 9.5, 6.75] // 长 / 短 / 中
const X2 = 15
const BAR_X = 19
const BAR_TOP = 4
const BAR_BOT = 20
const LINE_W = 2
const BAR_W = 2.5
/** ≤ 这个尺寸就加粗（侧栏 16–20px 落点全在这一档） */
const DENSE_MAX = 20
const DENSE_LINE = 1.15
const DENSE_BAR = 1.24

export default function Logo({
  size = 24,
  className,
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  const dense = size <= DENSE_MAX
  const lw = (LINE_W * (dense ? DENSE_LINE : 1)).toFixed(2)
  const bw = (BAR_W * (dense ? DENSE_BAR : 1)).toFixed(2)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-testid="brand-logo"
    >
      {YS.map((y, i) => (
        <line
          key={y}
          x1={X1S[i]}
          y1={y}
          x2={X2}
          y2={y}
          stroke="currentColor"
          strokeWidth={lw}
          strokeLinecap="round"
        />
      ))}
      {/* 基准线走独立 token：浅底用信号橙，深色侧栏里自动换成提亮橙（见 theme.css 的 .sidebar-dark） */}
      <line
        x1={BAR_X}
        y1={BAR_TOP}
        x2={BAR_X}
        y2={BAR_BOT}
        stroke="var(--color-logo-bar)"
        strokeWidth={bw}
        strokeLinecap="round"
        data-testid="brand-logo-bar"
      />
    </svg>
  )
}
