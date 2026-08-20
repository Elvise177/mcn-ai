import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { WriteConfirm } from './components/WriteConfirm'
import { UiHost } from './components/ui'
import './styles/index.css'

// 渲染端未捕获错误统一进主进程日志（诊断报告可见）
window.addEventListener('error', (e) => window.api?.diag?.log('error', `${e.message} @${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => window.api?.diag?.log('error', `unhandled: ${e.reason}`))

// 拖文件落在没有投递区的地方时，浏览器默认行为是导航到 file://（= 整个界面被那个文件替换）。
// 这里在 window 冒泡阶段统一 preventDefault：React 的 onDrop 先跑，之后默认行为一律吃掉。
// 主进程的 will-navigate 是第二层兜底
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => e.preventDefault())
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    {/* UiHost 挂在 App 外面：它以前在主界面布局里，于是首跑的登录门/建库引导那几屏
        根本没有 toast 宿主，`ui.toast` 静默空转——建库失败连报错都弹不出来（H-12 走查抓到） */}
    {/* AI 写知识库的确认卡（B4）：与 UiHost 一样挂在 App 外面——
        它可能在登录门/建库引导那几屏之外的任何时刻弹出来 */}
    <WriteConfirm />
    <UiHost />
  </React.StrictMode>
)
