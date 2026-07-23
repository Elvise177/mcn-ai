import { ipcMain, dialog } from 'electron'
import { store, setApiKey, getApiKey, setLlmKey, getLlmKey } from './store'
import { inboxOrchestrator } from './inbox/orchestrator'
import { agentManager } from './agent'
import { login, logout, authState, provisionKeys } from './auth'
import { artifactsWatcher } from './agent/artifacts'
import { listConversations, saveConversation, deleteConversation, type Conversation } from './agent/conversations'
import { syncConversation } from './knowledge/client'
import { vaultManager } from './vault'
import { log } from './lib/logger'
import { exportDiagnostics } from './lib/diagnostics'
import { createVault } from './vault/wizard'
import { sendDingtalk } from './lib/dingtalk'
import { startBizSync } from './knowledge/bizdata'

/** IPC channel 约定：请求-响应走 handle；流式下行用 webContents.send（vault:changed 等） */
export function registerIpc(): void {
  ipcMain.handle('settings:get', () => ({
    vaultPath: process.env.MCNAI_VAULT || store.get('vaultPath') || null,
    relayBaseUrl: store.get('relayBaseUrl'),
    hasApiKey: !!getApiKey(),
    llmBaseUrl: store.get('llmBaseUrl'),
    hasLlmKey: !!getLlmKey(),
    apiBaseUrl: store.get('apiBaseUrl'),
    dingtalkWebhook: store.get('dingtalkWebhook') ?? '',
    dingtalkSecret: store.get('dingtalkSecret') ?? '',
    dingtalkNotifyInbox: store.get('dingtalkNotifyInbox'),
    dingtalkNotifyArtifact: store.get('dingtalkNotifyArtifact'),
  }))

  ipcMain.handle(
    'settings:setDingtalk',
    (_e, cfg: { webhook: string; secret: string; notifyInbox: boolean; notifyArtifact: boolean }) => {
      store.set('dingtalkWebhook', cfg.webhook.trim())
      store.set('dingtalkSecret', cfg.secret.trim())
      store.set('dingtalkNotifyInbox', cfg.notifyInbox)
      store.set('dingtalkNotifyArtifact', cfg.notifyArtifact)
      return { ok: true }
    }
  )

  ipcMain.handle('dingtalk:test', () =>
    sendDingtalk('mcn-ai 测试', `### 钉钉接入成功 🎉\n\nmcn-ai 自动化中心已连上这个群。\n\n> ${new Date().toLocaleString('zh-CN')}`)
  )

  ipcMain.handle('settings:setLlmKey', (_e: Electron.IpcMainInvokeEvent, key: string) => {
    setLlmKey(key.trim())
    store.set('manualLlmKey', true)
    return { ok: true }
  })

  ipcMain.handle('settings:setKey', (_e: Electron.IpcMainInvokeEvent, key: string) => {
    setApiKey(key.trim())
    store.set('manualApiKey', true)
    return { ok: true }
  })

  // ---- vault ----
  ipcMain.handle('vault:pickExisting', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return openVault(r.filePaths[0])
  })

  ipcMain.handle('vault:createNew', async () => {
    const r = await dialog.showSaveDialog({
      title: '新建知识库',
      nameFieldLabel: '库名称',
      defaultPath: '我的知识库',
      buttonLabel: '创建',
    })
    if (r.canceled || !r.filePath) return null
    await createVault(r.filePath)
    return openVault(r.filePath)
  })

  ipcMain.handle('vault:openStored', () => openStoredVault())

  ipcMain.handle('vault:tree', () => vaultManager.tree())
  ipcMain.handle('vault:graph', () => vaultManager.graph())
  ipcMain.handle('vault:search', (_e, q: string) => vaultManager.search(q))
  ipcMain.handle('vault:read', (_e, relPath: string) => vaultManager.read(relPath))
  ipcMain.handle('vault:resolveLink', (_e, target: string) => vaultManager.resolveLink(target))
  ipcMain.handle('vault:readRaw', (_e, relPath: string) => vaultManager.readRaw(relPath))
  ipcMain.handle('vault:write', (_e, relPath: string, raw: string) => vaultManager.write(relPath, raw))
  ipcMain.handle('vault:createNote', (_e, dir: string, name: string) => vaultManager.createNote(dir, name))
  ipcMain.handle('vault:deleteNote', (_e, relPath: string) => vaultManager.deleteNote(relPath))
  ipcMain.handle('vault:renameNote', (_e, relPath: string, newName: string) => vaultManager.renameNote(relPath, newName))
  ipcMain.handle('vault:openFile', (_e, href: string, fromNote: string) => vaultManager.openFile(href, fromNote))

  // ---- auth ----
  ipcMain.handle('auth:login', (_e, email: string, password: string) => login(email, password))
  ipcMain.handle('auth:logout', () => logout())
  ipcMain.handle('auth:state', () => authState())
  ipcMain.handle('settings:setApiBase', (_e, url: string) => {
    store.set('apiBaseUrl', url.trim().replace(/\/$/, ''))
    return { ok: true }
  })

  // ---- chat ----
  ipcMain.handle('chat:send', (_e, sessionId: string, prompt: string, resume?: string) => {
    void agentManager.send(sessionId, prompt, resume)
  })
  ipcMain.handle('chat:stop', (_e, sessionId: string) => agentManager.stop(sessionId))
  ipcMain.handle('chat:list', () => listConversations())
  ipcMain.handle('chat:save', (_e, conv: Conversation) => {
    saveConversation(conv)
    void syncConversation(conv) // 云端尽力而为，失败不影响本地
  })
  ipcMain.handle('chat:delete', (_e, id: string) => deleteConversation(id))

  // ---- artifacts ----
  ipcMain.handle('artifacts:list', () => artifactsWatcher.list())
  ipcMain.handle('artifacts:open', (_e, relPath: string) => artifactsWatcher.open(relPath))
  ipcMain.handle('artifacts:readText', (_e, relPath: string) => artifactsWatcher.readText(relPath))

  // ---- 诊断与日志 ----
  ipcMain.handle('diag:export', () => exportDiagnostics())
  ipcMain.handle('log:renderer', (_e, level: 'info' | 'warn' | 'error', msg: string) => log(level, 'renderer', msg))

  // ---- inbox ----
  ipcMain.handle('inbox:enqueue', (_e, paths: string[]) => inboxOrchestrator.enqueue(paths))
  ipcMain.handle('inbox:runNow', () => void inboxOrchestrator.run())
  ipcMain.handle('inbox:lastRun', () => inboxOrchestrator.lastRun)
}

/** 启动时与知识库页共用：打开上次的库（对话工作台是首页，不能等用户进知识库页才加载库） */
export async function openStoredVault(): Promise<{ path: string; noteCount: number } | null> {
  const p = process.env.MCNAI_VAULT || store.get('vaultPath')
  if (!p) return null
  try {
    return await openVault(p)
  } catch {
    return null
  }
}

async function openVault(path: string): Promise<{ path: string; noteCount: number }> {
  const { noteCount } = await vaultManager.open(path)
  store.set('vaultPath', path)
  await inboxOrchestrator.configure(path)
  await artifactsWatcher.configure(path)
  startBizSync(path)
  return { path, noteCount }
}
