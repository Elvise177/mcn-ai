/**
 * 窗口几何的恢复判据（F25）——纯函数，不碰 electron。
 *
 * **为什么抽出来**：这段逻辑最要命的分支是「上次记的坐标现在整个在屏幕外」——
 * 用户在公司接了外接显示器、把窗口拖到副屏，回家拔掉线再打开应用，
 * 窗口**开在了不存在的地方**：Dock 上有图标、菜单栏是它的，屏幕上什么都没有。
 * 用户只会报"打不开"。真造这个分支要插拔显示器，没人会为它跑一遍
 * （desktop/CLAUDE.md 铁律：要不要费劲才能触发？要，就抽出来）。
 */

export interface SavedBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/** 窗口最小尺寸（与 BrowserWindow 的 minWidth/minHeight 一致） */
export const MIN_W = 1080
export const MIN_H = 700

/**
 * 「这扇窗还看得见吗」。判据是**左上角附近有一块落在某个屏幕的工作区里**——
 * 不要求整扇窗都在里面：用户本来就可能把窗口拖得半出屏，那是他自己的选择，
 * 下次开还给他同一个位置才对。
 */
export function isOnScreen(b: { x: number; y: number; width: number; height: number }, areas: WorkArea[]): boolean {
  return areas.some(
    (a) =>
      b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y < a.y + a.height - 40 && b.y + b.height > a.y
  )
}

/**
 * 算出这次该用的几何。
 *
 * - 没存过 / 存的是坏值 → 出厂尺寸，位置交给系统（居中）
 * - 存过但尺寸小于下限 → 顶到下限（存量里可能有更早版本写坏的值）
 * - 位置在屏幕外 → **只要尺寸、丢掉坐标**，让系统居中；不能连尺寸一起丢，
 *   那样用户调过的窗口大小也白调了
 */
export function pickBounds(
  saved: SavedBounds | undefined,
  areas: WorkArea[],
  fallback: { width: number; height: number }
): { x?: number; y?: number; width: number; height: number } {
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height) || saved.width <= 0 || saved.height <= 0) {
    return { ...fallback }
  }
  const width = Math.max(MIN_W, Math.round(saved.width))
  const height = Math.max(MIN_H, Math.round(saved.height))
  if (!Number.isFinite(saved.x as number) || !Number.isFinite(saved.y as number)) return { width, height }
  const x = Math.round(saved.x as number)
  const y = Math.round(saved.y as number)
  return isOnScreen({ x, y, width, height }, areas) ? { x, y, width, height } : { width, height }
}
