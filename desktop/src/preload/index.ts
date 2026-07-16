import { contextBridge, ipcRenderer } from 'electron'

const api = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setKey: (key: string) => ipcRenderer.invoke('settings:setKey', key),
    setLlmKey: (key: string) => ipcRenderer.invoke('settings:setLlmKey', key),
    setApiBase: (url: string) => ipcRenderer.invoke('settings:setApiBase', url),
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
    createNote: (dir: string, name: string) => ipcRenderer.invoke('vault:createNote', dir, name),
    deleteNote: (relPath: string) => ipcRenderer.invoke('vault:deleteNote', relPath),
    openFile: (href: string, fromNote: string) => ipcRenderer.invoke('vault:openFile', href, fromNote),
    onChanged: (cb: (payload: { path: string }) => void) => {
      const listener = (_e: unknown, payload: { path: string }): void => cb(payload)
      ipcRenderer.on('vault:changed', listener)
      return () => ipcRenderer.removeListener('vault:changed', listener)
    },
  },
}

const inbox = {
  enqueue: (paths: string[]) => ipcRenderer.invoke('inbox:enqueue', paths),
  runNow: () => ipcRenderer.invoke('inbox:runNow'),
  lastRun: () => ipcRenderer.invoke('inbox:lastRun'),
  onEvent: (cb: (ev: unknown) => void) => {
    const listener = (_e: unknown, ev: unknown): void => cb(ev)
    ipcRenderer.on('inbox:event', listener)
    return () => ipcRenderer.removeListener('inbox:event', listener)
  },
}
const auth = {
  login: (email: string, password: string) => ipcRenderer.invoke('auth:login', email, password),
  logout: () => ipcRenderer.invoke('auth:logout'),
  state: () => ipcRenderer.invoke('auth:state'),
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
  readText: (relPath: string) => ipcRenderer.invoke('artifacts:readText', relPath),
  onCreated: (cb: (a: unknown) => void) => {
    const listener = (_e: unknown, a: unknown): void => cb(a)
    ipcRenderer.on('artifact:created', listener)
    return () => ipcRenderer.removeListener('artifact:created', listener)
  },
}
const fullApi = { ...api, inbox, chat, artifacts, auth }
contextBridge.exposeInMainWorld('api', fullApi)

export type DesktopApi = typeof fullApi
