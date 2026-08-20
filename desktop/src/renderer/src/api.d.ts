/** 会话级模型档位：界面上只有这两个语义，供应商与模型名一律不出现在普通模式 */
type TierId = 'standard' | 'enhanced'

interface AiTier {
  id: TierId
  /** 「标准（推荐）」/「增强」 */
  label: string
  /** 悬停 tooltip：只讲能力与消耗差异 */
  blurb: string
  /** 以下三项只在管理员区可见可改（运维应急口） */
  baseUrl: string
  model: string
  fastModel: string
  keyField: string
  hasKey: boolean
  /** 用的是回落来的共享 key（增强档没配独立 key 时复用中转站那把） */
  usingSharedKey: boolean
  /** 出厂映射被运维改过 */
  overridden: boolean
}

interface TierHealth {
  tier: TierId
  ok: boolean
  reason?: string
  checkedAt: number
  /** true = 吃的 5 分钟缓存，没有发出真实探测请求 */
  cached: boolean
}

interface DesktopSettings {
  vaultPath: string | null
  relayBaseUrl: string
  hasApiKey: boolean
  /** true = 用户在设置页手填的 key（服务端下发不会覆盖它） */
  manualApiKey: boolean
  llmBaseUrl: string
  hasLlmKey: boolean
  tiers: AiTier[]
  /** 普通模式那行「AI 服务：已就绪 ✓」：默认档（标准）那把 key 在不在 */
  aiReady: boolean
  /** 默认档的 key 正在后台加密落盘（M-29 等待态） */
  keyWritePending: boolean
  apiBaseUrl: string
  dingtalkWebhook: string
  dingtalkSecret: string
  dingtalkNotifyInbox: boolean
  dingtalkNotifyArtifact: boolean
  artifactAutoIngest: boolean
  showCost: boolean
  sensitiveAllowAi: boolean
  sensitiveAllowCloud: boolean
  /** 第一版检索口径（'local' | 'cloud'，出厂 local）；见 store.ts 的 searchBackend */
  searchBackend?: 'local' | 'cloud'
}

type TaskKind = 'inbox' | 'agent' | 'ingest' | 'sync' | 'secret'
type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
/** 登录失败的种类（M-01）：不同种类对应不同文案，别把网络不通说成密码错 */
type LoginKind = 'credential' | 'network' | 'timeout' | 'canceled' | 'config'

interface TaskBase {
  id: string
  kind: TaskKind
  key: string
  status: TaskStatus
  /** 主进程生成的一句话，渲染层直接显示、不再拼文案 */
  title: string
  startedAt: number
  endedAt?: number
  progress?: { done: number; total: number; label: string }
  error?: string
  cancelable: boolean
  seq: number
}
interface InboxTask extends TaskBase {
  kind: 'inbox'
  files: string[]
  stages: InboxEvent[]
  /** pipeline 子进程组 id（取消要用；走查靠它做进程组残留断言） */
  pid?: number
  /** 谁停的：user=面板上点了「停止本轮」，quit=退出应用时清理 */
  canceled?: 'user' | 'quit'
}
interface AgentTask extends TaskBase {
  kind: 'agent'
  conversationId: string
  draft: string
  toolLine?: string
  sdkSessionId?: string
}
interface IngestTask extends TaskBase {
  kind: 'ingest'
  artifactPath: string
  noteRel?: string
}
interface SyncTask extends TaskBase {
  kind: 'sync'
  scope: 'conversation' | 'note'
  tries: number
  nextRetryAt?: number
}
/** 密钥加密落盘（M-29）：safeStorage 首调会冻主进程，所以它是一条任务而不是一次同步调用 */
interface SecretTask extends TaskBase {
  kind: 'secret'
  field: string
}
type Task = InboxTask | AgentTask | IngestTask | SyncTask | SecretTask

interface CloudState {
  reachable: boolean | null
  loggedIn: boolean
  email?: string
  lastError?: string
  checkedAt: number
  pendingSync: number
}

