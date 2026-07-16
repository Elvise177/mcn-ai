import { useState } from 'react'

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
      <div className="mb-2 font-serif text-5xl text-ink">mcn-ai</div>
      <div className="mb-10 text-sm text-muted">你的 AI 工作操作台 · 登录后即刻可用</div>

      <div className="w-96 space-y-3">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱"
          autoFocus
          className="w-full rounded-xl border border-line bg-card px-4 py-3 text-sm outline-none focus:border-rose"
        />
        <input
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="密码"
          className="w-full rounded-xl border border-line bg-card px-4 py-3 text-sm outline-none focus:border-rose"
        />
        {err && <div className="text-[12px] text-red-600">{err}</div>}
        <button
          onClick={submit}
          disabled={busy}
          className="w-full rounded-xl bg-rose py-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </div>

      <div className="mt-6 text-[12px] text-muted">
        账号由管理员发放 ·{' '}
        <button onClick={onSkip} className="hover:text-rose hover:underline">
          暂不登录，仅本地使用
        </button>
      </div>
    </div>
  )
}
