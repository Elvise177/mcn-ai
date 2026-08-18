import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Library, Settings as SettingsIcon, Plus, ChevronRight, AlertTriangle } from 'lucide-react'
import VaultPage from './pages/VaultPage'
import Workbench from './pages/Workbench'
import UsagePage from './pages/UsagePage'
import LoginGate from './pages/LoginGate'
import { ui } from './components/ui'
import { VaultWizard } from './components/VaultWizard'
import logo from './assets/logo.png'
import { pendingNote } from './lib/bus'
import { getNickname, identityLabel, setNickname } from './lib/profile'
import { errText, zhError } from './lib/err'
import { startTaskSync, useTask } from './hooks/useTasks'
import { TaskDock } from './components/TaskDock'
import { OfflineBar } from './components/OfflineBar'

type Page = 'workbench' | 'vault' | 'settings' | 'usage'

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
  // 档位按会话记忆，新会话一律回到标准档——上一个会话开了增强就一直增强下去，
  // 是最容易把钱烧掉又没人察觉的形态
  tier: 'standard',
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
  // 管理员区解锁态：**只存内存**，重启即复位。放在 App 而不是设置页里，
  // 是为了让"去用量页看一眼再回来"不至于把刚解开的锁又锁上
  const [adminUnlocked, setAdminUnlocked] = useState(false)
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
    if (activeRef.current.id === c.id) {
      // **同步更新 ref**，不能只等 setActive：`activeRef.current = active` 是在渲染里赋值的，
      // React 提交之前 ref 还是旧对象。主进程的预检错误是同步发回来的（bail 在 handle 返回前
      // 就 emit 了），那一下 appendMessage 拿到的就是没有这条提问的旧快照，
      // 结果用户刚发出去的问题被错误消息整条盖掉（走查抓到：历史里只剩一条 ⚠️）
      activeRef.current = c
      setActive(c)
    }
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
        // B-6：引用了这一轮没看过的笔记就在气泡下面挂一行——**只提示不删**，
        // 模型有可能是从 MOC 的列表里看到的标题，误删会把对的也删掉
        const note = p.unverifiedCitations?.length
          ? `\n\n> ⚠️ 以下来源本轮并未真正读取，请自行核对：${p.unverifiedCitations.map((c) => `[[${c}]]`).join('、')}`
          : ''
        appendMessage(p.sessionId, { role: 'assistant', text: p.text + note }, p.sdkSessionId)
      } else if (p.kind === 'error') {
        // error:true → 气泡里挂「重试」（M-11）。以前出错只留一段 ⚠️ 文字，
        // 用户要重试只能把刚才那段话重新打一遍。
        // 文案过 zhError：上游的英文原文（如 403 balance insufficient）直接抛给客户
        // 会把排查方向带偏（B-5/T-02）
        appendMessage(p.sessionId, { role: 'assistant', text: `⚠️ ${zhError(String(p.text ?? ''))}`, error: true })
      }
    })
    return () => {
      clearTimeout(authTimer)
      offShortcut()
      offStream()
    }
  }, [appendMessage])

  // AI key 下发失败以前是全程静默 catch，用户只在发第一条消息时撞到「请先配置 API Key」。
  // 主 UI 挂上之后再报：启动那次 provision 早于渲染层，所以还要补查一次原因（UiHost 在 main.tsx 根部）
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
      const r = await window.api.chat.send(base.id, text, base.sdkSessionId, base.tier ?? 'standard')
      if (r && r.ok === false) {
        ui.toast(r.error ?? '这个对话还在生成中', 'error', {
          label: '停止当前生成',
          onClick: () => void window.api.chat.stop(base.id),
        })
        return false
      }
      // 等 send 回话的这段时间里可能已经落进来别的消息（预检失败时错误甚至先于回执到达），
      // 所以按"发送前的快照 + 我这条提问 + 等待期间到的"拼，而不是拿旧快照整条覆盖
      const cur = convsRef.current.find((x) => x.id === base.id) ?? base
      const arrived = cur.messages.slice(base.messages.length)
      upsert({
        ...cur,
        messages: [...base.messages, { role: 'user', text }, ...arrived],
        title: base.title === '新对话' ? text.slice(0, 18) : cur.title,
        updatedAt: Date.now(),
      })
      return true
    },
    [upsert]
  )

  /** 改档位：落到会话对象上（随对话一起持久化），下一次发送才生效 */
  const handleTierChange = useCallback(
    (tier: TierId) => {
      const base = activeRef.current
      if ((base.tier ?? 'standard') === tier) return
      upsert({ ...base, tier, updatedAt: Date.now() })
    },
    [upsert]
  )

  /**
   * M-11 重试：复用错误气泡前面那条 user 消息重发，成功受理后把错误气泡从历史里去掉
   * （用户那条提问原样留着，等新回答落进来）。顺序同 handleSend——先问主进程收不收。
   * `tier` 传值 = 换档重试（增强档线路挂了时的出口），换档同时也改掉会话的记忆值。
   */
  const handleRetry = useCallback(
    async (index: number, tier?: TierId): Promise<boolean> => {
      const base = activeRef.current
      // 撤的是**这一轮失败留下的全部内容**，不只是 ⚠️ 那一条：SDK 出错时往往先吐一条
      // 原始错误正文（英文 result）再抛异常，只删 ⚠️ 的话每重试一次就多堆一条（走查截图抓到）。
      // 回到"最后一条提问"那里重发，语义正好是「复用上一条 user 消息」
      const lastUserIdx = base.messages.slice(0, index).map((m) => m.role).lastIndexOf('user')
      if (lastUserIdx < 0) return false
      const lastUser = base.messages[lastUserIdx]
      const nextTier = tier ?? base.tier ?? 'standard'
      // **先撤气泡再发**：send 的 await 还没返回，新的 error/assistant 事件就可能已经落进来了，
      // 那时再拿发送前的快照 upsert，等于把刚到的新回答一起抹掉
      upsert({
        ...base,
        tier: nextTier,
        messages: base.messages.slice(0, lastUserIdx + 1),
        updatedAt: Date.now(),
      })
      const r = await window.api.chat.send(base.id, lastUser.text, base.sdkSessionId, nextTier)
      if (r && r.ok === false) {
        // 被拒就把错误气泡放回去，别让用户以为重试已经发出去了
        upsert({ ...base, updatedAt: Date.now() })
        ui.toast(r.error ?? '这个对话还在生成中', 'error', {
          label: '停止当前生成',
          onClick: () => void window.api.chat.stop(base.id),
        })
        return false
      }
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
              onRetry={handleRetry}
              onOpenNote={openNoteFromChat}
              nickname={nickname}
              recentConvs={convs}
              onOpenConv={(c) => {
                setActive(c)
                setPage('workbench')
              }}
              onTierChange={handleTierChange}
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
              onOpenUsage={() => setPage('usage')}
              adminUnlocked={adminUnlocked}
              onUnlockAdmin={() => setAdminUnlocked(true)}
            />
          )}
          {page === 'usage' && <UsagePage onBack={() => setPage('settings')} />}
        </div>
      </main>
    </div>
  )
}