type TaskEventPayload =
  | { type: 'snapshot'; tasks: Task[]; cloud: CloudState }
  | { type: 'upsert'; task: Task }
  | { type: 'remove'; id: string }
  | { type: 'cloud'; cloud: CloudState }

interface InboxEvent {
  type: 'file-added' | 'run-start' | 'stage' | 'run-end'
  stage?: string
  status?: string
  message?: string
  pending?: number
  file?: string
  ok?: boolean
}

interface VaultOpenResult {
  path: string
  noteCount: number
}

interface VaultTreeNode {
  name: string
  path: string
  children?: VaultTreeNode[]
}

interface NoteContent {
  frontmatter: Record<string, unknown>
  body: string
  title: string
}

interface GraphData {
  nodes: { id: string; name: string; group: string; val: number }[]
  links: { source: string; target: string }[]
}

/**
 * 本轮附件（A-3 图片能力 B'）。**thumb 不落库**：`chat.save` 前会剥掉它
 * （与步骤流同一条原则——内存态的东西不进持久层）。重启后气泡里只剩文件名，
 * 这是刻意的；「翻历史把当时的附件再拿出来」另立项。
 */
interface ChatAttachment {
  name: string
  /** 小尺寸 dataURL，只在内存里活着 */
  thumb?: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** 这条 assistant 消息是错误提示（M-11）：气泡里要挂「重试」，复用上一条 user 消息重发 */
  error?: boolean
  attachments?: ChatAttachment[]
}

interface Conversation {
  id: string
  title: string
  sdkSessionId?: string
  messages: ChatMessage[]
  updatedAt: number
  /** 这个会话选的档位（按会话记忆，新会话默认标准） */
  tier?: TierId
}

/** 一次拖入/入箱的结果（A-1）。跳过的几类分开计数，界面才说得清「为什么一个都没进来」 */
interface EnqueueResult {
  /** 真正拷进投递箱的文件数 */
  added: number
  /** 扩展名不支持（.md/.txt/.docx/.pdf/.xlsx/.pptx 之外） */
  skippedUnsupported: number
  /** 隐藏文件/目录、Office 锁文件、空文件、垃圾目录 */
  skippedJunk: number
  /** 因为超过递归深度上限而没有进去的目录数 */
  depthExceeded: number
  /** 撞上单次文件数上限被截断 */
  truncated: boolean
}

/** 单价 + 汇率（运维配置，只在管理员区可见可改） */
interface UsagePricing {
  /** 按**线路**分表：同一模型走不同线路价格可能差好几倍（B-2） */
  routes: Record<
    string,
    {
      models: Record<string, { in: number; out: number; cacheRead?: number }>
      default: { in: number; out: number }
      /** 缓存读的价格倍率（相对 in）。官方 1/30，中转站按模型不同（opus 0.1、deepseek 全价） */
      cacheRead: number
      cacheWrite: number
      /** 单价的币种，缺省 USD。DeepSeek 官方原生人民币计费，配 CNY 后不过汇率 */
      currency?: 'USD' | 'CNY'
    }
  >
  /** 美元 → 人民币，**只作用于 currency 为 USD 的线路** */
  usdCny: number
  /** 升级前按档位配的单价，留档不参与计算 */
  legacyTierUsd?: Record<string, { in: number; out: number }>
}

/** 用量汇总（口径说明：tokens 含输入与输出，不同线路统计口径可能有差异；费用为估算值） */
interface UsageSummary {
  month: string
  chatCount: number
  artifactCount: number
  /** 本月估算花费（人民币） */
  costCny: number
  totalCount: number
  empty: boolean
  /** 最近 14 天，按天次数 + 按档位分段（同柱堆叠用；老记录无 tier → 计入 standard） */
  daily: Array<{ date: string; count: number; standard: number; enhanced: number }>
  byTier: Array<{
    tier: TierId
    label: string
    count: number
    input: number
    /** 缓存读 token：按线路的折扣率单独计价，不是全价输入（B-2） */
    cacheRead: number
    output: number
    total: number
    costCny: number
  }>
  byType: Array<{ type: string; label: string; count: number; tokens: number; costCny: number; medianMs: number }>
}

