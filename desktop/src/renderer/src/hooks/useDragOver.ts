import { useRef, useState, type DragEvent } from 'react'

/**
 * 「有文件正拖在这个区域上」的可靠判定。
 *
 * 直觉写法是 `onDragLeave: if (e.currentTarget === e.target) 隐藏`，**它是错的**：
 * 覆盖层一出现，指针就压在覆盖层（或它的子元素）上，拖出窗口时最后一次 `dragleave`
 * 的 `target` 是那个子元素、不是容器，条件不成立 —— 覆盖层于是永远挂在屏幕上，
 * 用户只能点一下或重新拖一次才能消掉（2026-08-18 真人探索测试实测踩到）。
 *
 * 这里用**进出计数**：`dragenter` +1、`dragleave` -1，归零才算真的离开。
 * 在子元素之间穿梭时 enter/leave 成对出现，计数不动，覆盖层稳定不闪。
 * 计数下限钳到 0——浏览器偶尔会多发一次 leave，不钳的话会变成负数、之后再也归不了零。
 *
 * `onDragOver` 必须 `preventDefault`，否则浏览器压根不会派发 `drop`。
 */
export function useDragOver(onLeave?: () => void): {
  over: boolean
  reset: () => void
  handlers: {
    onDragEnter: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDragLeave: (e: DragEvent) => void
  }
} {
  const depth = useRef(0)
  const [over, setOver] = useState(false)

  const reset = (): void => {
    depth.current = 0
    setOver(false)
    onLeave?.()
  }

  return {
    over,
    reset,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        e.preventDefault()
        depth.current++
        setOver(true)
      },
      onDragOver: (e: DragEvent) => {
        e.preventDefault()
      },
      onDragLeave: (e: DragEvent) => {
        e.preventDefault()
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) reset()
      },
    },
  }
}
