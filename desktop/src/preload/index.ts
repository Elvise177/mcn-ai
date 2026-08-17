import { contextBridge, ipcRenderer } from 'electron'

const api = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setKey: (key: string) => ipcRenderer.invoke('settings:setKey', key),
    setLlmKey: (key: string) => ipcRenderer.invoke('settings:setLlmKey', key),
    setApiBase: (url: string) => ipcRenderer.invoke('settings:setApiBase', url),
    setDingtalk: (cfg: { webhook: string; secret: string; notifyInbox: boolean; notifyArtifact: boolean }) =>
      ipcRenderer.invoke('settings:setDingtalk', cfg),
    setArtifactAutoIngest: (v: boolean) => ipcRenderer.invoke('settings:setArtifactAutoIngest', v),
  },
  ai: {
    providers: () => ipcRenderer.invoke('ai:providers'),
    setProvider: (id: string) => ipcRenderer.invoke('ai:setProvider', id),
    setProviderConfig: (id: string, cfg: { baseUrl?: string; model?: string; fastModel?: string }) =>
      ipcRenderer.invoke('ai:setProviderConfig', id, cfg),
  },
  vault: {
    pickExisting: () => ipcRenderer.invoke('vault:pickExisting'),
    createNew: () => ipcRenderer.invoke('vault:createNew'),
    openStored: () => ipcRenderer.invoke('vault:openStored'),
    tree: () => ipcRenderer.invoke('vault:tree'),
    graph: () => ipcRenderer.invoke('vault:graph'),
    search: (q: string) => ipcRenderer.invoke('vault:search', q),
    read: (relPath: string) => ipcRenderer.invoke('vault:read', relPath),
    resolveLink: (target: string) => ipcRenderer.invoke('vault:resolveLink', target),
    readRaw: (relPath: string) => ipcRenderer.invoke('vault:readRaw', relPath),
    write: (relPath: string, raw: string) => ipcRenderer.invoke('vault:write', relPath, raw),
    stat: (relPath: string) => ipcRenderer.invoke('vault:stat', relPath),
    writeChecked: (relPath: string, raw: string, baseHash: string) =>
      ipcRenderer.invoke('vault:writeChecked', relPath, raw, baseHash),
    saveCopy: (relPath: string, raw: string) => ipcRenderer.invoke('vault:saveCopy', relPath, raw),
    createNote: (dir: string, name: string) => ipcRenderer.invoke('vault:createNote', dir, name),
    deleteNote: (relPath: string) => ipcRenderer.invoke('vault:deleteNote', relPath),
    renameNote: (relPath: string, newName: string) => ipcRenderer.invoke('vault:renameNote', relPath, newName),
    openFile: (href: string, fromNote: string) => ipcRenderer.invoke('vault:openFile', href, fromNote),
    onChanged: (cb: (payload: { path: string; self?: boolean }) => void) => {
      const listener = (_e: unknown, payload: { path: string; self?: boolean }): void => cb(payload)
      ipcRenderer.on('vault:changed', listener)
      return () => ipcRenderer.removeListener('vault:changed', listener)
    },
  },
}

// legacy 的 inbox:event / inbox:lastRun 在二期删掉了：投递箱状态一律走任务层
// （tasks:list + task:event），渲染层的 useInbox 已经是 useTask('inbox') 的薄封装
const inbox = {
  enqueue: (paths: string[], subdir?: string) => ipcRenderer.invoke('inbox:enqueue', paths, subdir),
  runNow: () => ipcRenderer.invoke('inbox:runNow'),
  cancel: () => ipcRenderer.invoke('inbox:cancel'),
}
const auth = {
  login: (email: string, password: string) => ipcRenderer.invoke('auth:login', email, password),
  loginCancel: () => ipcRenderer.invoke('auth:loginCancel'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  state: () => ipcRenderer.invoke('auth:state'),
  provision: () => ipcRenderer.invoke('auth:provision'),
  provisionError: () => ipcRenderer.invoke('auth:provisionError'),
  onProvisionFailed: (cb: (msg: string) => void) => {
    const listener = (_e: unknown, msg: string): void => cb(msg)
    ipcRenderer.on('auth:provision-failed', listener)
    return () => ipcRenderer.removeListener('auth:provision-failed', listener)
  },
}
const chat = {
  send: (sessionId: string, prompt: string, resume?: string) =>
    ipcRenderer.invoke('chat:send', sessionId, prompt, resume),
  stop: (sessionId: string) => ipcRenderer.invoke('chat:stop', sessionId),
  list: () => ipcRenderer.invoke('chat:list'),
  save: (conv: unknown) => ipcRenderer.invoke('chat:save', conv),
  delete: (id: string) => ipcRenderer.invoke('chat:delete', id),
  onStream: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on('agent:stream', listener)
    return () => ipcRenderer.removeListener('agent:stream', listener)
  },
}
const artifacts = {
  list: () => ipcRenderer.invoke('artifacts:list'),
  open: (relPath: string) => ipcRenderer.invoke('artifacts:open', relPath),
  reveal: (relPath: string) => ipcRenderer.invoke('artifacts:reveal', relPath),
  readText: (relPath: string) => ipcRenderer.invoke('artifacts:readText', relPath),
  ingest: (relPath: string) => ipcRenderer.invoke('artifacts:ingest', relPath),
  ingested: () => ipcRenderer.invoke('artifacts:ingested'),
  onCreated: (cb: (a: unknown) => void) => {
    const listener = (_e: unknown, a: unknown): void => cb(a)
    ipcRenderer.on('artifact:created', listener)
    return () => ipcRenderer.removeListener('artifact:created', listener)
  },
}
const tasksApi = {
  list: () => ipcRenderer.invoke('tasks:list'),
  retrySync: () => ipcRenderer.invoke('sync:retry'),
  onEvent: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('task:event', listener)
    return () => ipcRenderer.removeListener('task:event', listener)
  },
}
const shortcut = {
  on: (cb: (name: string) => void) => {
    const listener = (_e: unknown, name: string): void => cb(name)
    ipcRenderer.on('shortcut', listener)
    return () => ipcRenderer.removeListener('shortcut', listener)
  },
}
const diag = {
  export: () => ipcRenderer.invoke('diag:export'),
  log: (level: 'info' | 'warn' | 'error', msg: string) => ipcRenderer.invoke('log:renderer', level, msg),
}
const routes = {
  get: () => ipcRenderer.invoke('routes:get'),
  set: (rs: Array<{ name: string; dest: string }>) => ipcRenderer.invoke('routes:set', rs),
}
const dingtalk = {
  test: () => ipcRenderer.invoke('dingtalk:test'),
}
const fullApi = { ...api, inbox, chat, artifacts, auth, diag, shortcut, dingtalk, routes, tasks: tasksApi }
contextBridge.exposeInMainWorld('api', fullApi)

export type DesktopApi = typeof fullApi