/**
 * 过程可见性：一条工具步骤在流式事件里的形态。同一步骤会来三次
 * （start 出现 → args 补入参 → result 回填结果数），靠 `id` 串起来。
 */
interface ToolStepEvent {
  id: string
  /** 原始工具名（已去 `mcp__xxx__` 前缀）。**只用于查映射表，不进 DOM、不给用户看** */
  tool: string
  phase: 'start' | 'args' | 'result'
  /** phase='args'：精简后的入参（检索词 / 文件名 / 扫描目标 / 产物类型） */
  args?: Record<string, string>
  /** phase='result'：结果条数；数不出来就不给（不编数字） */
  count?: number
  /** phase='result'：`count` 的单位——份（笔记）还是处（一篇里的行内命中） */
  unit?: 'file' | 'match'
  /** phase='result'：这些是**相近结果**不是精确命中（云端语义检索没有相关度闸门，见 HANDOFF §3-13） */
  approx?: boolean
  /** phase='result'：这一步的工具自己报错了 */
  failed?: boolean
  /** phase='result'：被扫描次数护栏拦下的，**不是失败**（是我们自己踩的刹车） */
  capped?: boolean
}

interface AgentStreamPayload {
  sessionId: string
  /** `notice` = 说一句就完的中性提示（不是错误、也不终结这一轮），弹 toast */
  kind: 'delta' | 'tool' | 'assistant' | 'done' | 'error' | 'notice'
  text?: string
  tool?: string
  /** 这条 tool 事件对应的步骤（过程可见性）。`tool` 字段保留不动，TaskDock 还在用 */
  step?: ToolStepEvent
  sdkSessionId?: string
  costUsd?: number
  /** 实际服务这轮的模型名（result.modelUsage 的 key），用来发现端点的静默降级 */
  models?: string[]
  /** 这一轮用的档位；出错时据此给「切换到标准模式重试」的出口 */
  tier?: TierId
  /** B-6：回答里没有依据的引用（库里没有，或本轮从没读过） */
  unverifiedCitations?: string[]
  /** 这一轮是「旧 session 失效 → 拼本地历史重开」之后跑出来的（界面不用，冒烟要用） */
  recovered?: boolean
  /** B4：这条 notice 对应一次 AI 写入，toast 上要挂「撤销」 */
  writeUndoId?: string
  writeRel?: string
}

interface ArtifactInfo {
  path: string
  name: string
  mtimeMs: number
  size: number
  /** v2 产物回流用：记录该产物由哪份草稿/会话生成，本期不实现，只占位 */
  source_draft_id?: string
}

interface SearchHit {
  path: string
  title: string
  snippet: string
}

/** 检索结果：hits 被截断到 20 条，total 是截断前的命中总数（M-13，UI 显示「20 / 共 137 条」） */
interface SearchResult {
  hits: SearchHit[]
  total: number
  /** 精确那一遍没命中、退到「相近结果」了（B-1）。界面要说出来，别让人以为是精确命中 */
  fuzzy?: boolean
}