/**
 * 设置页四组卡片共用的外壳。样式沿用现有 design token，不新造。
 */
function Card({ title, testId, children }: { title: string; testId?: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="mb-6 max-w-xl space-y-3 rounded-xl border border-line bg-card p-6">
      <div className="text-md font-medium">{title}</div>
      {children}
    </div>
  )
}

/**
 * 模型服务（普通模式）。
 *
 * 这里**只说一句话**：好，或者不好。线路地址、模型串、各线路的 key 全部下沉到管理员区——
 * 老板需要知道的是"能不能用"，让他在一堆 base URL 里判断服务健康度只会产生误操作。
 */
function ModelServiceCard({ ready, onRefresh }: { ready: boolean; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Card title="模型服务" testId="settings-group-model">
      {ready ? (
        <div data-testid="ai-ready" className="text-md">
          AI 服务：<span className="text-accent">已就绪 ✓</span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span data-testid="ai-broken" className="flex items-center gap-1.5 text-md">
            <AlertTriangle size={14} className="shrink-0 text-warn" />
            AI 服务：<span className="text-warn">服务异常</span>
          </span>
          <button
            data-testid="ai-reconnect"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const r = await window.api.auth.provision()
              setBusy(false)
              onRefresh()
              if (r.ok) ui.toast('AI 服务已恢复')
              else ui.toast(`重新连接失败：${r.error ?? '未知原因'}`, 'error')
            }}
            className="shrink-0 rounded-full border border-line px-3 py-1 text-sm hover:bg-hover disabled:opacity-60"
          >
            {busy ? '连接中…' : '重新连接'}
          </button>
        </div>
      )}
      <div className="text-sm leading-5 text-muted">
        {ready
          ? '对话与产物生成随时可用。发消息时可在输入框左侧切换「标准 / 增强」两种模式。'
          : '暂时无法对话。点「重新连接」重新获取配置；仍不行请联系管理员。'}
      </div>
    </Card>
  )
}

