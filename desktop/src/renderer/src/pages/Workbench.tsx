import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, Copy, Loader2, X, Paperclip, MessageSquare, Inbox, Check, RotateCcw, AlertTriangle } from 'lucide-react'
import { FastMarkdown } from '../components/Markdown'
import { FileIcon } from '../components/FileIcon'
import { ui } from '../components/ui'
import { chipsFor } from '../config/chips'
import { greetingLine } from '../lib/profile'
import { errText } from '../lib/err'
import { enqueueMessage, pathOfDropped } from '../lib/enqueue'
import { useDragOver } from '../hooks/useDragOver'
import { useTask } from '../hooks/useTasks'
import { TierSelector } from '../components/TierSelector'
import { StepStream, useArtifactMedians } from '../components/StepStream'
import { anchorStepGroup, tierNote, useSessionSteps } from '../lib/step-stream'
import { clearDraft, readDraft, writeDraft } from '../lib/draft'

/**
 * 打开产物（M-05）。`shell.openPath` 失败（没装 Keynote/Office、产物已被删）以前是静默的，
 * 点「打开」毫无反应。除了报错还得给出口：至少能在 Finder 里看到这个文件。
 */
const openArtifact = async (relPath: string): Promise<void> => {
  const r = await window.api.artifacts.open(relPath)
  if (r?.ok) return
  ui.toast(`打不开产物：${r?.error ?? '未知错误'}`, 'error', {
    label: '在 Finder 中显示',
    onClick: () => void window.api.artifacts.reveal(relPath),
  })
}

