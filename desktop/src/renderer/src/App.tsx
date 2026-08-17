import { useCallback, useEffect, useRef, useState } from 'react'
import { Library, Settings as SettingsIcon, Plus } from 'lucide-react'
import VaultPage from './pages/VaultPage'
import Workbench from './pages/Workbench'
import LoginGate from './pages/LoginGate'
import { UiHost, ui } from './components/ui'
import { VaultWizard } from './components/VaultWizard'
import logo from './assets/logo.png'
import { pendingNote } from './lib/bus'
import { getNickname, identityLabel, setNickname } from './lib/profile'
import { errText } from './lib/err'
import { startTaskSync, useTask } from './hooks/useTasks'
import { TaskDock } from './components/TaskDock'
import { OfflineBar } from './components/OfflineBar'

type Page = 'workbench' | 'vault' | 'settings'

const APP_VERSION = 'v0.1.0'

const NAV: [Page, string, typeof Library][] = [
  ['vault', '个人知识库', Library],
  ['settings', '设置', SettingsIcon],
]

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
  // degraded = 云端探测超时，还不知道登没登录。此时**不能**弹登录门（那等于把离线用户
  // 挡在门外，正是 bug#1 的"打不开"体感），而是照常进主界面 + 顶部挂云端离线条
  const [account, setAccount] = useState<{ loggedIn: boolean; email?: string; degraded?: boolean } | null>(null)
  const [localMode, setLocalMode] = useState(() => localStorage.getItem('localMode') === '1')
  const [vaultState, setVaultState] = useState<'loading' | 'none' | 'ready'>('loading')
  const [vaultSkipped, setVaultSkipped] = useState(() => localStorage.getItem('vaultSkipped') === '1')
  // 昵称是渲染层自己的资料（云端只给邮箱），设置页可改，问候语与侧栏身份行都用它
  const [nickname, setNick] = useState<string | undefined>(getNickname)

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
    // 云端连不上时 getSession 可能长时间挂起（Supabase 被暂停时域名直接 NXDOMAIN），
    // 8 秒还没答案就先按"降级"开界面，真答案回来了再覆盖
    const authTimer = setTimeout(() => setAccount((a) => a ?? { loggedIn: false, degraded: true }), 8000)
    window.api.auth.state().then((s) => {
      clearTimeout(authTimer)
      // 已经降级进主界面了就别再把人踢回登录门；用户可以在设置页主动去登录
      setAccount((prev) => (prev?.degraded && !s.loggedIn ? prev : s))
    })
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
      clearTimeout(authTimer)
      offShortcut()
      offStream()
    }
  }, [appendMessage])

  // AI key 下发失败以前是全程静默 catch，用户只在发第一条消息时撞到「请先配置 API Key」。
  // 主 UI（含 UiHost）挂上之后再报：启动那次 provision 早于渲染层，所以还要补查一次原因
  const mainVisible =
    account !== null &&
    (account.loggedIn || localMode || !!account.degraded) &&
    vaultState !== 'loading' &&
    !(vaultState === 'none' && !vaultSkipped)
  useEffect(() => {
    if (!mainVisible) return
    const say = (msg: string): void => ui.toast(`AI 配置获取失败：${msg}（可在设置页手填 Key）`, 'error')
    void window.api.auth.provisionError().then((msg) => msg && say(msg))
    return window.api.auth.onProvisionFailed(say)
  }, [mainVisible])

  // 全局任务状态层：全应用唯一订阅点。挂在 App 而不是各页面里，
  // 页面切换时它一直在——这就是"投递跑着切走再回来状态还在"的全部实现
  useEffect(() => startTaskSync(), [])

  const handleLogout = useCallback(async () => {
    await window.api.auth.logout()
    localStorage.removeItem('localMode')
    setLocalMode(false)
    setAccount({ loggedIn: false })
  }, [])

  /**
   * H-10：先问主进程收不收这条，再把用户消息落进对话。
   * 顺序反了的话，被拒的那次会在历史里留一条永远等不到回答的用户消息。
   * 拒绝时给一条**带「停止当前生成」动作**的提示——光说"不行"等于把用户堵死在原地（设计 §5.3）。
   */
  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      const base = activeRef.current
      const r = await window.api.chat.send(base.id, text, base.sdkSessionId)
      if (r && r.ok === false) {
        ui.toast(r.error ?? '这个对话还在生成中', 'error', {
          label: '停止当前生成',
          onClick: () => void window.api.chat.stop(base.id),
        })
        return false
      }
      upsert({
        ...base,
        messages: [...base.messages, { role: 'user', text }],
        title: base.title === '新对话' ? text.slice(0, 18) : base.title,
        updatedAt: Date.now(),
      })
      return true
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
  if (!account.loggedIn && !localMode && !account.degraded) {
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
      <aside className="flex w-sidebar shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="titlebar-drag px-5 pb-4 pt-10">
          <div className="text-xl font-semibold">mcn-ai</div>
          <div className="mt-0.5 text-xs text-muted">AI 工作操作台</div>
        </div>
        {/* 主色降级：新对话改描边样式，粉色只留给发送键/光标/选中态这类小面积点缀 */}
        <button
          onClick={() => {
            setActive(newConv())
            setPage('workbench')
          }}
          title="新对话"
          className="mx-4 mb-5 flex items-center justify-center gap-1.5 rounded-full border border-line bg-transparent py-2 text-base font-medium text-ink hover:bg-hover"
        >
          <Plus size={15} /> 新对话
        </button>

        <nav className="space-y-1 px-3">
          {NAV.map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setPage(key)}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-base ${
                page === key ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:bg-hover'
              }`}
            >
              <Icon size={16} className="shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-8 flex min-h-0 flex-1 flex-col">
          {convs.length > 0 && (
            <>
              <div className="mb-1.5 px-5 text-2xs tracking-wide text-muted-soft">最近对话</div>
              <div className="min-h-0 flex-1 overflow-auto px-3 pb-2">
                {convs.map((c) => (
                  <div key={c.id} className="group relative">
                    <button
                      onClick={() => {
                        setActive(c)
                        setPage('workbench')
                      }}
                      className={`w-full truncate rounded-md px-3 py-1.5 pr-7 text-left text-base ${
                        page === 'workbench' && active.id === c.id ? 'bg-card font-medium' : 'text-ink-soft hover:bg-hover'
                      }`}
                    >
                      {c.title}
                    </button>
                    {/* 与笔记删除同一套标准：二次确认（带标题）+ 删除后 toast。
                        以前是 hover ✕ 一点就永久没了，同类操作两套标准 */}
                    <button
                      onClick={async () => {
                        const okd = await ui.confirm({
                          title: '确认删除这个对话？',
                          message: `「${c.title}」\n\n对话记录会从本机删除，无法找回。`,
                          danger: true,
                          okText: '删除',
                        })
                        if (!okd) return
                        await window.api.chat.delete(c.id)
                        convsRef.current = convsRef.current.filter((x) => x.id !== c.id)
                        setConvs(convsRef.current)
                        if (active.id === c.id) setActive(newConv())
                        ui.toast(`已删除对话「${c.title}」`)
                      }}
                      className="absolute right-1.5 top-1 hidden rounded px-1 text-sm text-muted hover:text-accent group-hover:block"
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
        <TaskDock onOpen={setPage} />
        {/* 身份行：昵称优先，其次完整邮箱（不再截前缀露出 QQ 号），再拼版本号 */}
        <div className="truncate border-t border-line px-5 py-4 text-xs text-muted">
          {[identityLabel(nickname, account.email), APP_VERSION].filter(Boolean).join(' · ')}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <OfflineBar />
        {/* key 换页触发一次淡入，避免页面切换硬切 */}
        <div key={page} className="page-enter min-h-0 flex-1">
          {page === 'workbench' && (
            <Workbench
              conv={active}
              onSend={handleSend}
              onOpenNote={openNoteFromChat}
              nickname={nickname}
              recentConvs={convs}
              onOpenConv={(c) => {
                setActive(c)
                setPage('workbench')
              }}
            />
          )}
          {page === 'vault' && <VaultPage />}
          {page === 'settings' && (
            <SettingsPage
              account={account}
              onLogout={handleLogout}
              nickname={nickname}
              onNickname={(v) => {
                setNickname(v)
                setNick(getNickname())
              }}
            />
          )}
        </div>
      </main>
    </div>
  )
}

/**
 * 模型线路（provider）：inferera 中转站 / DeepSeek 官方 / 自定义 base URL。
 * 模型名显式可见可改——DeepSeek 官方端点对不认识的模型名是**静默降级到 flash**，
 * 不显示出来用户永远不知道自己在用哪个模型。
 */
function ProviderCard({ onChanged, tick }: { onChanged: () => void; tick: number }) {
  const [current, setCurrent] = useState<ProviderId>('inferera')
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [draft, setDraft] = useState({ baseUrl: '', model: '', fastModel: '' })

  const load = useCallback((): void => {
    void window.api.ai.providers().then((r) => {
      setCurrent(r.current)
      setProviders(r.providers)
      const active = r.providers.find((p) => p.id === r.current)
      if (active) setDraft({ baseUrl: active.baseUrl, model: active.model, fastModel: active.fastModel })
    })
  }, [])
  // tick 由设置页在「保存 key / 重新获取配置」之后 +1：否则卡片上的「未配置 key」
  // 会一直停在挂载那一刻的状态，跟上面那行「已就绪 ✓」自相矛盾
  useEffect(load, [load, tick])

  const active = providers.find((p) => p.id === current)

  const switchTo = async (id: ProviderId): Promise<void> => {
    const r = await window.api.ai.setProvider(id)
    setCurrent(id)
    setDraft({ baseUrl: r.provider.baseUrl, model: r.provider.model, fastModel: r.provider.fastModel })
    load()
    onChanged()
    ui.toast(`已切换到「${r.provider.label}」`)
  }

  const saveConfig = async (): Promise<void> => {
    const r = await window.api.ai.setProviderConfig(current, draft)
    setDraft({ baseUrl: r.provider.baseUrl, model: r.provider.model, fastModel: r.provider.fastModel })
    load()
  }

  return (
    <div className="mb-6 max-w-xl space-y-3 rounded-xl border border-line bg-card p-6" data-testid="provider-card">
      <div className="text-md font-medium">模型线路</div>
      <div className="space-y-1.5">
        {providers.map((p) => (
          <button
            key={p.id}
            data-testid={`provider-${p.id}`}
            onClick={() => void switchTo(p.id)}
            className={`flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left ${
              p.id === current ? 'border-accent bg-accent-soft' : 'border-line bg-bg hover:bg-hover'
            }`}
          >
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: p.id === current ? 'var(--color-accent)' : 'var(--color-line)' }} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-base font-medium">
                {p.label}
                {p.hasKey ? (
                  <span className="text-xs text-muted">key 已配置</span>
                ) : (
                  <span className="text-xs text-warn">未配置 key</span>
                )}
              </span>
              <span className="block text-sm leading-5 text-muted">{p.hint}</span>
            </span>
          </button>
        ))}
      </div>
      {active && (
        <div className="space-y-2 border-t border-line pt-3">
          <div className="flex items-center gap-2 text-md">
            <span className="w-20 shrink-0 text-muted">base URL</span>
            <input
              data-testid="provider-baseurl"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              onBlur={() => void saveConfig()}
              placeholder="https://…"
              className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="flex items-center gap-2 text-md">
            <span className="w-20 shrink-0 text-muted">主模型</span>
            <input
              data-testid="provider-model"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              onBlur={() => void saveConfig()}
              className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="flex items-center gap-2 text-md">
            <span className="w-20 shrink-0 text-muted">轻量模型</span>
            <input
              data-testid="provider-fastmodel"
              value={draft.fastModel}
              onChange={(e) => setDraft({ ...draft, fastModel: e.target.value })}
              onBlur={() => void saveConfig()}
              className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
            />
          </div>
          <div className="text-sm leading-5 text-muted">
            模型名会显式发给服务端，不依赖线路的自动映射（DeepSeek 官方端点遇到不认识的模型名会静默降级到
            deepseek-v4-flash）。留空则回到该线路的默认值。
          </div>
        </div>
      )}
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
    <div className="mb-6 max-w-xl space-y-3 rounded-xl border border-line bg-card p-6">
      <div className="text-md font-medium">知识入库</div>
      <label className="flex cursor-pointer items-center gap-2 text-md">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked)
            void window.api.settings.setArtifactAutoIngest(e.target.checked)
          }}
          className="accent-accent"
        />
        AI 生成的产物自动入库（送入投递箱转为可检索知识）
      </label>
      <div className="text-sm leading-5 text-muted">
        关闭时产物仅保存在 90_产物/，可在产物面板对单个文件点「入库」；开启后每个新产物自动转为知识库笔记并参与 AI 检索。
      </div>
    </div>
  )
}

/** 投递箱分流：客户可自助配置「投递箱子文件夹 → 落位目录」规则，无需碰配置文件 */
function RoutesCard() {
  const [routes, setRoutesState] = useState<Array<{ name: string; dest: string; builtin?: boolean }>>([])
  const [newName, setNewName] = useState('')
  const [newDest, setNewDest] = useState('')

  const load = (): void => {
    void window.api.routes.get().then(setRoutesState)
  }
  useEffect(load, [])

  const save = async (next: Array<{ name: string; dest: string; builtin?: boolean }>): Promise<void> => {
    const r = await window.api.routes.set(next.filter((x) => !x.builtin))
    if (r.ok) {
      setRoutesState(next)
      ui.toast('分流规则已保存，投递文件夹已就绪')
    } else {
      ui.toast(r.error ?? '保存失败', 'error')
    }
  }

  return (
    <div className="mb-6 max-w-xl space-y-3 rounded-xl border border-line bg-card p-6">
      <div className="text-md font-medium">投递箱分流</div>
      <div className="text-sm leading-5 text-muted">
        往「投递箱 / 某文件夹」丢文件，会自动转成笔记放进对应目录（不做业务打标）。适合参考书、竞品资料等外部内容。
      </div>
      <div className="space-y-1.5">
        {routes.map((r) => (
          <div key={r.name} className="flex items-center gap-2 rounded-md bg-bg px-3 py-2 text-base">
            <span className="font-medium">投递箱/{r.name}</span>
            <span className="text-muted">→</span>
            <span className="flex-1 truncate">{r.dest}/</span>
            {r.builtin ? (
              <span className="text-xs text-muted">内置</span>
            ) : (
              <button
                onClick={() => void save(routes.filter((x) => x.name !== r.name))}
                className="rounded px-1 text-sm text-muted hover:text-accent"
                title="删除规则"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="文件夹名，如：竞品"
          className="w-36 rounded-md border border-line bg-bg px-3 py-1.5 text-base outline-none focus:border-accent"
        />
        <span className="text-muted">→</span>
        <input
          value={newDest}
          onChange={(e) => setNewDest(e.target.value)}
          placeholder="落位目录，如：70_外部资料/竞品"
          className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-base outline-none focus:border-accent"
        />
        <button
          onClick={() => {
            const name = newName.trim()
            const dest = newDest.trim() || '70_外部资料/' + name
            if (!name) return ui.toast('请填写文件夹名', 'error')
            if (routes.some((x) => x.name === name)) return ui.toast('该文件夹已有规则', 'error')
            void save([...routes, { name, dest }])
            setNewName('')
            setNewDest('')
          }}
          className="rounded-full border border-line px-4 py-1.5 text-base hover:bg-hover"
        >
          添加
        </button>
      </div>
    </div>
  )
}

function SettingsPage({
  account,
  onLogout,
  nickname,
  onNickname,
}: {
  account: { loggedIn: boolean; email?: string }
  onLogout: () => void
  nickname?: string
  onNickname: (v: string) => void
}) {
  const [hasKey, setHasKey] = useState(false)
  const [manualKey, setManualKey] = useState(false)
  const [apiBase, setApiBase] = useState('')
  const [nick, setNickDraft] = useState(nickname ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [provisioning, setProvisioning] = useState(false)
  // 「已就绪」必须看**当前线路那把 key**，不能只看中转站那把——切到 DeepSeek 官方却显示
  // 中转站的状态，用户会以为配好了
  const [active, setActive] = useState<AiProvider | undefined>()
  // M-29：写 key 不再挡在这颗按钮后面（明文先进内存，落盘转后台任务），
  // 但落盘期间主进程会被 safeStorage 冻住，界面必须说清楚"在干嘛、可能要多久"
  const secretTask = useTask('secret')
  const writing = !!secretTask && (secretTask.status === 'running' || secretTask.status === 'queued')
  // 落盘可能只要几十毫秒（系统缓存热），也可能几十秒（冷）。只在"进行中"显示的话，
  // 快的那次是一闪而过、用户什么都没看清，所以成功后再留 3 秒收尾文案
  const [justSaved, setJustSaved] = useState(false)
  useEffect(() => {
    if (secretTask?.status !== 'succeeded') return
    setJustSaved(true)
    const t = setTimeout(() => setJustSaved(false), 3000)
    return () => clearTimeout(t)
  }, [secretTask?.status, secretTask?.endedAt])

  // 每次 refresh 都 +1，用来把「模型线路」卡片一起刷新（key 状态两处显示，不能各说各话）
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => {
    setTick((n) => n + 1)
    void window.api.settings.get().then((s) => {
      const cur = s.providers.find((p) => p.id === s.aiProvider)
      setActive(cur)
      setHasKey(!!cur?.hasKey)
      // 「手动填写」这个标记只对中转站那把 key 有意义（服务端也只下发它）
      setManualKey(s.manualApiKey && s.aiProvider === 'inferera')
      setApiBase(s.apiBaseUrl)
    })
  }, [])
  useEffect(refresh, [refresh])
  // 后台落盘完成后把「已就绪 ✓」刷新出来（写入期间 hasApiKey 已经是 true，这里是终态对账）
  useEffect(() => {
    if (!writing) refresh()
  }, [writing, refresh])

  return (
    <div className="h-full overflow-auto p-10">
      <h2 className="mb-1 text-xl font-semibold">设置</h2>
      <p className="mb-6 text-md text-muted">AI 服务随账号自动配置，密钥用 macOS Keychain 加密存储</p>

      <div className="mb-6 max-w-xl space-y-4 rounded-xl border border-line bg-card p-6">
        <div className="text-md font-medium">账号（云端同步：私人知识层 + 聊天记录）</div>
        {account.loggedIn ? (
          <div className="flex items-center justify-between text-md">
            <span>
              已登录：<span className="text-accent">{account.email}</span>
            </span>
            <button
              onClick={onLogout}
              className="rounded-full border border-line px-3 py-1 text-sm text-muted hover:text-accent"
            >
              退出登录
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between text-md">
            <span className="text-muted">当前为本地模式（无云端检索与同步）</span>
            <button
              onClick={onLogout}
              className="rounded-full border border-line px-3 py-1 text-sm hover:bg-hover"
            >
              去登录
            </button>
          </div>
        )}
        {/* 昵称：账号邮箱前缀常是一串数字，问候语只认这里填的称呼 */}
        <div className="flex items-center gap-2 text-md">
          <span className="shrink-0 text-muted">昵称</span>
          <input
            value={nick}
            onChange={(e) => setNickDraft(e.target.value)}
            onBlur={() => onNickname(nick)}
            placeholder="留空则首页只显示问候语"
            className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-base outline-none focus:border-accent"
          />
        </div>
        {/* AI 服务：下发失败时这里以前是死路——只有一行只读文字，没有手填入口也没有重试 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-md">
            <span>
              AI 服务{active && `（${active.label}）`}：
              {hasKey ? (
                <span className="text-accent">已就绪 ✓（{manualKey ? '手动填写' : '随账号自动配置'}）</span>
              ) : (
                <span className="text-muted">未就绪（登录后自动配置，或在下方手动填写）</span>
              )}
            </span>
            <button
              onClick={async () => {
                setProvisioning(true)
                const r = await window.api.auth.provision()
                setProvisioning(false)
                refresh()
                if (r.ok) ui.toast(r.wrote?.length ? '已重新获取服务端配置' : '服务端配置无变化，未重复写入密钥')
                else ui.toast(`获取失败：${r.error ?? '未知原因'}`, 'error')
              }}
              disabled={provisioning}
              className="shrink-0 rounded-full border border-line px-3 py-1 text-sm text-muted hover:text-accent disabled:opacity-60"
            >
              {provisioning ? '获取中…' : '重新获取服务端配置'}
            </button>
          </div>
          <div className="flex items-center gap-2 text-md">
            <span className="shrink-0 text-muted">API Key</span>
            <input
              data-testid="apikey-input"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              type="password"
              placeholder={hasKey ? '已配置（填入新值可覆盖）' : 'sk-… 服务端下发失败时手动填写'}
              className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
            />
            <button
              data-testid="apikey-save"
              onClick={async () => {
                const k = keyDraft.trim()
                if (!k) return ui.toast('请先填写 API Key', 'error')
                try {
                  const r = await window.api.settings.setKey(k)
                  setKeyDraft('')
                  refresh()
                  ui.toast(
                    r.outcome === 'unchanged'
                      ? 'Key 与当前值相同，未重复写入'
                      : 'Key 已生效，正在后台安全保存'
                  )
                } catch (e) {
                  ui.toast(`保存失败：${errText(e)}`, 'error')
                }
              }}
              className="shrink-0 rounded-full border border-line px-4 py-1.5 text-base hover:bg-hover disabled:opacity-60"
            >
              保存
            </button>
          </div>
          {/* 三态：进行中 / 刚存好 / 失败。失败那条不自动消失——它意味着重启后 key 会丢 */}
          {writing && (
            <div data-testid="key-writing" className="rounded-md bg-bg px-3 py-2 text-sm leading-5 text-muted">
              正在安全保存密钥，首次可能需要较长时间（系统会校验应用签名）。Key 已经可以使用，无需等待。
            </div>
          )}
          {!writing && justSaved && (
            <div data-testid="key-saved" className="rounded-md bg-bg px-3 py-2 text-sm leading-5 text-muted">
              密钥已安全保存 ✓（macOS Keychain 加密，重启不丢）
            </div>
          )}
          {secretTask?.status === 'failed' && (
            <div data-testid="key-write-failed" className="rounded-md bg-bg px-3 py-2 text-sm leading-5 text-danger">
              密钥没能加密落盘：{secretTask.error ?? '未知原因'}。本次仍可正常使用，但重启后需要重新填写。
            </div>
          )}
          <div className="text-sm leading-5 text-muted">
            手动填写的 Key 用 macOS Keychain 加密存储，且不会被服务端下发的配置覆盖；填的是上方所选线路的 Key。
          </div>
        </div>
        <div className="flex items-center gap-2 text-md">
          <span className="shrink-0 text-muted">服务器</span>
          <input
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            onBlur={() => window.api.settings.setApiBase(apiBase)}
            className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
          />
        </div>
      </div>

      <ProviderCard onChanged={refresh} tick={tick} />

      <IngestCard />

      <RoutesCard />

      <div className="mb-6 max-w-xl space-y-3 rounded-xl border border-line bg-card p-6">
        <div className="text-md font-medium">遇到问题？</div>
        <div className="text-sm text-muted">导出诊断报告（环境信息 + 最近日志，已自动去除密钥），发给管理员即可远程排查。</div>
        <button
          onClick={async () => {
            await window.api.diag.export()
            ui.toast('诊断报告已导出到桌面')
          }}
          className="rounded-full border border-line px-4 py-1.5 text-base hover:bg-hover"
        >
          导出诊断报告到桌面
        </button>
      </div>

    </div>
  )
}