/** 用量入口卡片：一行摘要 + 进详情页。气泡里不显示任何用量数字（那是干扰） */
function UsageCard({ onOpen }: { onOpen: () => void }) {
  const [s, setS] = useState<UsageSummary | null>(null)
  useEffect(() => {
    void window.api.usage.summary().then(setS)
  }, [])
  return (
    <Card title="用量" testId="settings-group-usage">
      <button
        data-testid="open-usage"
        onClick={onOpen}
        className="flex w-full items-center justify-between rounded-md bg-bg px-3 py-2.5 text-left hover:bg-hover"
      >
        <span data-testid="usage-brief" className="text-md">
          本月对话 {s?.chatCount ?? 0} 次 · 产物 {s?.artifactCount ?? 0} 个
        </span>
        <ChevronRight size={15} className="shrink-0 text-muted" />
      </button>
      <div className="text-sm leading-5 text-muted">
        用量记录只保存在本机，用来估算消耗；两种模式的差距可在详情页对比。
      </div>
    </Card>
  )
}

/** 知识入库：AI 产物是否自动送入投递箱转为可检索知识 */
function IngestSection() {
  const [auto, setAuto] = useState(false)
  useEffect(() => {
    window.api.settings.get().then((s) => setAuto(s.artifactAutoIngest))
  }, [])
  return (
    <div className="space-y-2">
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

/**
 * 敏感资料的处置（A-8 三态）。
 *
 * 界面收成三档，**存储是两个独立布尔**（`sensitiveAllowAi` / `sensitiveAllowCloud`）——
 * 收成枚举的话，以后想加「允许打标但不上云」要改数据结构。
 *
 * 文案原则（2026-08-17 拍板）：说清真实边界。默认档不是"少了个功能"，
 * 而是"敏感文件不离开你的电脑，AI 回答时仍可引用"——用户要能据此判断自己要不要改。
 */
const SENSITIVE_MODES = [
  {
    key: 'local',
    label: '仅本地规则打标（默认）',
    desc: '敏感文件不离开你的电脑：不发给模型、不上传云端。仍会自动打标签、生成摘要，AI 回答时照常可以引用它们。',
  },
  {
    key: 'ai',
    label: '允许 AI 打标',
    desc: '内容会发送给模型用于生成标签与摘要，但仍不上传云端。标签质量更好，代价是这些内容离开了本机。',
  },
  {
    key: 'all',
    label: '与普通文件相同',
    desc: '发给模型，并同步到云端知识库（多设备可用）。人事、财务、达人信息这类文件请谨慎选择。',
  },
] as const

function SensitiveSection() {
  const [mode, setMode] = useState<'local' | 'ai' | 'all'>('local')
  useEffect(() => {
    void window.api.settings.get().then((s) => {
      setMode(s.sensitiveAllowCloud ? 'all' : s.sensitiveAllowAi ? 'ai' : 'local')
    })
  }, [])
  const pick = (k: 'local' | 'ai' | 'all'): void => {
    setMode(k)
    void window.api.settings.setSensitiveMode(k === 'ai', k === 'all')
  }
  return (
    <div className="space-y-2 border-t border-line pt-4" data-testid="settings-sensitive">
      <div className="text-md font-medium">敏感资料（人事档案、财务表、达人信息表等）</div>
      <div className="space-y-2">
        {SENSITIVE_MODES.map((m) => (
          <label key={m.key} className="flex cursor-pointer gap-2 text-md">
            <input
              type="radio"
              name="sensitive-mode"
              data-testid={`sensitive-mode-${m.key}`}
              checked={mode === m.key}
              onChange={() => pick(m.key)}
              className="mt-1 accent-accent"
            />
            <span>
              <span>{m.label}</span>
              <span className="block text-sm leading-5 text-muted">{m.desc}</span>
            </span>
          </label>
        ))}
      </div>
      {/* 改档不追溯已入库的笔记（PLAN §5f-3）：追溯要跑批量重打标、重新上云，
          还要处理「已在云端的敏感篇要不要删」——那是另一个大单 */}
      <div className="text-sm text-muted">仅影响之后入库的文件，已入库的笔记不受影响。</div>
    </div>
  )
}

/** 投递箱分流：客户可自助配置「投递箱子文件夹 → 落位目录」规则，无需碰配置文件 */
function RoutesSection() {
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
    <div className="space-y-3 border-t border-line pt-4">
      <div className="text-md">投递箱分流</div>
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

/**
 * 管理员区里的单个档位映射。
 *
 * 定位是**运维应急**：换模型串、临时把某一档切到备用线路（如 inferera）。
 * 界面上的两档语义不变——改的是"这一档走哪条线"，不是"这一档是什么档"。
 */
function TierConfigRow({ tier, onChanged }: { tier: AiTier; onChanged: () => void }) {
  const [draft, setDraft] = useState({ baseUrl: tier.baseUrl, model: tier.model, fastModel: tier.fastModel })
  const [keyDraft, setKeyDraft] = useState('')
  const [health, setHealth] = useState<TierHealth | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setDraft({ baseUrl: tier.baseUrl, model: tier.model, fastModel: tier.fastModel })
  }, [tier.baseUrl, tier.model, tier.fastModel])

  const saveConfig = async (): Promise<void> => {
    const r = await window.api.ai.setTierConfig(tier.id, draft)
    setDraft({ baseUrl: r.tier.baseUrl, model: r.tier.model, fastModel: r.tier.fastModel })
    onChanged()
  }

  const field = (label: string, key: 'baseUrl' | 'model' | 'fastModel'): ReactNode => (
    <div className="flex items-center gap-2 text-md">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <input
        data-testid={`tier-${key.toLowerCase()}-${tier.id}`}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onBlur={() => void saveConfig()}
        placeholder={key === 'baseUrl' ? 'https://…' : ''}
        className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
      />
    </div>
  )

  return (
    <div data-testid={`tier-config-${tier.id}`} className="space-y-2 rounded-lg bg-bg p-4">
      <div className="flex items-center gap-2">
        <span className="text-base font-medium">{tier.label}</span>
        {tier.usingSharedKey ? (
          // 回落态要说清楚：这一档用的是中转站那把共享 key，不是它自己的
          <span className="text-xs text-muted" data-testid={`tier-shared-key-${tier.id}`}>
            复用中转站密钥
          </span>
        ) : tier.hasKey ? (
          <span className="text-xs text-muted">key 已配置</span>
        ) : (
          <span className="text-xs text-warn">未配置 key</span>
        )}
        {tier.overridden && <span className="text-xs text-muted">已被运维改过</span>}
      </div>
      {field('base URL', 'baseUrl')}
      {field('主模型', 'model')}
      {field('轻量模型', 'fastModel')}
      <div className="flex items-center gap-2 text-md">
        <span className="w-20 shrink-0 text-muted">API Key</span>
        <input
          data-testid={`tier-key-input-${tier.id}`}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          type="password"
          placeholder={tier.hasKey ? '已配置（填入新值可覆盖）' : 'sk-…'}
          className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
        />
        <button
          data-testid={`tier-key-save-${tier.id}`}
          onClick={async () => {
            const k = keyDraft.trim()
            if (!k) return ui.toast('请先填写 API Key', 'error')
            try {
              const r = await window.api.settings.setKey(k, tier.id)
              setKeyDraft('')
              onChanged()
              ui.toast(
                r.outcome === 'unchanged' ? 'Key 与当前值相同，未重复写入' : 'Key 已生效，正在后台安全保存'
              )
            } catch (e) {
              ui.toast(`保存失败：${errText(e)}`, 'error')
            }
          }}
          className="shrink-0 rounded-full border border-line px-4 py-1.5 text-base hover:bg-hover"
        >
          保存
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          data-testid={`tier-check-${tier.id}`}
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            // force=true：管理员刚改完配置，这里必须绕过那 5 分钟缓存
            const h = await window.api.ai.tierHealth(tier.id, true)
            setHealth(h)
            setChecking(false)
          }}
          className="rounded-full border border-line px-3 py-1 text-sm text-muted hover:text-accent disabled:opacity-60"
        >
          {checking ? '检测中…' : '检测线路'}
        </button>
        {health && (
          <span data-testid={`tier-health-${tier.id}`} className={`text-sm ${health.ok ? 'text-ok' : 'text-warn'}`}>
            {health.ok ? '线路可用 ✓' : `不可用：${health.reason ?? '未知原因'}`}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * 计价配置（管理员区专用）：各档每百万 token 的**美元**单价 + 美元→人民币汇率。
 *
 * 放这里而不是用量页上：老板要看的是"这个月花了多少钱"，不是"输入 0.28 美元每百万"。
 * 线路加价、官方调价、汇率变动都在这儿改，不用发版；`scripts/usage-report.mjs`
 * 读的是同一份落盘配置，不会出现"页面一个价、脚本另一个价"。
 */
/**
 * 用量页要不要给客户看金额（2026-08-18 起默认关闭）。
 *
 * 现在算出来的是**成本价**——摆给客户看等于把进货价摊开，而商业化定价还没定。
 * 计价能力本身完整保留：jsonl 照常记、`usage-report.mjs` 照常出成本表（给我们自己看）。
 * 将来按谈定的客户价出账时，再考虑对客户开放（见 HANDOFF roadmap 的商业化备忘）。
 */
function ShowCostToggle() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    void window.api.settings.get().then((s) => setOn(!!s.showCost))
  }, [])
  return (
    <label className="flex cursor-pointer items-start gap-2 border-b border-line pb-2 text-md">
      <input
        type="checkbox"
        data-testid="show-cost-toggle"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked)
          void window.api.settings.setShowCost(e.target.checked)
        }}
        className="mt-1 accent-accent"
      />
      <span>
        在用量页显示金额
        <span className="block text-sm leading-5 text-muted">
          默认关闭。现在显示的是**成本价**，不是客户报价——按量计费定下来之前不要开给客户看。
          关闭只影响用量页，用量记录与开发者脚本照常记完整成本。
        </span>
      </span>
    </label>
  )
}

