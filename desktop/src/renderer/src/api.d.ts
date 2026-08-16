type ProviderId = 'inferera' | 'deepseek' | 'custom'

interface AiProvider {
  id: ProviderId
  label: string
  baseUrl: string
  /** 主模型（显式指定，不依赖端点自动映射） */
  model: string
  /** 轻量子任务模型 */
  fastModel: string
  keyField: string
  hint: string
  hasKey: boolean
}

interface DesktopSettings {
  vaultPath: string | null
  relayBaseUrl: string
  hasApiKey: boolean
  /** true = 用户在设置页手填的 key（服务端下发不会覆盖它） */
  manualApiKey: boolean
  llmBaseUrl: string
  hasLlmKey: boolean
  aiProvider: ProviderId
  providers: AiProvider[]
  /** 当前 provider 的 key 正在后台加密落盘（M-29 等待态） */
  keyWritePending: boolean
  apiBaseUrl: string
  dingtalkWebhook: string
  dingtalkSecret: string
  dingtalkNotifyInbox: boolean
  dingtalkNotifyArtifact: boolean
  artifactAutoIngest: boolean
}

type TaskKind = 'inbox' | 'agent' | 'ingest' | 'sync' | 'secret'
type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

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
  pid?: number
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

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

interface Conversation {
  id: string
  title: string
  sdkSessionId?: string
  messages: ChatMessage[]
  updatedAt: number
}

interface AgentStreamPayload {
  sessionId: string
  kind: 'delta' | 'tool' | 'assistant' | 'done' | 'error'
  text?: string
  tool?: string
  sdkSessionId?: string
  costUsd?: number
  /** 实际服务这轮的模型名（result.modelUsage 的 key），用来发现端点的静默降级 */
  models?: string[]
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

interface Window {
  api: {
    settings: {
      get: () => Promise<DesktopSettings>
      /** outcome=unchanged 表示值没变、一次 Keychain 都没碰（M-29 写前判重） */
      setKey: (key: string) => Promise<{ ok: boolean; outcome: 'unchanged' | 'written' | 'queued' }>
      setLlmKey: (key: string) => Promise<{ ok: boolean; outcome: 'unchanged' | 'written' | 'queued' }>
      setApiBase: (url: string) => Promise<{ ok: boolean }>
      setDingtalk: (cfg: {
        webhook: string
        secret: string
        notifyInbox: boolean
        notifyArtifact: boolean
      }) => Promise<{ ok: boolean }>
      setArtifactAutoIngest: (v: boolean) => Promise<{ ok: boolean }>
    }
    ai: {
      providers: () => Promise<{ current: ProviderId; providers: AiProvider[] }>
      setProvider: (id: ProviderId) => Promise<{ ok: boolean; provider: AiProvider }>
      setProviderConfig: (
        id: ProviderId,
        cfg: { baseUrl?: string; model?: string; fastModel?: string }
      ) => Promise<{ ok: boolean; provider: AiProvider }>
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
      search: (q: string) => Promise<SearchHit[]>
      read: (relPath: string) => Promise<NoteContent>
      resolveLink: (target: string) => Promise<string | null>
      readRaw: (relPath: string) => Promise<string>
      write: (relPath: string, raw: string) => Promise<void>
      createNote: (dir: string, name: string) => Promise<string>
      deleteNote: (relPath: string) => Promise<void>
      renameNote: (relPath: string, newName: string) => Promise<string>
      openFile: (href: string, fromNote: string) => Promise<boolean>
      onChanged: (cb: (payload: { path: string }) => void) => () => void
    }
    inbox: {
      enqueue: (paths: string[], subdir?: string) => Promise<number>
      runNow: () => Promise<void>
      lastRun: () => Promise<InboxEvent[]>
      onEvent: (cb: (ev: InboxEvent) => void) => () => void
    }
    chat: {
      send: (sessionId: string, prompt: string, resume?: string) => Promise<void>
      stop: (sessionId: string) => Promise<void>
      list: () => Promise<Conversation[]>
      save: (conv: Conversation) => Promise<void>
      delete: (id: string) => Promise<void>
      onStream: (cb: (p: AgentStreamPayload) => void) => () => void
    }
    auth: {
      login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
      logout: () => Promise<void>
      state: () => Promise<{ loggedIn: boolean; email?: string }>
      provision: () => Promise<{ ok: boolean; error?: string; wrote?: string[] }>
      provisionError: () => Promise<string | null>
      onProvisionFailed: (cb: (msg: string) => void) => () => void
    }
    tasks: {
      list: () => Promise<{ tasks: Task[]; cloud: CloudState }>
      onEvent: (cb: (p: TaskEventPayload) => void) => () => void
    }
    shortcut: {
      on: (cb: (name: string) => void) => () => void
    }
    diag: {
      export: () => Promise<string>
      log: (level: 'info' | 'warn' | 'error', msg: string) => Promise<void>
    }
    artifacts: {
      list: () => Promise<ArtifactInfo[]>
      open: (relPath: string) => Promise<void>
      readText: (relPath: string) => Promise<string>
      ingest: (relPath: string) => Promise<{ ok: boolean; error?: string }>
      ingested: () => Promise<Record<string, { at: number; noteRel?: string }>>
      onCreated: (cb: (a: { path: string; name: string }) => void) => () => void
    }
  }
}
