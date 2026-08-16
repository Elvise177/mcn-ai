import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
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
  </React.StrictMode>
)