interface Window {
  api: {
    settings: {
      get: () => Promise<DesktopSettings>
      /** outcome=unchanged 表示值没变、一次 Keychain 都没碰（M-29 写前判重）；tier 不传 = 标准档 */
      setKey: (
        key: string,
        tier?: TierId
      ) => Promise<{ ok: boolean; outcome: 'unchanged' | 'written' | 'queued' }>
      setLlmKey: (key: string) => Promise<{ ok: boolean; outcome: 'unchanged' | 'written' | 'queued' }>
      setApiBase: (url: string) => Promise<{ ok: boolean }>
      setDingtalk: (cfg: {
        webhook: string
        secret: string
        notifyInbox: boolean
        notifyArtifact: boolean
      }) => Promise<{ ok: boolean }>
      setArtifactAutoIngest: (v: boolean) => Promise<{ ok: boolean }>
      setShowCost: (v: boolean) => Promise<{ ok: boolean }>
      setSensitiveMode: (allowAi: boolean, allowCloud: boolean) => Promise<{ ok: boolean }>
    }
    ai: {
      tiers: () => Promise<{ tiers: AiTier[] }>
      setTierConfig: (
        id: TierId,
        cfg: { baseUrl?: string; model?: string; fastModel?: string }
      ) => Promise<{ ok: boolean; tier: AiTier }>
      /** 结果在主进程缓存 5 分钟；force 只给管理员区的「重新检测」 */
      tierHealth: (id: TierId, force?: boolean) => Promise<TierHealth>
    }
    usage: {
      summary: (month?: string) => Promise<UsageSummary>
      months: () => Promise<string[]>
      pricing: () => Promise<UsagePricing>
      setPricing: (p: {
        usd?: Partial<Record<TierId, Partial<{ in: number; out: number }>>>
        usdCny?: number
      }) => Promise<UsagePricing>
    }
    dingtalk: {
      test: () => Promise<{ ok: boolean; error?: string }>
    }
    routes: {
      get: () => Promise<Array<{ name: string; dest: string; builtin?: boolean }>>
      set: (rs: Array<{ name: string; dest: string }>) => Promise<{ ok: boolean; error?: string }>
    }
    vault: {
      pickExisting: () => Promise<VaultOpenResult | null>
      createNew: () => Promise<VaultOpenResult | null>
      openStored: () => Promise<VaultOpenResult | null>
      tree: () => Promise<VaultTreeNode[]>
      graph: () => Promise<GraphData>
      search: (q: string) => Promise<SearchResult>
      read: (relPath: string) => Promise<NoteContent>
      resolveLink: (target: string) => Promise<string | null>
      readRaw: (relPath: string) => Promise<string>
      write: (relPath: string, raw: string) => Promise<void>
      /** 编辑冲突基线（M-27）：进入编辑态时记一份 */
      stat: (relPath: string) => Promise<{ mtimeMs: number; hash: string; size: number }>
      /** 带基线校验的写入：磁盘 hash 与基线对不上就不写，把磁盘现状回给渲染层 */
      writeChecked: (
        relPath: string,
        raw: string,
        baseHash: string
      ) => Promise<{ ok: true } | { ok: false; conflict: true; current: string; currentHash: string }>
      /** 冲突三选一的默认项：写成「笔记名 (冲突副本 …).md」，返回新笔记的相对路径 */
      saveCopy: (relPath: string, raw: string) => Promise<string>
      createNote: (dir: string, name: string) => Promise<string>
      /** 新建文件夹（内部会顺手放一篇同名笔记——空目录在文件树里看不见） */
      createFolder: (dir: string, name: string) => Promise<string>
      deleteNote: (relPath: string) => Promise<void>
      renameNote: (relPath: string, newName: string) => Promise<string>
      /** 在访达里定位库内文件/目录（右键菜单） */
      reveal: (relPath: string) => Promise<void>
      openFile: (href: string, fromNote: string) => Promise<boolean>
      /** self=true 表示这次变更是应用自己写出去的，冲突检测要跳过 */
      onChanged: (cb: (payload: { path: string; self?: boolean }) => void) => () => void
    }
    inbox: {
      /**
       * 收文件进投递箱。目录**递归**且保留相对子路径（落位靠目录树，A-1）。
       * 回的不是单个数字——「0 个」和「跳过了 N 个不支持的格式」得让用户分得开
       */
      enqueue: (paths: string[], subdir?: string) => Promise<EnqueueResult>
      /** 空投递箱时 started=false，渲染层要 toast 说明，不许默默跑全库 */
      runNow: () => Promise<{ started: boolean; pending: number }>
      pending: () => Promise<number>
      /** B3b：还有多少篇笔记的标签是旧版本生成的 */
      staleTags: () => Promise<number>
      /** B3b：显式发起全库标签升级（独立任务，可停止） */
      tagBackfill: () => Promise<void>
      /** 停止本轮：杀整个 pipeline 进程组，已落位的文件不回滚 */
      cancel: () => Promise<boolean>
    }
    chat: {
      /** ok=false 表示被主进程拒了（同一会话已在生成中，H-10） */
      send: (
        sessionId: string,
        prompt: string,
        resume?: string,
        tier?: TierId,
        /** 本轮附件的**原始文件路径**（主进程会先拷进临时目录再交给 agent） */
        attachments?: string[]
      ) => Promise<{ ok: boolean; reason?: 'busy'; error?: string }>
      /** 弹系统选择框挑图片，返回带缩略图的附件列表 */
      pickAttachments: () => Promise<
        { path: string; name: string; size: number; thumb: string; kind: 'image' | 'doc'; tooBig?: boolean }[]
      >
      stop: (sessionId: string) => Promise<void>
      list: () => Promise<Conversation[]>
      save: (conv: Conversation) => Promise<void>
      delete: (id: string) => Promise<void>
      onStream: (cb: (p: AgentStreamPayload) => void) => () => void
      /** B4：AI 要改知识库 → 弹确认卡。不答 60 秒主进程默认拒 */
      onConfirmWrite: (
        cb: (r: { id: string; sessionId: string; rel: string; tool: string; summary: string }) => void
      ) => () => void
      confirmWrite: (id: string, allow: boolean) => Promise<{ ok: boolean }>
      /** 撤销一次 AI 写入（原文写回；本来是新建的则移入废纸篓） */
      undoWrite: (id: string) => Promise<{ ok: boolean; error?: string }>
    }
    auth: {
      /** kind 区分「网络不可达」与「密码错」：Supabase 被暂停时报密码错是最坏的误导（M-01） */
      login: (
        email: string,
        password: string
      ) => Promise<{ ok: boolean; kind?: LoginKind; error?: string }>
      /** 挂住时把界面从「登录中…」放出来 */
      loginCancel: () => Promise<{ ok: boolean }>
      logout: () => Promise<void>
      state: () => Promise<{ loggedIn: boolean; email?: string }>
      provision: () => Promise<{ ok: boolean; error?: string; wrote?: string[] }>
      provisionError: () => Promise<string | null>
      onProvisionFailed: (cb: (msg: string) => void) => () => void
    }
    tasks: {
      list: () => Promise<{ tasks: Task[]; cloud: CloudState }>
      /** 待同步队列转手动之后唯一的出口：tries 归零 + 立刻跑一轮（设计 §3.5） */
      retrySync: () => Promise<{ pending: number; synced: number }>
      onEvent: (cb: (p: TaskEventPayload) => void) => () => void
    }
    shortcut: {
      on: (cb: (name: string) => void) => () => void
    }
    files: {
      /**
       * 拖放来的 File → 磁盘路径（preload 里走 `webUtils.getPathForFile`）。
       * **不要直接读 `File.path`**——Electron 32 起那个属性已被移除，读它恒为 undefined。
       * 取不到时返回空串，调用方**必须**报给用户，不许静默返回。
       */
      pathFor: (file: File) => string
    }
    update: {
      /** disabledReason 非空 = 这台机器根本不查更新（dev 形态 / 更新源还是占位） */
      state: () => Promise<{ ready: boolean; version: string | null; disabledReason: string | null }>
      install: () => Promise<{ ok: boolean; error?: string }>
      onReady: (
        cb: (s: { ready: boolean; version: string | null; disabledReason: string | null }) => void
      ) => () => void
    }
    diag: {
      export: () => Promise<string>
      log: (level: 'info' | 'warn' | 'error', msg: string) => Promise<void>
    }
    artifacts: {
      list: () => Promise<ArtifactInfo[]>
      /** ok=false 时 error 是原因（没装对应应用 / 文件已被删），渲染层要 toast（M-05） */
      open: (relPath: string) => Promise<{ ok: boolean; error?: string }>
      /** 打不开时的兜底：在 Finder 里定位这个产物 */
      reveal: (relPath: string) => Promise<void>
      readText: (relPath: string) => Promise<string>
      ingest: (relPath: string) => Promise<{ ok: boolean; error?: string }>
      ingested: () => Promise<Record<string, { at: number; noteRel?: string }>>
      onCreated: (cb: (a: { path: string; name: string }) => void) => () => void
    }
  }
}
