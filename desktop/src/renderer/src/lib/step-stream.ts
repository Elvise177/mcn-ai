/**
 * 过程可见性 · 步骤流的会话内存态。
 *
 * 为什么是模块级 store 而不是 Workbench 的 useState：切到知识库页时 Workbench 会整个卸载，
 * 局部 state 跟着没——回来时正在跑的那一轮就只剩一根光标，等于"看得见在跑"又断了一次
 * （H-08/H-10 已经为正文补过同样的洞）。
 *
 * **不落库、不进主进程任务对象**：步骤流是"这一次运行的过程"，重启后没有意义；
 * 落盘只会制造重启后永远停在"正在检索"的幽灵步骤（同任务层的「进行中永不落盘」）。
 */
import { useSyncExternalStore } from 'react'

export type StepStatus = 'running' | 'done' | 'failed'

export interface StepItem {
  id: string
  /** 原始工具名（去前缀）。只用于查 config/steps.ts 的映射表，**不进 DOM** */
  tool: string
  args: Record<string, string>
  status: StepStatus
  /** 结果数；undefined = 主进程也数不出来 */
  count?: number
  /** `count` 的单位：份（笔记）/ 处（行内命中）。摘要只把「份」算进资料数 */
  unit?: 'file' | 'match'
  /** 相近结果（非精确命中）：条数照实报，但文案要标出来 */
  approx?: boolean
  /** 验证性扫描（前一次检索 0 命中） */
  verify?: boolean
  /** 与本轮前面某个失败步骤同工具同参数 = 重试 */
  retry?: boolean
  /** 被扫描次数护栏拦下（不是失败） */
  capped?: boolean
  startedAt: number
  endedAt?: number
}

export interface StepGroup {
  id: string
  steps: StepItem[]
  startedAt: number
  /** 折叠（或收尾）那一刻冻结的耗时。不做每秒 tick——一秒一次全量重渲染不值当 */
  elapsedMs?: number
  collapsed: boolean
  /** 用户手点过：之后不再自动折叠/展开，听人的 */
  pinned: boolean
  /** 这一轮还在跑 */
  live: boolean
  /**
   * 这一轮的过程挂在**哪一条消息**上（对话里的下标），由 App 在落消息那一刻告诉我们。
   *
   * 早先想的是"最后 K 个分组对位最后 K 条回答"，看着能用，但只要中间插进一条
   * **没有过程的** assistant 消息（预检失败的 ⚠️ 气泡就是：一步工具都没调过），
   * 后面就整体错一位——上一轮的检索词会贴到报错气泡上面去。位置这种事不能猜。
   */
  anchor?: number
}

export interface SessionSteps {
  groups: StepGroup[]
}

/** 空值必须是**同一个对象**：useSyncExternalStore 的 getSnapshot 每次返回新对象会死循环 */
const EMPTY: SessionSteps = { groups: [] }

const sessions = new Map<string, SessionSteps>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function mutate(sessionId: string, fn: (s: SessionSteps) => SessionSteps | null): void {
  const next = fn(sessions.get(sessionId) ?? EMPTY)
  if (!next) return
  sessions.set(sessionId, next)
  emit()
}

/** 取（或新建）本轮的 live 分组，返回的 group 与 steps 都是可安全改写的副本 */
function liveGroup(groups: StepGroup[], seed: string): StepGroup {
  const last = groups[groups.length - 1]
  if (last?.live) {
    const g = { ...last, steps: [...last.steps] }
    groups[groups.length - 1] = g
    return g
  }
  const g: StepGroup = {
    id: seed,
    steps: [],
    startedAt: Date.now(),
    collapsed: false,
    pinned: false,
    live: true,
  }
  groups.push(g)
  return g
}

const SCAN_TOOLS = new Set(['Grep', 'Glob'])
const sig = (s: { tool: string; args: Record<string, string> }): string =>
  `${s.tool}|${JSON.stringify(s.args ?? {})}`

/**
 * 验证性扫描的判据：**最近一次**检索的结果数是 0，而这一步是文件系统扫描。
 * 对应系统提示词第 4 条——"断言库里没有之前，先用 Grep/Glob 扫一遍"。
 * 只看最近一次：中途有一次检索命中了，后面的扫描就不再是"确认没有"了。
 */
