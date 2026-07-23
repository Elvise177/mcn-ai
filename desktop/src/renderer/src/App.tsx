import { useCallback, useEffect, useRef, useState } from 'react'
import VaultPage from './pages/VaultPage'
import Workbench from './pages/Workbench'
import LoginGate from './pages/LoginGate'
import { UiHost, ui } from './components/ui'
import { VaultWizard } from './components/VaultWizard'
import logo from './assets/logo.png'
import { pendingNote } from './lib/bus'

type Page = 'workbench' | 'vault' | 'settings'

const newConv = (): Conversation => ({
  id: crypto.randomUUID(),
  title: '新对话',
  messages: [],
  updatedAt: Date.now(),
})

export default function App() {
  const [page, setPage] = useState<Page>('workbench')
  const [convs, setConvs] = useState<Conversation[]>([])
  const [active, setActive] = useState<Conversation>(newConv)
  const [account, setAccount] = useState<{ loggedIn: boolean; email?: string } | null>(null)
  const [localMode, setLocalMode] = useState(() => localStorage.getItem('localMode') === '1')
  const [vaultState, setVaultState] = useState<'loading' | 'none' | 'ready'>('loading')
  const [vaultSkipped, setVaultSkipped] = useState(() => localStorage.getItem('vaultSkipped') === '1')

  // 会话状态统一在这里维护：convsRef 同步镜像，流式事件按 sessionId 找到归属对话，
  // 即使用户已切到新对话，旧对话的回复也照常入库（否则切走=丢消息）
  const convsRef = useRef<Conversation[]>([])
  const activeRef = useRef(active)
  activeRef.current = active

  const upsert = useCallback((c: Conversation) => {
    window.api.chat.save(c)
    convsRef.current = [c, ...convsRef.current.filter((x) => x.id !== c.id)]
    setConvs(convsRef.current)
    if (activeRef.current.id === c.id) setActive(c)
  }, [])

  const appendMessage = useCallback(
    (sessionId: string, msg: ChatMessage, sdkSessionId?: string) => {
      const base =
        activeRef.current.id === sessionId
          ? activeRef.current
          : convsRef.current.find((x) => x.id === sessionId)
      if (!base) return
      const messages = [...base.messages, msg]
      upsert({
        ...base,
        messages,
        sdkSessionId: sdkSessionId ?? base.sdkSessionId,
        title: base.title === '新对话' && messages[0] ? messages[0].text.slice(0, 18) : base.title,
        updatedAt: Date.now(),
      })
    },
    [upsert]
  )

  useEffect(() => {
    window.api.chat.list().then((list) => {
      convsRef.current = list
      setConvs(list)
    })
    window.api.auth.state().then(setAccount)
    window.api.settings.get().then((s) => setVaultState(s.vaultPath ? 'ready' : 'none'))
    const offShortcut = window.api.shortcut.on((name) => {
      if (name === 'new-chat') {
        setActive(newConv())
        setPage('workbench')
      }
    })
    const offStream = window.api.chat.onStream((p) => {
      if (p.kind === 'assistant' && p.text != null) {
        appendMessage(p.sessionId, { role: 'assistant', text: p.text }, p.sdkSessionId)
      } else if (p.kind === 'error') {
        appendMessage(p.sessionId, { role: 'assistant', text: `⚠️ ${p.text}` })
      }
    })
    return () => {
      offShortcut()
      offStream()
    }
  }, [appendMessage])

  const handleLogout = useCallback(async () => {
    await window.api.auth.logout()
    localStorage.removeItem('localMode')
    setLocalMode(false)
    setAccount({ loggedIn: false })
  }, [])

  const handleSend = useCallback(
    (text: string) => {
      const base = activeRef.current
      const updated: Conversation = {
        ...base,
        messages: [...base.messages, { role: 'user', text }],
        title: base.title === '新对话' ? text.slice(0, 18) : base.title,
        updatedAt: Date.now(),
      }
      upsert(updated)
      window.api.chat.send(updated.id, text, updated.sdkSessionId)
    },
    [upsert]
  )

  const openNoteFromChat = useCallback(async (wikiTarget: string) => {
    const resolved = await window.api.vault.resolveLink(wikiTarget)
    if (resolved) {
      pendingNote.path = resolved
      setPage('vault')
    }
  }, [])

  if (account === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-bg">
        <img src={logo} alt="" className="fade-up h-16 w-16" draggable={false} />
        <div className="thinking-dots mt-6"><span /><span /><span /></div>
      </div>
    )
  }
  if (!account.loggedIn && !localMode) {
    return (
      <LoginGate
        onLoggedIn={async () => setAccount(await window.api.auth.state())}
        onSkip={() => {
          localStorage.setItem('localMode', '1')
          setLocalMode(true)
        }}
      />
    )
  }
  // 首跑第二步：建库引导（登录 → 建库 → 对话）。跳过后可随时在「个人知识库」里建
  if (vaultState === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-bg">
        <img src={logo} alt="" className="fade-up h-16 w-16" draggable={false} />
        <div className="thinking-dots mt-6"><span /><span /><span /></div>
      </div>
    )
  }
  if (vaultState === 'none' && !vaultSkipped) {
    return (
      <div className="titlebar-drag flex h-full flex-col items-center justify-center bg-bg">
        <VaultWizard
          onReady={() => setVaultState('ready')}
          onSkip={() => {
            localStorage.setItem('vaultSkipped', '1')
            setVaultSkipped(true)
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <UiHost />
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="titlebar-drag px-5 pb-4 pt-10">
          <div className="text-xl font-semibold text-rose">mcn-ai</div>
          <div className="mt-0.5 text-[11px] text-muted">AI 工作操作台</div>
        </div>
        <button
          onClick={() => {
            setActive(newConv())
            setPage('workbench')
          }}
          className="mx-4 mb-4 rounded-full bg-rose py-2 text-sm font-medium text-white hover:opacity-90"
        >
          ＋ 新对话
        </button>

        <nav className="space-y-1 px-3">
          {(
            [
              ['vault', '个人知识库'],
              ['settings', '设置'],
            ] as [Page, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPage(key)}
              className={`w-full rounded-lg px-3 py-2 text-left text-[13px] ${
                page === key ? 'bg-rose-soft font-medium text-rose' : 'text-ink/70 hover:bg-black/[0.03]'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-5 flex min-h-0 flex-1 flex-col">
          {convs.length > 0 && (
            <>
              <div className="mb-1 px-5 text-[11px] text-muted">最近对话</div>
              <div className="min-h-0 flex-1 overflow-auto px-3 pb-2">
                {convs.map((c) => (
                  <div key={c.id} className="group relative">
                    <button
                      onClick={() => {
                        setActive(c)
                        setPage('workbench')
                      }}
                      className={`w-full truncate rounded-lg px-3 py-1.5 pr-7 text-left text-[13px] ${
                        page === 'workbench' && active.id === c.id ? 'bg-card font-medium' : 'text-ink/70 hover:bg-black/[0.03]'
                      }`}
                    >
                      {c.title}
                    </button>
                    <button
                      onClick={async () => {
                        await window.api.chat.delete(c.id)
                        convsRef.current = convsRef.current.filter((x) => x.id !== c.id)
                        setConvs(convsRef.current)
                        if (active.id === c.id) setActive(newConv())
                      }}
                      className="absolute right-1.5 top-1 hidden rounded px-1 text-[12px] text-muted hover:text-rose group-hover:block"
                      title="删除对话"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="border-t border-line px-5 py-4 text-[11px] text-muted">
          {account.email ? account.email.split('@')[0] + ' · ' : ''}v0.1.0
        </div>
      </aside>

      <main className="flex-1 overflow-hidden">
        {page === 'workbench' && (
          <Workbench conv={active} onSend={handleSend} onOpenNote={openNoteFromChat} userName={account.email?.split('@')[0]} />
        )}
        {page === 'vault' && <VaultPage />}
        {page === 'settings' && <SettingsPage account={account} onLogout={handleLogout} />}
      </main>
    </div>
  )
}

/** 知识入库设置：AI 产物是否自动送入投递箱转为可检索知识 */
function IngestCard() {
  const [auto, setAuto] = useState(false)
  useEffect(() => {
    window.api.settings.get().then((s) => setAuto(s.artifactAutoIngest))
  }, [])
  return (
    <div className="mb-6 max-w-xl space-y-3 rounded-2xl border border-line bg-card p-6">
      <div className="text-sm font-medium">知识入库</div>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked)
            void window.api.settings.setArtifactAutoIngest(e.target.checked)
          }}
          className="accent-rose"
        />
        AI 生成的产物自动入库（送入投递箱转为可检索知识）
      </label>
      <div className="text-[12px] leading-5 text-muted">
        关闭时产物仅保存在 90_产物/，可在产物面板对单个文件点「入库」；开启后每个新产物自动转为知识库笔记并参与 AI 检索。
      </div>
    </div>
  )
}

function SettingsPage({
  account,
  onLogout,
}: {
  account: { loggedIn: boolean; email?: string }
  onLogout: () => void
}) {
  const [hasKey, setHasKey] = useState(false)
  const [apiBase, setApiBase] = useState('')

  useEffect(() => {
    window.api.settings.get().then((s) => {
      setHasKey(s.hasApiKey)
      setApiBase(s.apiBaseUrl)
    })
  }, [])

  return (
    <div className="h-full overflow-auto p-10">
      <h2 className="mb-1 text-xl font-semibold">设置</h2>
      <p className="mb-6 text-sm text-muted">AI 服务随账号自动配置，密钥用 macOS Keychain 加密存储</p>

      <div className="mb-6 max-w-xl space-y-4 rounded-2xl border border-line bg-card p-6">
        <div className="text-sm font-medium">账号（云端同步：私人知识层 + 聊天记录）</div>
        {account.loggedIn ? (
          <div className="flex items-center justify-between text-sm">
            <span>
              已登录：<span className="text-rose">{account.email}</span>
            </span>
            <button
              onClick={onLogout}
              className="rounded-full border border-line px-3 py-1 text-[12px] text-muted hover:text-rose"
            >
              退出登录
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">当前为本地模式（无云端检索与同步）</span>
            <button
              onClick={onLogout}
              className="rounded-full bg-rose px-3 py-1 text-[12px] text-white hover:opacity-90"
            >
              去登录
            </button>
          </div>
        )}
        <div className="text-sm">
          AI 服务：
          {hasKey ? (
            <span className="text-rose">已就绪 ✓（随账号自动配置）</span>
          ) : (
            <span className="text-muted">登录后自动配置</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="shrink-0 text-muted">服务器</span>
          <input
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            onBlur={() => window.api.settings.setApiBase(apiBase)}
            className="flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 font-mono text-[12px] outline-none focus:border-rose"
          />
        </div>
      </div>

      <IngestCard />

      <div className="mb-6 max-w-xl space-y-3 rounded-2xl border border-line bg-card p-6">
        <div className="text-sm font-medium">遇到问题？</div>
        <div className="text-[12px] text-muted">导出诊断报告（环境信息 + 最近日志，已自动去除密钥），发给管理员即可远程排查。</div>
        <button
          onClick={async () => {
            await window.api.diag.export()
            ui.toast('诊断报告已导出到桌面')
          }}
          className="rounded-full border border-line px-4 py-1.5 text-[13px] hover:bg-rose-soft"
        >
          导出诊断报告到桌面
        </button>
      </div>

    </div>
  )
}
