import { ipcMain, dialog } from 'electron'
import { store, setLlmKey, hasApiKey, hasLlmKey, setSecretLater, isSecretPending } from './store'
import {
  currentProviderId,
  describeProvider,
  listProviders,
  setProvider,
  setProviderOverrides,
  type ProviderId,
} from './ai/provider'
import { inboxOrchestrator } from './inbox/orchestrator'
import { agentManager } from './agent'
import { login, logout, authState, provisionKeys, getProvisionError, cancelLogin } from './auth'
import { retryAllSyncs } from './knowledge/sync-queue'
import { artifactsWatcher } from './agent/artifacts'
import { listConversations, saveConversation, deleteConversation, type Conversation } from './agent/conversations'
import { syncConversation } from './knowledge/client'
import { vaultManager } from './vault'
import { log } from './lib/logger'
import { exportDiagnostics } from './lib/diagnostics'
import { createVault } from './vault/wizard'
import { sendDingtalk } from './lib/dingtalk'
import { startBizSync } from './knowledge/bizdata'
import { getRoutes, setRoutes, ensureRouteFolders } from './lib/routes'
import { tasks } from './tasks/registry'

/** IPC channel 约定：请求-响应走 handle；流式下行用 webContents.send（vault:changed 等） */
export function registerIpc(): void {
  // 注意：这里一律不解密。`hasApiKey` 用密文存在性回答，否则每次打开设置页都可能
  // 触发一次 safeStorage 冷调用，把主进程冻住几十秒（M-29）
  ipcMain.handle('settings:get', () => ({
    vaultPath: process.env.MCNAI_VAULT || store.get('vaultPath') || null,
    relayBaseUrl: store.get('relayBaseUrl'),
    hasApiKey: hasApiKey(),
    manualApiKey: store.get('manualApiKey') === true,
    llmBaseUrl: store.get('llmBaseUrl'),
    hasLlmKey: hasLlmKey(),
    aiProvider: currentProviderId(),
    providers: listProviders(),
    keyWritePending: isSecretPending(describeProvider().keyField),
    apiBaseUrl: store.get('apiBaseUrl'),
    dingtalkWebhook: store.get('dingtalkWebhook') ?? '',
    dingtalkSecret: store.get('dingtalkSecret') ?? '',
    dingtalkNotifyInbox: store.get('dingtalkNotifyInbox'),
    dingtalkNotifyArtifact: store.get('dingtalkNotifyArtifact'),
    artifactAutoIngest: store.get('artifactAutoIngest'),
  }))

  ipcMain.handle('settings:setArtifactAutoIngest', (_e, v: boolean) => {
    store.set('artifactAutoIngest', !!v)
    return { ok: true }
  })

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
    const outcome = setLlmKey(key.trim())
    store.set('manualLlmKey', true)
    return { ok: true, outcome }
  })

  /**
   * 手填 key：写进**当前 provider 那把槽位**。
   * 立刻返回（明文已进内存缓存，马上能发消息），落盘是后台任务——safeStorage 首次调用
   * 会同步冻住主进程几十秒，不能挡在这颗保存按钮后面（M-29）
   */
  ipcMain.handle('settings:setKey', (_e: Electron.IpcMainInvokeEvent, key: string) => {
    const field = describeProvider().keyField
    const outcome = setSecretLater(field, key.trim())
    if (field === 'encryptedApiKey') store.set('manualApiKey', true)
    if (field === 'encryptedLlmKey') store.set('manualLlmKey', true)
    return { ok: true, outcome }
  })

  // ---- 模型 provider（inferera / DeepSeek 官方 / 自定义）----
  ipcMain.handle('ai:providers', () => ({ current: currentProviderId(), providers: listProviders() }))
  ipcMain.handle('ai:setProvider', (_e, id: ProviderId) => {
    setProvider(id)
    return { ok: true, provider: describeProvider(id) }
  })
  ipcMain.handle(
    'ai:setProviderConfig',
    (_e, id: ProviderId, cfg: { baseUrl?: string; model?: string; fastModel?: string }) => {
      setProviderOverrides(id, cfg)
      return { ok: true, provider: describeProvider(id) }
    }
  )

  // ---- vault ----
  ipcMain.handle('vault:pickExisting', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return openVault(r.filePaths[0])
  })

  ipcMain.handle('vault:createNew', async () => {
    // MCNAI_E2E_VAULT_FAIL（值 = 先卡住多少毫秒）只给走查用：验 H-12 的「失败/耗时」分支。
    // 真让 createVault 失败得造只读盘，而系统保存框一弹起来 Playwright 就没法继续了。
    // 生产不读这个变量（同 MCNAI_SUPABASE_URL 的用法，见 HANDOFF §4-21/§4-22）
    const e2eFail = process.env.MCNAI_E2E_VAULT_FAIL
    if (e2eFail) {
      await new Promise((r) => setTimeout(r, Number(e2eFail) || 0))
      throw new Error('磁盘不可写（e2e 模拟）')
    }
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
  // ---- 编辑冲突（M-27）：进编辑记基线 → 保存时服务端再校验一次 → 冲突就另存副本 ----
  ipcMain.handle('vault:stat', (_e, relPath: string) => vaultManager.stat(relPath))
  ipcMain.handle('vault:writeChecked', (_e, relPath: string, raw: string, baseHash: string) =>
    vaultManager.writeChecked(relPath, raw, baseHash)
  )
  ipcMain.handle('vault:saveCopy', (_e, relPath: string, raw: string) =>
    vaultManager.saveConflictCopy(relPath, raw)
  )
  ipcMain.handle('vault:createNote', (_e, dir: string, name: string) => vaultManager.createNote(dir, name))
  ipcMain.handle('vault:deleteNote', (_e, relPath: string) => vaultManager.deleteNote(relPath))
  ipcMain.handle('vault:renameNote', (_e, relPath: string, newName: string) => vaultManager.renameNote(relPath, newName))
  ipcMain.handle('vault:openFile', (_e, href: string, fromNote: string) => vaultManager.openFile(href, fromNote))

  // ---- auth ----
  ipcMain.handle('auth:login', (_e, email: string, password: string) => login(email, password))
  // M-01：登录挂住时把界面从「登录中…」放出来（底层请求可能还在跑，但没人等它了）
  ipcMain.handle('auth:loginCancel', () => {
    cancelLogin()
    return { ok: true }
  })
  ipcMain.handle('auth:logout', () => logout())
  ipcMain.handle('auth:state', () => authState())
  // 设置页「重新获取服务端配置」；启动那次失败的原因也在这查（渲染层挂载晚于启动 provision）
  ipcMain.handle('auth:provision', () => provisionKeys())
  ipcMain.handle('auth:provisionError', () => getProvisionError())
  ipcMain.handle('settings:setApiBase', (_e, url: string) => {
    store.set('apiBaseUrl', url.trim().replace(/\/$/, ''))
    return { ok: true }
  })

  // ---- chat ----
  /**
   * H-10：同一 session 已在流式中就**拒绝**，不 abort 旧的——「我以为它没在跑」和
   * 「我想重来」是两回事，静默 abort 会误伤正在生成的长回答。拒绝理由回给渲染层，
   * 由它弹一条带「停止当前生成」动作的提示（设计 §5.3），别把用户堵死在原地。
   */
  ipcMain.handle('chat:send', (_e, sessionId: string, prompt: string, resume?: string) => {
    if (agentManager.isStreaming(sessionId)) {
      return { ok: false, reason: 'busy' as const, error: '这个对话还在生成中' }
    }
    void agentManager.send(sessionId, prompt, resume)
    return { ok: true }
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
  ipcMain.handle('artifacts:reveal', (_e, relPath: string) => artifactsWatcher.reveal(relPath))
  ipcMain.handle('artifacts:readText', (_e, relPath: string) => artifactsWatcher.readText(relPath))
  // 显式入库（带任务身份），取代过去借道 inbox:enqueue 的发射后不管
  ipcMain.handle('artifacts:ingest', (_e, relPath: string) => artifactsWatcher.ingest(relPath))
  ipcMain.handle('artifacts:ingested', () => artifactsWatcher.ingested())

  // ---- 全局任务状态层 ----
  // push（task:event）尽力而为，这个 invoke 才是权威：渲染层每次挂载都先拉一次打底
  ipcMain.handle('tasks:list', () => tasks.snapshot())
  // 转手动之后唯一的出口：整队 tries 归零并立刻跑一轮（设计 §3.5）
  ipcMain.handle('sync:retry', () => retryAllSyncs())

  // ---- 诊断与日志 ----
  ipcMain.handle('diag:export', () => exportDiagnostics())
  ipcMain.handle('log:renderer', (_e, level: 'info' | 'warn' | 'error', msg: string) => log(level, 'renderer', msg))

  // ---- inbox ----
  // ---- 投递箱分流配置（设置界面用） ----
  ipcMain.handle('routes:get', async () => {
    const v = process.env.MCNAI_VAULT || store.get('vaultPath')
    return v ? getRoutes(v) : []
  })
  ipcMain.handle('routes:set', async (_e, routes: Array<{ name: string; dest: string }>) => {
    const v = process.env.MCNAI_VAULT || store.get('vaultPath')
    if (!v) return { ok: false, error: '请先打开知识库' }
    await setRoutes(v, routes)
    return { ok: true }
  })

  ipcMain.handle('inbox:enqueue', (_e, paths: string[], subdir?: string) => inboxOrchestrator.enqueue(paths, subdir))
  ipcMain.handle('inbox:runNow', () => void inboxOrchestrator.run())
  // 停止本轮：杀整个 pipeline 进程组，已落位的文件不回滚（H-13，设计 §5.1）
  ipcMain.handle('inbox:cancel', () => inboxOrchestrator.cancel('user'))
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
  await ensureRouteFolders(path)
  if (store.get('bizSyncEnabled')) startBizSync(path)
  return { path, noteCount }
}