function isVerification(prev: StepItem[], tool: string): boolean {
  if (!SCAN_TOOLS.has(tool)) return false
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].tool !== 'search_knowledge') continue
    return prev[i].count === 0
  }
  return false
}

function applyStep(sessionId: string, ev: ToolStepEvent): void {
  mutate(sessionId, (s) => {
    const groups = [...s.groups]
    const g = liveGroup(groups, ev.id)
    const i = g.steps.findIndex((x) => x.id === ev.id)

    if (ev.phase === 'start') {
      if (i >= 0) return null
      g.steps.push({ id: ev.id, tool: ev.tool, args: {}, status: 'running', startedAt: Date.now() })
      // **又开始干活了就再摊开**：模型经常"说两句 → 再调一次工具 → 再说"，
      // 第一句话就把步骤流折死的话，后面所有的活儿都藏在一行摘要后面——
      // 那正是这一单要解决的问题本身。用户手点过（pinned）就听用户的。
      if (g.collapsed && !g.pinned) g.collapsed = false
    } else if (ev.phase === 'args') {
      const base: StepItem =
        i >= 0 ? g.steps[i] : { id: ev.id, tool: ev.tool, args: {}, status: 'running', startedAt: Date.now() }
      const prev = i >= 0 ? g.steps.slice(0, i) : g.steps
      const next: StepItem = { ...base, tool: ev.tool, args: ev.args ?? {} }
      next.verify = isVerification(prev, ev.tool)
      next.retry = prev.some((x) => x.status === 'failed' && sig(x) === sig(next))
      if (i >= 0) g.steps[i] = next
      else g.steps.push(next)
    } else {
      // 没头没尾的 result（步骤已经被清掉了）直接丢，别凭空造一条没有参数的步骤
      if (i < 0) return null
      g.steps[i] = {
        ...g.steps[i],
        status: ev.failed ? 'failed' : 'done',
        capped: ev.capped,
        count: ev.count,
        unit: ev.unit,
        approx: ev.approx,
        endedAt: Date.now(),
      }
    }
    return { groups }
  })
}

/** 回答开始往外吐了 → 折叠成一行摘要，并把"检索用时"冻在这一刻 */
function collapseLive(sessionId: string): void {
  mutate(sessionId, (s) => {
    const last = s.groups[s.groups.length - 1]
    if (!last?.live || !last.steps.length || last.collapsed || last.pinned) return null
    const groups = [...s.groups]
    groups[groups.length - 1] = { ...last, collapsed: true, elapsedMs: Date.now() - last.startedAt }
    return { groups }
  })
}

/**
 * 这一轮结束：停掉转圈、收口耗时，并把过程**钉到那一条消息**上。
 *
 * `anchor` 由 App 在 assistant / error 消息落进对话的那一刻传进来（它知道下标）。
 * 只有 `done` 那条兜底路径拿不到 anchor（比如停止生成时半个字都没吐），
 * 那样的分组不挂到任何消息上——界面上什么都不显示，好过挂错地方。
 */
function finishLive(sessionId: string, anchor?: number): void {
  mutate(sessionId, (s) => {
    const last = s.groups[s.groups.length - 1]
    if (!last?.live) return null
    const groups = [...s.groups]
    groups[groups.length - 1] = {
      ...last,
      live: false,
      anchor,
      collapsed: last.pinned ? last.collapsed : true,
      elapsedMs: last.elapsedMs ?? Date.now() - last.startedAt,
      // 收尾时还在转圈的步骤：工具其实已经不会再回话了，留着转圈是假象
      steps: last.steps.map((x) => (x.status === 'running' ? { ...x, status: 'done' as const, endedAt: Date.now() } : x)),
    }
    return { groups }
  })
}

/**
 * App 在把 assistant / error 消息落进对话之后调用：把刚跑完那一轮的过程钉到 `messageIndex`。
 * 没有正在跑的分组时是空操作（这一轮压根没调过工具，比如预检就失败了）。
 */
export function anchorStepGroup(sessionId: string, messageIndex: number): void {
  finishLive(sessionId, messageIndex)
}

