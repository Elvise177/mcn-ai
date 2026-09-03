import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * 白屏保护（F1）。
 *
 * 渲染层任何一处组件抛异常，React 18 的默认行为是**卸载整棵树**——用户看到的是
 * 一片空白的窗口，没有一个字说明发生了什么，也没有任何出口。日志里其实有痕
 * （main.tsx 顶部那两个 window 监听把未捕获错误送进主进程），但客户不会去翻日志，
 * 他只会说"软件打不开了"。
 *
 * 所以这里给的不是"更好看的报错页"，是**两个出口**：
 *   ① 重载界面 —— 绝大多数渲染层异常是一次性的（某条数据的形状没料到），重载即恢复
 *   ② 导出诊断报告 —— 恢复不了时，让他一键把现场发给我们，而不是靠口述
 *
 * `componentDidCatch` 里那次 `diag.log` 是**唯一能拿到组件栈的地方**：
 * window 的 error 监听只有异常本身，看不出是哪棵子树炸的。
 */

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
  /** 组件栈（React 给的那段），只进日志与诊断报告，不摆在界面上吓人 */
  stack?: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 主进程日志里留全量现场：诊断报告读的就是这份日志
    void window.api?.diag?.log(
      'error',
      `渲染层崩溃：${error.message}\n${error.stack ?? ''}\n组件栈：${info.componentStack ?? ''}`
    )
    this.setState({ stack: info.componentStack ?? undefined })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        data-testid="crash-page"
        className="flex h-full flex-col items-center justify-center gap-4 bg-bg px-8 text-center"
      >
        <AlertTriangle size={32} className="text-warn" />
        <div className="text-xl font-semibold">界面出了点问题</div>
        <div className="max-w-md text-md leading-snug text-muted">
          这一次的界面没能画出来，你的知识库文件与聊天记录都还在原处，没有受影响。
          先点「重新加载」，多数情况下一次就好；还是不行就导出诊断报告发给管理员。
        </div>
        {/* 错误原文用等宽小字摆一行：它是给管理员看的线索，不是给用户读的正文 */}
        <div
          data-testid="crash-reason"
          className="max-w-md truncate rounded-md bg-surface px-3 py-2 font-mono text-sm text-muted"
          title={error.message}
        >
          {error.message || '未知错误'}
        </div>
        <div className="flex gap-2">
          <button
            data-testid="crash-reload"
            onClick={() => window.location.reload()}
            className="rounded-full bg-accent px-4 py-2 text-base text-on-solid hover:opacity-90"
          >
            重新加载
          </button>
          <button
            data-testid="crash-export"
            onClick={async () => {
              try {
                await window.api.diag.export()
              } catch {
                /* 崩溃页上不能再弹 toast（UiHost 可能也在这棵树里），失败就只留日志 */
              }
            }}
            className="rounded-full border border-line px-4 py-2 text-base hover:bg-hover"
          >
            导出诊断报告
          </button>
        </div>
      </div>
    )
  }
}

/**
 * 走查专用的崩溃探针：`MCNAI_E2E_THROW=1` 时在渲染期抛一次，验 ErrorBoundary 真的接住了。
 * 生产里 `window.api.e2e.crashOnMount` 恒为 false（preload 读 `process.env`，打包后没人设它）。
 *
 * **为什么要有它**：白屏保护本身只在"已经出事"时才会走到，没有开关就等于永远没被测过——
 * 与 R3 超时开关同一条判据（HANDOFF §4-22）。
 */
export function CrashProbe(): null {
  if (window.api?.e2e?.crashOnMount) throw new Error('e2e 模拟的渲染层崩溃')
  return null
}
