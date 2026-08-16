import { useState } from 'react'
import logo from '../assets/logo.png'

/** 启动登录门（Claude Desktop 式）：登录后自动下发 AI 配置；可跳过进入纯本地模式 */
export default function LoginGate({
  onLoggedIn,
  onSkip,
}: {
  onLoggedIn: () => void
  onSkip: () => void
}) {
  const [email, setEmail] = useState('')
  const [pwd, setPwd] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!email.trim() || !pwd || busy) return
    setBusy(true)
    setErr('')
    const r = await window.api.auth.login(email.trim(), pwd)
    setBusy(false)
    if (r.ok) onLoggedIn()
    else setErr(r.error === 'Invalid login credentials' ? '邮箱或密码不对' : (r.error ?? '登录失败'))
  }

  return (
    <div className="titlebar-drag flex h-full flex-col items-center justify-center bg-bg">
      <img src={logo} alt="" className="fade-up mb-4 h-20 w-20" draggable={false} />
      <div className="mb-2 text-3xl font-semibold text-ink">你的 AI 工作操作台</div>
      <div className="mb-10 text-md text-muted">登录后即刻可用</div>

      <div className="w-96 space-y-3">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱"
          autoFocus
          className="w-full rounded-input border border-line bg-card px-4 py-3 text-md outline-none focus:border-accent"
        />
        <input
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="密码"
          className="w-full rounded-input border border-line bg-card px-4 py-3 text-md outline-none focus:border-accent"
        />
        {err && <div className="text-sm text-danger">{err}</div>}
        <button
          onClick={submit}
          disabled={busy}
          className="w-full rounded-input bg-ink py-3 text-md font-medium text-on-solid hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </div>

      <div className="mt-6 flex flex-col items-center gap-3 text-sm text-muted">
        <span>账号由管理员发放</span>
        {/* 这是真入口，不是说明文字：给描边按钮样式，别让人以为只是一句话 */}
        <button
          onClick={onSkip}
          className="rounded-full border border-line bg-card px-4 py-1.5 text-base text-ink hover:bg-hover"
        >
          暂不登录，仅本地使用
        </button>
      </div>
    </div>
  )
}
