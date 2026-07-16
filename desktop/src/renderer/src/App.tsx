import { useCallback, useEffect, useState } from 'react'
import VaultPage from './pages/VaultPage'
import Workbench from './pages/Workbench'
import LoginGate from './pages/LoginGate'
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

  useEffect(() => {
    window.api.chat.list().then(setConvs)
    window.api.auth.state().then(setAccount)
    return window.api.shortcut.on((name) => {
      if (name === 'new-chat') {
        setActive(newConv())
        setPage('workbench')
      }
    })
  }, [])

  const handleLogout = useCallback(async () => {
    await window.api.auth.logout()
    localStorage.removeItem('localMode')
    setLocalMode(false)
    setAccount({ loggedIn: false })
  }, [])

  const onConvUpdate = useCallback((c: Conversation) => {
    setActive(c)
    setConvs((old) => [c, ...old.filter((x) => x.id !== c.id)])
  }, [])

  const openNoteFromChat = useCallback(async (wikiTarget: string) => {
    const resolved = await window.api.vault.resolveLink(wikiTarget)
    if (resolved) {
      pendingNote.path = resolved
      setPage('vault')
    }
  }, [])

  if (account === null) {
    return <div className="flex h-full items-center justify-center bg-bg text-sm text-muted">…</div>
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

  return (
    <div className="flex h-full">
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

        {convs.length > 0 && (
          <>
            <div className="mb-1 px-5 text-[11px] text-muted">对话历史</div>
            <div className="max-h-[38%] overflow-auto px-3">
              {convs.slice(0, 20).map((c) => (
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
                      setConvs((old) => old.filter((x) => x.id !== c.id))
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

        <div className="mb-2 mt-4 px-5 text-[11px] text-muted">模块</div>
        <nav className="flex-1 space-y-1 px-3">
          {(
            [
              ['workbench', '对话工作台'],
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
        <div className="border-t border-line px-5 py-4 text-[11px] text-muted">v0.1.0 · MVP</div>
      </aside>

      <main className="flex-1 overflow-hidden">
        {page === 'workbench' && <Workbench conv={active} onConvUpdate={onConvUpdate} onOpenNote={openNoteFromChat} />}
        {page === 'vault' && <VaultPage />}
        {page === 'settings' && <SettingsPage account={account} onLogout={handleLogout} />}
      </main>
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
  const [baseUrl, setBaseUrl] = useState('')
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  const [hasLlmKey, setHasLlmKey] = useState(false)
  const [llmBaseUrl, setLlmBaseUrl] = useState('')
  const [llmDraft, setLlmDraft] = useState('')
  const [llmSaved, setLlmSaved] = useState(false)
  const [apiBase, setApiBase] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  useEffect(() => {
    window.api.settings.get().then((s) => {
      setHasKey(s.hasApiKey)
      setBaseUrl(s.relayBaseUrl)
      setHasLlmKey(s.hasLlmKey)
      setLlmBaseUrl(s.llmBaseUrl)
      setApiBase(s.apiBaseUrl)
    })
  }, [])

  return (
    <div className="overflow-auto p-10">
      <h2 className="mb-1 text-xl font-semibold">设置</h2>
      <p className="mb-6 text-sm text-muted">密钥均用 macOS Keychain 加密存储</p>

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

      <div className="mb-6 max-w-xl space-y-3 rounded-2xl border border-line bg-card p-6">
        <div className="text-sm font-medium">遇到问题？</div>
        <div className="text-[12px] text-muted">导出诊断报告（环境信息 + 最近日志，已自动去除密钥），发给管理员即可远程排查。</div>
        <button
          onClick={async () => {
            await window.api.diag.export()
          }}
          className="rounded-full border border-line px-4 py-1.5 text-[13px] hover:bg-rose-soft"
        >
          导出诊断报告到桌面
        </button>
      </div>

      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="mb-4 text-[13px] text-muted hover:text-rose"
      >
        {showAdvanced ? '▾' : '▸'} 高级设置（自备 API key 的用户可在此覆盖，默认无需配置）
      </button>

      {showAdvanced && (
      <>
      <div className="max-w-xl space-y-4 rounded-2xl border border-line bg-card p-6">
        <div className="text-sm font-medium">对话模型（Claude 中转站）</div>
        <div className="text-sm">
          地址：<span className="font-mono text-[13px]">{baseUrl}</span>　状态：
          {hasKey ? <span className="text-rose">已配置 ✓</span> : <span className="text-muted">未配置</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="粘贴 API Key…"
            className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-rose"
          />
          <button
            onClick={async () => {
              if (!draft.trim()) return
              await window.api.settings.setKey(draft)
              setDraft('')
              setHasKey(true)
              setSaved(true)
              setTimeout(() => setSaved(false), 2000)
            }}
            className="rounded-lg bg-rose px-4 py-2 text-sm text-white hover:opacity-90"
          >
            {saved ? '已保存 ✓' : '保存'}
          </button>
        </div>
      </div>

      <div className="mt-6 max-w-xl space-y-4 rounded-2xl border border-line bg-card p-6">
        <div className="text-sm font-medium">投递箱打标模型（DeepSeek）</div>
        <div className="text-[12px] text-muted">批量打标约 ¥0.003/文件。不配置则投递箱只做转换与建链，不打标。</div>
        <div className="text-sm">
          端点：<span className="font-mono text-[13px]">{llmBaseUrl}</span>　状态：
          {hasLlmKey ? <span className="text-rose">已配置 ✓</span> : <span className="text-muted">未配置</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={llmDraft}
            onChange={(e) => setLlmDraft(e.target.value)}
            placeholder="粘贴 DeepSeek API Key…"
            className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-rose"
          />
          <button
            onClick={async () => {
              if (!llmDraft.trim()) return
              await window.api.settings.setLlmKey(llmDraft)
              setLlmDraft('')
              setHasLlmKey(true)
              setLlmSaved(true)
              setTimeout(() => setLlmSaved(false), 2000)
            }}
            className="rounded-lg bg-rose px-4 py-2 text-sm text-white hover:opacity-90"
          >
            {llmSaved ? '已保存 ✓' : '保存'}
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  )
}