function PricingRow({ tiers }: { tiers: AiTier[] }) {
  const [p, setP] = useState<UsagePricing | null>(null)
  useEffect(() => {
    void window.api.usage.pricing().then(setP)
  }, [])

  const save = async (next: UsagePricing): Promise<void> => {
    setP(next)
    setP(await window.api.usage.setPricing(next))
  }
  const numField = (
    testId: string,
    value: number,
    onSave: (v: number) => void,
    width = 'w-24'
  ): ReactNode => {
    /**
     * 缓存读倍率是分数（官方线路 = 1/30 = 0.0333…），原样铺进输入框会被框宽截成
     * 「0.0333:」这种看着像坏了的字符串。所以显示端截到 5 位小数。
     * 但**截过的值不能回写**——运维只是路过点了一下别的地方，倍率就被悄悄改掉了。
     * 所以失焦时先跟原值比，差在显示精度以内就当没动过。
     */
    const shown = Number(value.toFixed(5))
    return (
      <input
        data-testid={testId}
        defaultValue={shown}
        key={`${testId}:${value}`}
        onBlur={(e) => {
          const v = Number(e.target.value)
          if (!Number.isFinite(v) || v < 0) return
          if (Math.abs(v - value) < 1e-5) return
          onSave(v)
        }}
        className={`${width} rounded-md border border-line bg-bg px-2 py-1 text-right font-mono text-sm outline-none focus:border-accent`}
      />
    )
  }

  if (!p) return null
  const ROUTE_ZH: Record<string, string> = {
    deepseek: 'DeepSeek 官方',
    aihubmix: 'aihubmix 中转站',
    custom: '自定义线路',
  }
  return (
    <div data-testid="pricing-config" className="space-y-3 rounded-lg bg-bg p-4">
      <div className="text-base font-medium">计价（估算用）</div>
      <div className="text-sm leading-5 text-muted">
        每百万 token 的单价，按线路配——同一个模型走不同线路价格可能差好几倍
        （实测 deepseek-v4-pro：官方 ¥4.5，中转站 $1.69 ≈ ¥12.2）。
        「缓存读」是缓存命中部分的价格倍率。
        <span className="block">
          注意币种跟着线路走：DeepSeek 官方按人民币计费，填人民币、不过汇率；中转站按美元计费。
        </span>
      </div>
      {Object.entries(p.routes ?? {}).map(([route, r]) => {
        const cny = r.currency === 'CNY'
        const sym = cny ? '¥' : '$'
        return (
        <div key={route} className="space-y-1 border-t border-line pt-2" data-testid={`pricing-route-${route}`}>
          <div className="text-sm font-medium">
            {ROUTE_ZH[route] ?? route}
            <span data-testid={`price-currency-${route}`} className="ml-2 font-normal text-muted">
              {cny ? '人民币计价' : '美元计价，按汇率折算'}
            </span>
          </div>
          {/*
            标签和输入框必须**成组换行**：三组挤不下时，光靠 flex-wrap 会把「缓存读 ×」
            留在上一行末尾、输入框掉到下一行，看着像两个不相干的控件。
            （加宽缓存读那格装下 0.03333 之后就撞上了这个，截图里一眼看出来的）
          */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-md">
            <span className="w-16 shrink-0 text-sm text-muted">默认价</span>
            <span className="flex items-center gap-2">
              <span className="text-sm text-muted">输入 {sym}</span>
              {numField(`price-in-${route}`, r.default.in, (v) =>
                void save({ ...p, routes: { ...p.routes, [route]: { ...r, default: { ...r.default, in: v } } } })
              )}
            </span>
            <span className="flex items-center gap-2">
              <span className="text-sm text-muted">输出 {sym}</span>
              {numField(`price-out-${route}`, r.default.out, (v) =>
                void save({ ...p, routes: { ...p.routes, [route]: { ...r, default: { ...r.default, out: v } } } })
              )}
            </span>
            <span className="flex items-center gap-2">
              <span className="text-sm text-muted">缓存读 ×</span>
              {/* w-16 装不下 0.03333（官方线路是 1/30），截图里显示成「0.0333:」像是坏了 */}
              {numField(`price-cacheread-${route}`, r.cacheRead, (v) =>
                void save({ ...p, routes: { ...p.routes, [route]: { ...r, cacheRead: v } } }),
                'w-20'
              )}
            </span>
          </div>
        </div>
        )
      })}
      <div className="flex items-center gap-2 border-t border-line pt-2 text-md">
        <span className="w-16 shrink-0 text-sm text-muted">汇率</span>
        <span className="text-sm text-muted">1 USD =</span>
        {numField('price-usdcny', p.usdCny, (v) => void save({ ...p, usdCny: v }), 'w-20')}
        <span className="text-sm text-muted">CNY　（只作用于美元计价的线路）</span>
      </div>
      {p.legacyTierUsd && (
        <div data-testid="pricing-legacy" className="border-t border-line pt-2 text-sm text-muted">
          升级前按档位配的单价已留档（不参与计算）：
          {Object.entries(p.legacyTierUsd).map(([k, v]) => ` ${k} $${v.in}/$${v.out}`).join('　')}
        </div>
      )}
    </div>
  )
}

/**
 * 管理员区（版本号连点 7 次解锁，解锁态存内存、重启复位）。
 *
 * 这里全是**运维配置**：地址、模型串、密钥、服务器。放出来给普通用户看，
 * 唯一的结果是有人把它改坏了再来问为什么用不了。
 */
function AdminZone({ tiers, onChanged }: { tiers: AiTier[]; onChanged: () => void }) {
  const [apiBase, setApiBase] = useState('')
  const [provisioning, setProvisioning] = useState(false)
  // M-29：写 key 不挡路（明文先进内存，落盘转后台任务），但落盘期间主进程会被
  // safeStorage 冻住，界面必须说清楚"在干嘛、可能要多久"
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

  useEffect(() => {
    void window.api.settings.get().then((s) => setApiBase(s.apiBaseUrl))
  }, [])

  return (
    <div
      data-testid="admin-zone"
      className="mb-6 max-w-xl space-y-4 rounded-xl border border-warn-line bg-card p-6"
    >
      <div className="flex items-center gap-1.5">
        <AlertTriangle size={14} className="shrink-0 text-warn" />
        <span className="text-md font-medium text-warn">运维配置，请勿改动</span>
      </div>
      <div className="text-sm leading-5 text-muted">
        档位的两档语义是固定的，这里只决定每一档走哪条线路、用哪个模型串。改错会让对话直接不可用。
      </div>

      <div className="space-y-3">
        {tiers.map((t) => (
          <TierConfigRow key={t.id} tier={t} onChanged={onChanged} />
        ))}
        <PricingRow tiers={tiers} />
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

      <div className="flex items-center justify-between gap-3 border-t border-line pt-4 text-md">
        <span className="text-muted">从服务端重新拉取密钥与线路配置</span>
        <button
          onClick={async () => {
            setProvisioning(true)
            const r = await window.api.auth.provision()
            setProvisioning(false)
            onChanged()
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
        <span className="shrink-0 text-muted">服务器</span>
        <input
          data-testid="admin-apibase"
          value={apiBase}
          onChange={(e) => setApiBase(e.target.value)}
          onBlur={() => window.api.settings.setApiBase(apiBase)}
          className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
        />
      </div>
    </div>
  )
}

function SettingsPage({
  account,
  onLogout,
  nickname,
  onNickname,
  onOpenUsage,
  adminUnlocked,
  onUnlockAdmin,
}: {
  account: { loggedIn: boolean; email?: string }
  onLogout: () => void
  nickname?: string
  onNickname: (v: string) => void
  onOpenUsage: () => void
  adminUnlocked: boolean
  onUnlockAdmin: () => void
}) {
  const [nick, setNickDraft] = useState(nickname ?? '')
  const [aiReady, setAiReady] = useState(true)
  const [tiers, setTiers] = useState<AiTier[]>([])
  const [taps, setTaps] = useState(0)

  const refresh = useCallback(() => {
    void window.api.settings.get().then((s) => {
      setAiReady(s.aiReady)
      setTiers(s.tiers)
    })
  }, [])
  useEffect(refresh, [refresh])
  // 后台落盘完成后把状态刷新出来（写入期间内存里已经有 key，这里是终态对账）
  const secretTask = useTask('secret')
  useEffect(() => {
    if (secretTask?.status === 'succeeded' || secretTask?.status === 'failed') refresh()
  }, [secretTask?.status, refresh])

  const TAPS_TO_UNLOCK = 7

  return (
    <div className="h-full overflow-auto p-10">
      <h2 className="mb-1 text-xl font-semibold">设置</h2>
      <p className="mb-6 text-md text-muted">AI 服务随账号自动配置，密钥用 macOS Keychain 加密存储</p>

      {/* 1. 账号 */}
      <Card title="账号（云端同步：私人知识层 + 聊天记录）" testId="settings-group-account">
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
            <button onClick={onLogout} className="rounded-full border border-line px-3 py-1 text-sm hover:bg-hover">
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
      </Card>

      {/* 2. 模型服务 */}
      <ModelServiceCard ready={aiReady} onRefresh={refresh} />

      {/* 3. 知识库 */}
      <Card title="知识库" testId="settings-group-vault">
        <IngestSection />
        <SensitiveSection />
        <RoutesSection />
      </Card>

      {/* 4. 用量 */}
      <UsageCard onOpen={onOpenUsage} />

      {adminUnlocked && <AdminZone tiers={tiers} onChanged={refresh} />}

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

      {/* 管理员区入口：版本号连点 7 次。既不占版面，也不会被误触 */}
      <div
        data-testid="version-badge"
        onClick={() => {
          if (adminUnlocked) return
          const n = taps + 1
          setTaps(n)
          if (n >= TAPS_TO_UNLOCK) {
            onUnlockAdmin()
            ui.toast('已进入运维配置模式（重启应用后自动退出）')
          }
        }}
        className="max-w-xl cursor-default select-none pb-6 text-xs text-muted-soft"
      >
        mcn-ai {APP_VERSION}
        {adminUnlocked && ' · 运维配置已解锁'}
      </div>
    </div>
  )
}
