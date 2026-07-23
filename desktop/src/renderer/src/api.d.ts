interface DesktopSettings {
  vaultPath: string | null
  relayBaseUrl: string
  hasApiKey: boolean
  llmBaseUrl: string
  hasLlmKey: boolean
  apiBaseUrl: string
  dingtalkWebhook: string
  dingtalkSecret: string
  dingtalkNotifyInbox: boolean
  dingtalkNotifyArtifact: boolean
  artifactAutoIngest: boolean
}

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
}

interface ArtifactInfo {
  path: string
  name: string
  mtimeMs: number
  size: number
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
      setKey: (key: string) => Promise<{ ok: boolean }>
      setLlmKey: (key: string) => Promise<{ ok: boolean }>
      setApiBase: (url: string) => Promise<{ ok: boolean }>
      setDingtalk: (cfg: {
        webhook: string
        secret: string
        notifyInbox: boolean
        notifyArtifact: boolean
      }) => Promise<{ ok: boolean }>
      setArtifactAutoIngest: (v: boolean) => Promise<{ ok: boolean }>
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
      onCreated: (cb: (a: { path: string; name: string }) => void) => () => void
    }
  }
}