/** 卡片区/产物面板共用的时间格式 */
const shortTime = (ms: number): string =>
  new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function Workbench({
  conv,
  onSend,
  onRetry,
  onOpenNote,
  nickname,
  recentConvs,
  onOpenConv,
  onTierChange,
}: {
  conv: Conversation
  /** 返回 false = 主进程拒了这次发送（同一会话已在生成中，H-10），输入框内容要留着 */
  onSend: (text: string, attachments?: { path: string; name: string; thumb: string }[]) => Promise<boolean>
  /** M-11：重发错误气泡前面那条 user 消息，并把错误气泡就地撤掉。
      tier 传值 = 换档重试（增强档线路失败时的出口） */
  onRetry: (index: number, tier?: TierId) => Promise<boolean>
  onOpenNote: (wikiTarget: string) => void
  nickname?: string
  recentConvs: Conversation[]
  onOpenConv: (c: Conversation) => void
  /** 档位按会话记忆，所以改档要落到 conversation 上（App 负责持久化） */
  onTierChange: (t: TierId) => void
}) {
  // 消息以 conv prop 为准（App 统一持久化）；这里只管流式草稿/工具行/输入框
  const messages = conv.messages
  /**
   * 首页快捷指令按库的业务身份筛。通用模板的库里不该出现「写种草脚本」「达人复盘」——
   * 那和 `40_带货` 目录一样，是别人家的业务（批 3 看截图时发现的）。
   */
  const [chips, setChips] = useState(() => chipsFor('general'))
  useEffect(() => {
    void window.api.settings.get().then((x) => setChips(chipsFor(x.personaId)))
  }, [])
  /**
   * F2：输入框内容**按会话持久**。以前它只活在这个 `useState` 里，
   * 切一下对话 / 点一下知识库 / Cmd+R 重载，打了一半的长提示词就没了。
   * 初值直接从 localStorage 取，切会话时由下面那个 effect 换过来。
   */
  const [input, setInputRaw] = useState(() => readDraft(conv.id))
  const setInput = useCallback(
    (v: string) => {
      setInputRaw(v)
      writeDraft(convRef.current.id, v)
    },
    []
  )
  /**
   * 本轮附件（A-3 B'）。**放在这一层而不是 InputBox 里**：发送成功要清空、被主进程拒了
   * 要原样留着，这两件事都归 send 管。thumb 是 dataURL，只在内存里活着（不落库）
   */
  const [attachments, setAttachments] = useState<{ path: string; name: string; thumb: string }[]>([])
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const convRef = useRef(conv)
  convRef.current = conv

  // 「这个会话在不在生成」的真相在主进程，不再是本组件的局部量——
  // 切走再切回来、甚至 reload，状态都还在（H-10 的"看得见在跑"）
  const task = useTask('agent', conv.id)
  const taskRunning = task?.status === 'running'
  // sending 只是"刚点了发送、任务事件还没回来"的这几十毫秒的乐观态
  const streaming = sending || taskRunning

  // 过程可见性：步骤流住在模块级 store（lib/step-stream.ts），页面切走再回来不丢。
  // 最后一个分组还 live 的话就是"这一轮正在跑的"，其余分组按顺序贴在各自的回答上面
  const { groups } = useSessionSteps(conv.id)
  const liveGroup = groups.length && groups[groups.length - 1].live ? groups[groups.length - 1] : null
  const doneGroups = liveGroup ? groups.slice(0, -1) : groups
  // 「通常约 X 秒」的样本每轮重取一次：第一次做产物时还没有历史，做完就有了
  const medians = useArtifactMedians(groups.length)

  useEffect(() => {
    // 切会话：把那个会话自己的草稿摆回来（F2）。**不能走 setInput**——
    // 那会把刚读出来的草稿又写一遍，白写一次盘
    setInputRaw(readDraft(conv.id))
    setDraft('')
    setSending(false)
  }, [conv.id])

  // 切回一个正在生成的会话：用主进程累积的 draft 补齐切走那段时间流出的字，
  // 之后继续听 agent:stream 逐字追加。只在本地为空时采纳，别把更新的本地内容盖回旧快照
  useEffect(() => {
    if (!taskRunning || !task) return
    setDraft((d) => d || task.draft)
  }, [taskRunning, task])

  useEffect(() => {
    return window.api.chat.onStream((p) => {
      if (p.sessionId !== convRef.current.id) return
      if (p.kind === 'delta' && p.text) {
        setDraft((d) => d + p.text)
      } else if (p.kind === 'assistant') {
        setDraft('')
      } else if (p.kind === 'done' || p.kind === 'error') {
        setDraft('')
        setSending(false)
      }
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, draft, groups])

  /**
   * 兜底收口：主进程说这一轮已经不在跑了，但步骤流还挂着"进行中"的分组 → 就地收掉。
   *
   * 步骤流是跟着 `agent:stream` 走的，而**这条通道是尽力而为的**——窗口刷新期间
   * `webContents.send` 会静默丢事件（任务层那条约定写得很清楚：push 尽力而为、
   * snapshot 才是权威）。丢掉的要是收尾那一下，步骤流就会永远停在展开态转着圈。
   * 这里拿任务层这个权威来源补一刀，不依赖某一条事件一定送达。
   */
  useEffect(() => {
    if (streaming || !liveGroup) return
    const lastAssistant = messages.reduce((at, m, i) => (m.role === 'assistant' ? i : at), -1)
    anchorStepGroup(conv.id, lastAssistant)
  }, [streaming, liveGroup, messages, conv.id])

  // 步骤分组 → 消息的对位：直接用 App 落消息时钉上的下标，不猜。
  // 拿不到下标的分组（停止生成时一条消息都没落下）就不显示——挂错地方比不显示更糟
  const stepFor = new Map<number, (typeof doneGroups)[number]>()
  for (const g of doneGroups) if (g.anchor !== undefined) stepFor.set(g.anchor, g)

  /**
   * 发送。**生成中也照发**——由主进程拒绝并回一条带「停止当前生成」动作的提示（设计 §5.3）。
   * 渲染层静默吞掉这次按键的话，用户敲了 Enter 什么都没发生，只会以为键盘坏了。
   */
  const send = useCallback(
    async (text: string) => {
      const t = text.trim()
      if (!t) return
      const busy = streaming
      if (!busy) {
        setSending(true)
        setDraft('')
      }
      const ok = await onSend(t, attachments)
      // 被拒：输入与附件都原样留着，用户点了 toast 上的「停止当前生成」就能接着发
      if (ok) {
        setInput('')
        clearDraft(convRef.current.id) // 发出去了，草稿的使命结束（F2）
        setAttachments([])
      } else if (!busy) setSending(false)
    },
    [streaming, onSend, attachments]
  )

  /**
   * M-11 重试。以前 AI 出错只留一条 `⚠️ …` 的气泡，用户要重试只能把刚才那段话重新打一遍
   * （长提示词尤其致命）。这里复用上一条 user 消息重发，错误气泡由 App 侧就地撤掉。
   */
  const retry = useCallback(
    async (index: number, tier?: TierId) => {
      if (streaming) return
      setSending(true)
      setDraft('')
      const ok = await onRetry(index, tier)
      if (!ok) setSending(false)
    },
    [streaming, onRetry]
  )

  const tier: TierId = conv.tier ?? 'standard'

  const handleLink = useCallback(
    async (href: string) => {
      if (href.startsWith('wiki:')) onOpenNote(decodeURIComponent(href.slice(5)))
    },
    [onOpenNote]
  )

  const empty = messages.length === 0 && !streaming

  /**
   * 库是不是空的（R-3，2026-08-19 拍板的最小版引导）。
   *
   * 空库时首页那句「问你的库，或直接说要做什么」是**假承诺**——库里一个字都没有，
   * 问什么都只会得到"没找到"。知识库页早就有空态引导了（`EmptyVaultGuide`），
   * 但新客户登录后落的是**工作台**，在那一屏之前根本走不到知识库页。
   *
   * 只做一段文案 + 指向，**不做浮层引导**（完整 onboarding 记 roadmap）。
   */
  const [vaultEmpty, setVaultEmpty] = useState(false)
  useEffect(() => {
    let alive = true
    const count = (ns: Array<{ children?: unknown[] }>): number =>
      ns.reduce((n, x) => n + (x.children ? count(x.children as Array<{ children?: unknown[] }>) : 1), 0)
    const check = async (): Promise<void> => {
      try {
        /**
         * **必须先确认"有库"**（走查现场逮到）：用户在首跑引导上点了「暂时跳过」时
         * 一个库都没有，这时候说「把资料拖进来就会自动入库」是**错的**——
         * 没有库，`inbox.enqueue` 直接抛（M-06），拖进去什么都不会发生。
         * 那一屏保持原文案，引导只给「有库但库里是空的」这一种。
         */
        const s = await window.api.settings.get()
        if (!s?.vaultPath) {
          if (alive) setVaultEmpty(false)
          return
        }
        const tree = await window.api.vault.tree()
        if (alive) setVaultEmpty(Array.isArray(tree) && count(tree) === 0)
      } catch {
        // 没开库 / 读不到：这条只是引导，读不出来就当作不用引导，别把首页搞出错误态
        if (alive) setVaultEmpty(false)
      }
    }
    void check()
    // 第一份资料入库之后这句话就该消失，所以跟着 vault 变化重算
    const off = window.api.vault.onChanged(() => void check())
    return () => {
      alive = false
      off()
    }
  }, [])

  // 拖文件进工作台页：以前没人拦，Electron 直接导航到 file:// 把整个应用替换掉。
  // 现在走和知识库页同一条链路（inbox.enqueue），拖入时给覆盖层告诉用户会发生什么
  // 与知识库页同一套进出计数判定（见 useDragOver）：老写法拖出窗口时覆盖层消不掉
  const drag = useDragOver()
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    drag.reset()
    // 取路径走 preload 的 files.pathFor（webUtils）——`File.path` 在 Electron 32 被移除，
    // 直接读它恒为 undefined，升级后所有拖放会**静默**失效（见 preload/index.ts 的注释）
    const dropped = [...(e.dataTransfer?.files ?? [])]
    const paths = dropped.map(pathOfDropped).filter((p) => !!p)
    if (!paths.length) {
      // 拿不到路径必须说话，不许静默——否则这类故障在界面上等于"什么都没发生"
      if (dropped.length) {
        ui.toast(`拖入失败：读不到这 ${dropped.length} 个文件的路径。临时办法：在访达里把文件放进知识库目录下的 00_投递箱 文件夹，会自动入库。请把这条报给我们`, 'error')
      }
      return
    }
    try {
      // 原来报的是 `paths.length`（拖进来几个**条目**），拖一个文件夹就说「1 个文件」，
      // 而里面可能是 200 个。现在报 enqueue 真正收下的数（A-1）
      const r = await window.api.inbox.enqueue(paths)
      const m = enqueueMessage(r)
      ui.toast(m.text, m.type)
    } catch (err) {
      ui.toast(`入库失败：${errText(err)}`, 'error')
    }
  }

  return (
    <div
      data-testid="workbench-root"
      className="relative flex h-full"
      {...drag.handlers}
      onDrop={(e) => void onDrop(e)}
    >
      {drag.over && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-overlay p-6">
          <div className="flex w-full max-w-md flex-col items-center rounded-xl border-2 border-dashed border-accent bg-card px-8 py-10 text-center">
            <Inbox size={28} className="mb-3 text-accent" />
            <div className="text-xl font-semibold">松手即入库</div>
            <div className="mt-2 text-base text-muted">
              文件会送进投递箱，自动转成笔记并打标建链，之后就能被 AI 检索到
            </div>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {empty ? (
          // 问候区落在视口上方 1/3（--home-top），下面依次是输入框、快捷指令、最近卡片区
          <div className="flex flex-1 flex-col items-center overflow-auto px-8 pb-10 pt-home-top">
            {/* 衬线在米白底上偏轻飘：字号提到 38px 压住（见 --text-display 注释），
                字重 500 只对拉丁昵称生效，中文衬线没有 medium 字面 */}
            <h1 className="fade-up mb-2 font-serif text-display font-medium leading-tight">
              {greetingLine(nickname)}
            </h1>
            {/* 空库时不说「问你的库」——库里什么都没有，那是句假承诺（R-3） */}
            <p className="mb-8 text-md text-muted" data-testid="home-subtitle">
              {vaultEmpty ? '把资料拖进来，或直接问我' : '问你的知识库，或直接说要做什么'}
            </p>
            <InputBox
              value={input}
              onChange={setInput}
              onSend={() => void send(input)}
              streaming={false}
              tier={tier}
              onTierChange={onTierChange}
              attachments={attachments}
              onAttach={setAttachments}
              wide
              placeholder={vaultEmpty ? '把资料拖进来，或直接问我想做什么…' : undefined}
            />
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {chips.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setInput(c.prompt)}
                  className="rounded-full border border-line bg-card px-3.5 py-1.5 text-base hover:bg-hover"
                >
                  {c.label}
                </button>
              ))}
            </div>
            {/* 指向：告诉他资料往哪放、放完会发生什么。一行字，不做浮层（R-3 拍板） */}
            {vaultEmpty && (
              <div
                data-testid="home-empty-vault-hint"
                className="mt-6 flex items-center gap-2 text-base text-muted"
              >
                <Inbox size={16} className="text-accent" />
                <span>知识库还是空的——把文件拖进这个窗口就会自动入库，也可以在左侧「知识库」里用投递箱导入</span>
              </div>
            )}
            <RecentDock convs={recentConvs} onOpenConv={onOpenConv} />
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 overflow-auto px-8 py-6">
              <div className="mx-auto max-w-3xl space-y-5">
                {messages.map((m, i) =>
                  m.role === 'user' ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[80%] rounded-xl bg-surface px-4 py-2.5 text-md">
                        {!!m.attachments?.length && (
                          <div data-testid="bubble-attachments" className="mb-2 flex flex-wrap gap-2">
                            {m.attachments.map((a, k) =>
                              a.thumb ? (
                                <img
                                  key={k}
                                  src={a.thumb}
                                  alt={a.name}
                                  title={a.name}
                                  className="h-16 w-16 rounded-lg border border-line object-cover"
                                />
                              ) : (
                                // 文档附件没有缩略图（B7）；重启后图片的 thumb 也没了（内存态）。
                                // 两种都走这条：图标 + 文件名，比空着或只有一行字强
                                <span
                                  key={k}
                                  className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-sm text-muted"
                                >
                                  <FileIcon name={a.name} size={13} />
                                  {a.name}
                                </span>
                              )
                            )}
                          </div>
                        )}
                        {m.text}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="group flex gap-3">
                      {/* 出错那条的圆点走红：语义色留给"持续存在的状态"，一条错误回答
                          会一直留在历史里，值得占着颜色（瞬时 toast 才是炭黑+图标） */}
                      <span
                        className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${m.error ? 'bg-danger' : 'bg-accent'}`}
                      />
                      <div className="min-w-0 flex-1">
                        {/* 这一条回答是怎么来的：折叠成一行摘要贴在正文上面，点开看明细 */}
                        {stepFor.has(i) && (
                          <StepStream sessionId={conv.id} group={stepFor.get(i)!} medians={medians} />
                        )}
                        {/* 错误气泡：左侧红边 + 淡红底。翻历史时一眼能认出"这轮没成"，
                            而不是靠正文开头那个 ⚠️ 字符 */}
                        <div
                          data-testid={m.error ? 'error-bubble' : undefined}
                          className={m.error ? 'rounded-r-md border-l-2 border-danger bg-danger-soft py-1.5 pl-3 pr-2' : undefined}
                        >
                          <FastMarkdown body={m.text} onLink={handleLink} />
                        </div>
                        {/* Q8：本轮没读过的引用挂一个角标——**只提示不删**（模型可能是从 MOC
                            的列表里看到的标题）。金琥珀 = 「做完了但有折损」那一档，不是错误 */}
                        {!!m.unverified?.length && (
                          <div
                            data-testid="unverified-badge"
                            data-count={m.unverified.length}
                            title={`本轮并未读取：${m.unverified.join('、')}`}
                            className="mt-1 inline-flex items-center gap-1 rounded-full border border-gold-line bg-gold-soft px-2 py-0.5 text-xs text-gold-ink"
                          >
                            <AlertTriangle size={11} className="shrink-0" />
                            {m.unverified.length} 处引用存疑，请自行核对
                          </div>
                        )}
                        <div className="mt-1 flex items-center gap-2">
                          {/* 错误气泡里的「重试」常驻（不是 hover 才出）：这是用户此刻唯一想点的东西。
                              前面没有可复用的提问时不给按钮——按了什么都不会发生的按钮比没有更糟 */}
                          {m.error && messages.slice(0, i).some((x) => x.role === 'user') && (
                            <>
                              <button
                                data-testid="retry-answer"
                                disabled={streaming}
                                onClick={() => void retry(i)}
                                className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs text-accent hover:bg-accent-soft disabled:opacity-50"
                              >
                                <RotateCcw size={11} /> 重试
                              </button>
                              {/* 增强档线路失败时的第二个出口：原地降档重试。
                                  只给"重试"的话，用户会在同一条挂掉的线路上反复撞 */}
                              {tier === 'enhanced' && (
                                <button
                                  data-testid="retry-standard"
                                  disabled={streaming}
                                  onClick={() => void retry(i, 'standard')}
                                  className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:text-ink disabled:opacity-50"
                                >
                                  切换到标准模式重试
                                </button>
                              )}
                            </>
                          )}
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(m.text)
                              ui.toast('已复制')
                            }}
                            className="hidden items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:text-accent group-hover:inline-flex"
                          >
                            <Copy size={11} /> 复制
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                )}
                {(draft || liveGroup) && (
                  <div className="flex gap-3">
                    <span className="mt-2 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-accent" />
                    <div className="min-w-0 flex-1">
                      {liveGroup && <StepStream sessionId={conv.id} group={liveGroup} medians={medians} />}
                      {/* streaming-body：给正文最后一行末尾接一个呼吸光标，边写边有"还在写"的实感 */}
                      {draft && (
                        <div className="streaming-body">
                          <FastMarkdown body={draft} onLink={handleLink} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {streaming && !draft && !liveGroup && (
                  <div className="thinking-dots pl-6 pt-1"><span /><span /><span /></div>
                )}
              </div>
            </div>
            <div className="border-t border-line px-8 py-4">
              <div className="mx-auto max-w-3xl">
                <TurnStatusLine startedAt={task?.startedAt} steps={liveGroup?.steps.length ?? 0} tier={tier} live={streaming} />
                <InputBox
                  value={input}
                  onChange={setInput}
                  onSend={() => void send(input)}
                  onStop={() => window.api.chat.stop(convRef.current.id)}
                  streaming={streaming}
                  tier={tier}
                  onTierChange={onTierChange}
                  attachments={attachments}
                  onAttach={setAttachments}
                />
              </div>
            </div>
          </>
        )}
      </div>
      {/* 首页已经有「最近产物」卡片区，这里默认收起，避免同屏两份一样的内容 */}
      <ArtifactPanel homeEmpty={empty} onOpenNote={onOpenNote} />
    </div>
  )
}

/**
 * 轮内状态行（F17 半）：`用时 12s · 3 步 · 标准档`。
 *
 * 为什么值得占一行：这一轮**已经跑了多久、做了几步、实际按哪一档在跑**，
 * 以前一个都看不到——步骤流折叠之后连步数都没了，用户唯一能判断"是不是卡住了"的
 * 依据是那三个跳动的点。而"档位"更要紧：增强档的钱是按轮花的（PRODUCT-AUDIT 2.3）。
 *
 * **零新 IPC**：耗时来自任务层的 `startedAt`，步数来自步骤流，档位来自会话对象。
 * 每秒 tick 只重渲染这一个组件——步骤流那边刻意不 tick，是因为它一动就是整棵树。
 */
function TurnStatusLine({
  startedAt,
  steps,
  tier,
  live,
}: {
  startedAt?: number
  steps: number
  tier: TierId
  live: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live, startedAt])

  if (!live) return null
  // 拿不到起点（任务事件还没回来的头几十毫秒）就先不报时间，别显示一个 0s 或者负数
  const secs = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : null
  const parts = [secs === null ? '' : `用时 ${secs}s`, steps > 0 ? `${steps} 步` : '', tierNote(tier)].filter(Boolean)
  return (
    <div data-testid="turn-status" data-tier={tier} className="mb-2 text-sm text-muted">
      {parts.join(' · ')}
    </div>
  )
}

/** 首页输入框下方的「最近产物 / 最近对话」卡片区：复用现有数据，各最多 6 个，都没有就整块不出现 */
function RecentDock({ convs, onOpenConv }: { convs: Conversation[]; onOpenConv: (c: Conversation) => void }) {
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])

  useEffect(() => {
    window.api.artifacts.list().then((list) => setArtifacts(list.slice(0, 6)))
    return window.api.artifacts.onCreated(() => {
      window.api.artifacts.list().then((list) => setArtifacts(list.slice(0, 6)))
    })
  }, [])

  const recent = convs.slice(0, 6)
  if (artifacts.length === 0 && recent.length === 0) return null
  // 只有一栏数据时铺满，别在右边留一块空白
  const cols = artifacts.length > 0 && recent.length > 0 ? 'sm:grid-cols-2' : 'grid-cols-1'

  return (
    <div className={`fade-up mt-12 grid w-full max-w-2xl gap-6 ${cols}`}>
      {artifacts.length > 0 && (
        <section>
          <div className="mb-2 text-2xs tracking-wide text-muted-soft">最近产物</div>
          <div className="space-y-1.5">
            {artifacts.map((a) => (
              <button
                key={a.path}
                onClick={() => void openArtifact(a.path)}
                title={a.name}
                className="flex w-full items-center gap-2.5 rounded-md border border-line bg-card px-3 py-2 text-left hover:bg-hover"
              >
                <FileIcon name={a.name} />
                <span className="min-w-0 flex-1 truncate text-base">{a.name}</span>
                <span className="shrink-0 text-xs text-muted">{shortTime(a.mtimeMs)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <div className="mb-2 text-2xs tracking-wide text-muted-soft">最近对话</div>
          <div className="space-y-1.5">
            {recent.map((c) => (
              <button
                key={c.id}
                onClick={() => onOpenConv(c)}
                title={c.title}
                className="flex w-full items-center gap-2.5 rounded-md border border-line bg-card px-3 py-2 text-left hover:bg-hover"
              >
                <MessageSquare size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-base">{c.title}</span>
                <span className="shrink-0 text-xs text-muted">{shortTime(c.updatedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function InputBox({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  tier,
  onTierChange,
  attachments,
  onAttach,
  wide,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop?: () => void
  streaming: boolean
  tier: TierId
  onTierChange: (t: TierId) => void
  attachments: { path: string; name: string; thumb: string }[]
  onAttach: (a: { path: string; name: string; thumb: string }[]) => void
  wide?: boolean
  /** 空库时换一句不假承诺的（R-3）；不给就是默认那句 */
  placeholder?: string
}) {
  // 高度跟随实际内容（含自动折行）：rows 按 \n 计数会漏掉软换行，长句折行时上一行被顶出视野
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 128) + 'px'
  }, [value])
  return (
    <div
      className={`rounded-input border border-line bg-card transition-colors focus-within:border-accent ${
        wide ? 'w-full max-w-2xl' : ''
      }`}
    >
      {!!attachments.length && (
        <div data-testid="attach-strip" className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <div key={a.path} className="group relative">
              {/* B7：文档没有缩略图，用类型图标 + 文件名占位（不是所有附件都是图片了） */}
              {a.thumb ? (
                <img
                  src={a.thumb}
                  alt={a.name}
                  title={a.name}
                  className="h-14 w-14 rounded-lg border border-line object-cover"
                />
              ) : (
                <div
                  title={`${a.name}（仅本次对话参考，不入库）`}
                  className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-lg border border-line bg-surface px-1"
                >
                  <FileIcon name={a.name} size={18} />
                  <span className="w-full truncate text-center text-[10px] leading-tight text-muted">{a.name}</span>
                </div>
              )}
              <button
                data-testid="attach-remove"
                onClick={() => onAttach(attachments.filter((x) => x.path !== a.path))}
                title="移除"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-card text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* 主行：附件位 + 正文 + 发送/停止。**档位控件不在这一行**，见下方控制条 */}
      <div className="flex min-h-input items-end gap-2 px-3 py-2.5">
        {/* 附件入口：选图片随这条消息发给 AI（make-ppt/make-docx 可以把它编排进产物）。
            选择框在主进程弹（渲染进程零 FS 能力），缩略图也由主进程用 nativeImage 生成 */}
        <button
          data-testid="attach-btn"
          onClick={async () => {
            const picked = await window.api.chat.pickAttachments()
            if (!picked.length) return
            /**
             * B7：超过 20MB 的文档不走"临时参考"这条路——转换慢，上下文也塞不下。
             * **就地告诉用户正确的那条路**（拖进窗口入库），别只说"不行"。
             */
            const big = picked.filter((x) => x.tooBig)
            if (big.length) {
              ui.toast(
                `${big.map((x) => `《${x.name}》`).join('、')} 超过 20MB，没有作为本轮参考带上。` +
                  `要长期保存并随时查询，请把它拖进窗口自动入库`,
                'warn'
              )
            }
            const picked2 = picked.filter((x) => !x.tooBig)
            if (!picked2.length) return
            // 按路径去重，重复挑同一张不该堆两遍
            const merged = [...attachments]
            for (const p of picked2) if (!merged.some((x) => x.path === p.path)) merged.push(p)
            onAttach(merged.slice(0, 8))
          }}
          title="添加图片或文档（仅本次对话参考，不入库；要长期保存请拖进窗口）"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink"
        >
          <Paperclip size={16} />
        </button>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSend()
            }
          }}
          rows={1}
          placeholder={placeholder ?? '问你的知识库，或说"把XX做成PPT"…'}
          className="max-h-32 flex-1 resize-none self-center overflow-y-auto bg-transparent py-1 text-md leading-6 outline-none"
        />
        {streaming ? (
          <button
            onClick={onStop}
            title="停止生成"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent text-accent hover:bg-accent-soft"
          >
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={onSend}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-solid hover:opacity-90"
            title="发送"
          >
            <ArrowUp size={16} />
          </button>
        )}
      </div>
      {/* 下沿控制条：档位靠右（发送键那一侧），菜单向上弹。
          这一条是留给"这一轮怎么跑"的元信息的，以后加别的开关也往这儿放 */}
      <div data-testid="composer-bar" className="flex items-center justify-end px-3 pb-2">
        <TierSelector value={tier} onChange={onTierChange} disabled={streaming} />
      </div>
    </div>
  )
}

/**
 * 入库按钮三态（未入库 / 入库中 / 已入库 ✓）。
 * 「入库中」来自全局任务层，所以切页面再回来仍然是转圈的；
 * 「已入库」来自落盘表，重开应用也还在——这两条正是过去缺的反馈。
 */
function IngestButton({
  artifact,
  ingested,
  onDone,
  onOpenNote,
}: {
  artifact: ArtifactInfo
  ingested?: { at: number; noteRel?: string }
  onDone: () => void
  onOpenNote: (t: string) => void
}) {
  const task = useTask('ingest', artifact.path)
  const busy = task?.status === 'queued' || task?.status === 'running'
  const prev = useRef<TaskStatus | undefined>(undefined)
  useEffect(() => {
    const was = prev.current
    prev.current = task?.status
    // **不要求"亲眼看到那一次跃迁"**：旧写法要 `was` 有值才认，于是任何"挂载时任务已经是终态"
    // 的情况（切页面回来、事件在窗口刷新期间被丢掉、组件因列表刷新重挂）都不会去拉一次
    // 已入库表——界面就永远停在「入库中」，而磁盘上其实早就入库好了（走查里抓到过一次）。
    // refresh 是幂等的，条件放宽到"现在是 succeeded 且上次不是"即可
    if (task?.status === 'succeeded' && was !== 'succeeded') onDone()
  }, [task?.status, onDone])

  if (busy) {
    return (
      <span
        data-testid="ingest-busy"
        className="flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-muted"
      >
        <Loader2 size={11} className="animate-spin" /> 入库中
      </span>
    )
  }
  if (ingested) {
    return (
      <button
        data-testid="ingest-done"
        title={ingested.noteRel ? `已入库 · 打开「${ingested.noteRel}」` : '已入库'}
        onClick={() => {
          if (!ingested.noteRel) return ui.toast('已入库（未找到对应笔记）')
          onOpenNote(ingested.noteRel.replace(/\.md$/, '').split('/').pop() ?? ingested.noteRel)
        }}
        className="flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-ok hover:bg-hover"
      >
        <Check size={11} /> 已入库
      </button>
    )
  }
  return (
    <button
      onClick={async () => {
        const r = await window.api.artifacts.ingest(artifact.path)
        if (r.ok) ui.toast('已送入投递箱，处理完成后可被 AI 检索')
        else ui.toast(r.error ?? '入库失败', 'error')
      }}
      className="rounded-full border border-line px-2.5 py-0.5 hover:bg-hover"
    >
      入库
    </button>
  )
}

function ArtifactPanel({ homeEmpty, onOpenNote }: { homeEmpty: boolean; onOpenNote: (t: string) => void }) {
  const [items, setItems] = useState<ArtifactInfo[]>([])
  // 「已入库」是持久化的（复合键 路径+内容哈希，主进程校验后给结论），重开应用照样认得
  const [ingested, setIngested] = useState<Record<string, { at: number; noteRel?: string }>>({})
  const refreshIngested = useCallback(() => {
    void window.api.artifacts.ingested().then(setIngested)
  }, [])
  const [fresh, setFresh] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null)
  const prefersOpen = (): boolean => localStorage.getItem('chat.artifacts') !== '0'
  const [open, setOpen] = useState(() => !homeEmpty && prefersOpen())

  // 首页（空态）默认收起，进了对话恢复用户上次的偏好；对话中新产物落地时下面会自动展开
  useEffect(() => {
    setOpen(homeEmpty ? false : prefersOpen())
  }, [homeEmpty])

  const setVisible = (v: boolean): void => {
    localStorage.setItem('chat.artifacts', v ? '1' : '0')
    setOpen(v)
  }

  const refresh = useCallback(() => {
    window.api.artifacts.list().then(setItems)
  }, [])

  useEffect(() => {
    refresh()
    refreshIngested()
    return window.api.artifacts.onCreated((a) => {
      setFresh(a.path)
      refresh()
      setVisible(true) // 新产物生成时自动弹出
    })
  }, [refresh, refreshIngested]) // eslint-disable-line react-hooks/exhaustive-deps

  if (items.length === 0) return null

  if (!open) {
    return (
      <button
        onClick={() => setVisible(true)}
        title="打开产物面板"
        className="absolute right-4 top-3 z-10 rounded-full border border-line bg-card px-3 py-1 text-sm text-muted hover:text-accent"
      >
        产物 {items.length}
      </button>
    )
  }

  return (
    <div data-testid="artifact-panel" className="slide-in-right flex w-artifact-panel shrink-0 flex-col border-l border-line">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="text-md font-medium">
          {/* U3 #5：标题里不摆内部目录名。「90_产物/」是我们的落位约定，
              对用户只是一串看不懂的前缀；真要知道它在哪儿的人点「在 Finder 中显示」 */}
          产物
        </div>
        <button onClick={() => setVisible(false)} title="关闭产物面板" className="rounded p-1 text-muted hover:text-accent">
          <X size={14} />
        </button>
      </div>
      {/* 无框列表：一行一个产物（图标 + 文件名 + 时间），靠行距和 hover 浅底分隔，
          和首页「最近产物」是同一种轻量观感——卡片的边框+阴影在窄侧栏里太重 */}
      <div className="flex-1 space-y-0.5 overflow-auto p-2">
        {items.map((a) => (
          <div
            key={a.path}
            className={`group rounded-md px-2 py-1.5 transition-colors ${
              fresh === a.path ? 'bg-accent-soft' : 'hover:bg-hover'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <FileIcon name={a.name} size={16} />
              <span className="min-w-0 flex-1 truncate text-base" title={a.name}>
                {a.name}
              </span>
              <span
                className="shrink-0 text-xs text-muted"
                title={
                  a.size > 1048576
                    ? `${(a.size / 1048576).toFixed(1)}MB`
                    : `${Math.max(1, Math.round(a.size / 1024))}KB`
                }
              >
                {shortTime(a.mtimeMs)}
              </span>
            </div>
            {/* 操作按钮只在 hover 时露出，静态时列表保持干净 */}
            <div className="ml-6 mt-1.5 hidden gap-2 text-sm group-hover:flex">
              <button
                onClick={() => void openArtifact(a.path)}
                className="rounded-full border border-line px-2.5 py-0.5 hover:bg-hover"
              >
                打开
              </button>
              <IngestButton
                artifact={a}
                ingested={ingested[a.path]}
                onDone={refreshIngested}
                onOpenNote={onOpenNote}
              />
              {a.name.endsWith('.md') && (
                <button
                  onClick={async () => setPreview({ path: a.path, text: await window.api.artifacts.readText(a.path) })}
                  className="rounded-full border border-line px-2.5 py-0.5 hover:bg-hover"
                >
                  预览
                </button>
              )}
            </div>
            {preview?.path === a.path && (
              <div className="ml-6 mt-2 max-h-60 overflow-auto rounded-md bg-surface p-2 text-sm">
                <FastMarkdown body={preview.text} onLink={() => void 0} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
