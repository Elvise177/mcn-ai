import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.css'

// 渲染端未捕获错误统一进主进程日志（诊断报告可见）
window.addEventListener('error', (e) => window.api?.diag?.log('error', `${e.message} @${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => window.api?.diag?.log('error', `unhandled: ${e.reason}`))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