/** 点摘要展开 / 点头部收起。手点过就 pin 住，后面不再自动折叠 */
export function toggleStepGroup(sessionId: string, groupId: string): void {
  mutate(sessionId, (s) => {
    const i = s.groups.findIndex((g) => g.id === groupId)
    if (i < 0) return null
    const groups = [...s.groups]
    groups[i] = { ...groups[i], collapsed: !groups[i].collapsed, pinned: true }
    return { groups }
  })
}

/**
 * 重试会把失败那一轮的消息从历史里删掉（App 的 handleRetry），
 * 被删掉的那几条消息上挂着的步骤分组也得跟着走——留着就是**挂在不存在的下标上**。
 * `keepBelow` = 截断后消息的条数（下标 >= 它的都没了）。
 */
export function trimStepGroups(sessionId: string, keepBelow: number): void {
  mutate(sessionId, (s) => {
    const groups = s.groups.filter((g) => g.anchor === undefined || g.anchor < keepBelow)
    return groups.length === s.groups.length ? null : { groups }
  })
}

export function clearStepGroups(sessionId: string): void {
  if (!sessions.has(sessionId)) return
  sessions.delete(sessionId)
  emit()
}

/**
 * 全应用唯一订阅点（挂在 App，和 startTaskSync 一个位置）。
 * 复用现有的 `agent:stream` 流式通道，没有新增 IPC。
 */
export function startStepStream(): () => void {
  return window.api.chat.onStream((p) => {
    if (p.kind === 'tool' && p.step) applyStep(p.sessionId, p.step)
    else if (p.kind === 'delta') collapseLive(p.sessionId)
    // assistant / error 由 App 走 anchorStepGroup 收尾（它知道消息落在第几条）；
    // 这里只兜"一条消息都没落下"的那种收场（停止生成时半个字都没吐出来）
    else if (p.kind === 'done') finishLive(p.sessionId)
  })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useSessionSteps(sessionId: string): SessionSteps {
  return useSyncExternalStore(
    subscribe,
    () => sessions.get(sessionId) ?? EMPTY
  )
}

// ---- 摘要口径 ----

/**
 * 「检索了 N 份资料」里的 N：**这一轮真正被摆到眼前的资料份数**。
 *
 * 口径（走查按同一套算法独立重算一遍对账）：
 *  - 只算**份**（`unit==='file'`）：Grep 的 content 模式吐的是一篇里的几十行命中，
 *    把那个数加进来，"检索了 42 份资料"就成了瞎报——实际只翻了一篇
 *  - **失败的步骤不算**：那一步什么都没摆到眼前
 *  - **同一篇只算一次**：模型撞墙时会把同一篇读三遍
 *  - 生成产物、写文件这类动作不是"资料"，不计
 *
 * 仍然做不到的：检索与扫描之间、以及几次检索之间的**重复命中去不掉**——
 * 工具只回条数，回不了路径。所以这个数是"命中条目数"，不是"不重复的笔记数"。
 */
export function resourceCount(steps: StepItem[]): number {
  let n = 0
  /** 同一篇被读了三遍（模型撞墙重试时很常见）只能算一份 */
  const readOnce = new Set<string>()
  for (const s of steps) {
    // 失败的、以及被护栏拦下的那一步，什么都没摆到眼前，不能算进"检索了 N 份资料"
    if (s.status === 'failed' || s.capped) continue
    if (s.tool === 'Read') {
      const k = s.args.file ?? s.id
      if (readOnce.has(k)) continue
      readOnce.add(k)
      n += 1
    } else if (s.tool === 'search_knowledge' || s.tool === 'Grep' || s.tool === 'Glob') {
      if (s.unit === 'file') n += s.count ?? 0
    }
  }
  return n
}

export function summaryText(steps: StepItem[], elapsedMs?: number): string {
  const n = resourceCount(steps)
  const secs = elapsedMs ? `${(elapsedMs / 1000).toFixed(1)}s` : '—'
  return n > 0 ? `检索了 ${n} 份资料 · 用时 ${secs}` : `核对完成，未找到相关资料 · 用时 ${secs}`
}
