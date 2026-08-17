import { useState } from 'react'
import logo from '../assets/logo.png'
import { useTask } from '../hooks/useTasks'

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
  // M-29：登录成功后要把会话与 AI key 加密落盘，首次会很慢（系统校验应用签名）。
  // 现在这一步是后台任务、不再挡住登录，但得让用户看见"在干嘛"，别以为卡死了
  const secretTask = useTask('secret')
  const saving = !!secretTask && (secretTask.status === 'running' || secretTask.status === 'queued')

  /**
   * M-01：登录失败必须区分「网络不可达」和「密码错」。
   * Supabase 被暂停（域名直接 NXDOMAIN）或断网时报"密码错"是最坏的一种误导——
   * 用户会一遍遍改密码，永远不会想到去看网络。
   */
  const submit = async (): Promise<void> => {
    if (!email.trim() || !pwd || busy) return
    setBusy(true)
    setErr('')
    const r = await window.api.auth.login(email.trim(), pwd)
    setBusy(false)
    if (r.ok) return onLoggedIn()
    if (r.kind === 'canceled') return setErr('已取消登录')
    if (r.kind === 'network')
      return setErr('连不上服务器：网络不通，或云端暂时不可用。可先「暂不登录，仅本地使用」')
    if (r.kind === 'timeout')
      return setErr('登录超时（10 秒没有响应）：多半是网络不通或云端不可用，稍后再试')
    if (r.kind === 'credential')
      return setErr(r.error === 'Invalid login credentials' ? '邮箱或密码不对' : (r.error ?? '登录失败'))
    setErr(r.error ?? '登录失败')
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
        {(busy || saving) && (
          <div data-testid="login-saving" className="text-sm leading-5 text-muted">
            {saving ? '正在安全保存密钥，首次可能需要较长时间（系统会校验应用签名）' : '正在登录…'}
          </div>
        )}
        <button
          onClick={submit}
          disabled={busy}
          className="w-full rounded-input bg-ink py-3 text-md font-medium text-on-solid hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '登录中…' : '登录'}
        </button>
        {/* 可取消：Supabase 挂起时不给出口的话，这颗按钮会永远定格在「登录中…」（M-01） */}
        {busy && (
          <button
            data-testid="login-cancel"
            onClick={() => void window.api.auth.loginCancel()}
            className="w-full rounded-input border border-line bg-card py-2 text-base text-muted hover:bg-hover"
          >
            取消登录
          </button>
        )}
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
