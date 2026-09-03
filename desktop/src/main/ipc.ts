import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { store, setLlmKey, hasApiKey, hasLlmKey, setSecretLater, isSecretPending } from './store'
import {
  describeTier,
  listTiers,
  migrateTiers,
  normalizeTier,
  setTierConfig,
  type TierId,
} from './ai/tiers'
import { invalidateTierHealth, tierHealth } from './ai/health'
import { summarize, currentMonth, listMonths } from './usage'
import { getPricing, setPricing } from './usage/pricing'
import { inboxOrchestrator, SUPPORTED_EXT } from './inbox/orchestrator'
import { agentManager } from './agent'
import { pickAttachments } from './agent/attachments'
import { login, logout, authState, provisionKeys, getProvisionError, cancelLogin } from './auth'
import { retryAllSyncs } from './knowledge/sync-queue'
import { artifactsWatcher } from './agent/artifacts'
import { listConversations, saveConversation, deleteConversation, type Conversation } from './agent/conversations'
import { syncConversation } from './knowledge/client'
import { vaultManager } from './vault'
import { log } from './lib/logger'
import { exportDiagnostics } from './lib/diagnostics'
import { createVault, isSafeVaultRoot } from './vault/wizard'
import type { PresetId } from './vault/taxonomy'
import { sendDingtalk } from './lib/dingtalk'
import { startBizSync } from './knowledge/bizdata'
import { readVaultConfig, hasFeature, MCN_PRESET } from './vault/taxonomy'

/** 当前库的 persona id；没开库时按通用给（首跑那几屏也会读一次） */
async function currentPersonaId(): Promise<string> {
  const root = process.env.MCNAI_VAULT || store.get('vaultPath')
  return root ? (await readVaultConfig(root)).persona.id : 'general'
}

/** 当前库的资料库目录名；没开库时给出厂值（设置页在建库之前也会读一次） */
async function currentLibraryName(): Promise<string> {
  const root = process.env.MCNAI_VAULT || store.get('vaultPath')
  return root ? (await readVaultConfig(root)).library : MCN_PRESET.library
}
import { getRoutes, setRoutes, ensureRouteFolders } from './lib/routes'
import { tasks } from './tasks/registry'
import { updateState, installUpdateNow } from './updater'
import { undoWrite, pruneBackups } from './agent/write-backup'

/** IPC channel 约定：请求-响应走 handle；流式下行用 webContents.send（vault:changed 等） */
export function registerIpc(): void {
  // 老用户迁移只跑一次：升级前配好的全局线路搬成"标准档"的映射，行为不变（见 ai/tiers.ts）
  migrateTiers()

  // 注意：这里一律不解密。`hasApiKey` 用密文存在性回答，否则每次打开设置页都可能
  // 触发一次 safeStorage 冷调用，把主进程冻住几十秒（M-29）
  ipcMain.handle('settings:get', async () => ({
    vaultPath: process.env.MCNAI_VAULT || store.get('vaultPath') || null,
    /** 资料库目录名。渲染层要显示"文件会落到哪"，原来那处是写死的 `80_Library` */
    libraryName: await currentLibraryName(),
    /** 库的业务身份 id（general|mcn|custom）。首页快捷指令按它筛选 */
    personaId: await currentPersonaId(),
    /**
     * 能入库的扩展名。**暴露出来是为了让走查读真值**——
     * `e2e/a1-enqueue.mjs` 原来自己抄了一份，0.1.2 加 `.doc` 之后
     * 它算出的期望值比生产少一个，报成"整包拖入没有全部入队"，
     * 方向完全指错（产品是对的，抄的那份过期了）。
     */
    supportedExt: [...SUPPORTED_EXT],
    relayBaseUrl: store.get('relayBaseUrl'),
    hasApiKey: hasApiKey(),
    manualApiKey: store.get('manualApiKey') === true,
    llmBaseUrl: store.get('llmBaseUrl'),
    hasLlmKey: hasLlmKey(),
    tiers: listTiers(),
    /** 普通模式的「AI 服务：已就绪 ✓」只看默认档（标准）那把 key 在不在 */
    aiReady: describeTier('standard').hasKey,
    keyWritePending: isSecretPending(describeTier('standard').keyField),
    apiBaseUrl: store.get('apiBaseUrl'),
    showCost: store.get('showCost'),
    sensitiveAllowAi: store.get('sensitiveAllowAi'),
    sensitiveAllowCloud: store.get('sensitiveAllowCloud'),
    /** 第一版检索口径（'local' | 'cloud'，出厂 local）。只读暴露，供走查断言与诊断报告 */
    searchBackend: store.get('searchBackend'),
    /**
     * **真实应用版本**（`package.json` 的 version，打包时烧进 Info.plist）。
     *
     * 界面上那个版本号原来是渲染层里手写的常量 `const APP_VERSION = 'v0.1.0'`——
     * 装什么版本都显示 0.1.0（2026-08-20 真人装了 0.1.1 发现的）。
     * 而"看设置页版本号确认客户升没升级"正是发版流程里的关键一步，
     * 一个永远不变的数字等于把这一步废掉了。
     */
    appVersion: app.getVersion(),
    /** agent 一轮的墙钟上限（分钟，0 = 关）；管理员区可改（R3） */
    agentTimeoutMin: store.get('agentTimeoutMin'),
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

  // A-8 三态：界面三档 → 两个独立布尔。**不追溯已入库的笔记**（PLAN §5f-3），
  // 只影响之后进投递箱的文件
  ipcMain.handle('settings:setShowCost', (_e, v: boolean) => {
    store.set('showCost', !!v)
    return { ok: true }
  })

  ipcMain.handle('settings:setSensitiveMode', (_e, allowAi: boolean, allowCloud: boolean) => {
    store.set('sensitiveAllowAi', !!allowAi || !!allowCloud) // 允许上云必然也允许打标
    store.set('sensitiveAllowCloud', !!allowCloud)
    return { ok: true }
  })

  // agent 一轮的墙钟上限（R3）。整数分钟、0 = 关、上限 240；非法值落回出厂 15，不静默吞
  ipcMain.handle('settings:setAgentTimeout', (_e, minutes: number) => {
    const n = Number(minutes)
    const v = Number.isFinite(n) && n >= 0 ? Math.min(240, Math.round(n)) : 15
    store.set('agentTimeoutMin', v)
    log('info', 'settings', `agent 墙钟上限改为 ${v} 分钟`)
    return { ok: true, minutes: v }
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
   * 手填 key（管理员区）：写进**指定档位那把槽位**，不传就是默认档（标准）。
   * 立刻返回（明文已进内存缓存，马上能发消息），落盘是后台任务——safeStorage 首次调用
   * 会同步冻住主进程几十秒，不能挡在这颗保存按钮后面（M-29）
   */
  ipcMain.handle('settings:setKey', (_e: Electron.IpcMainInvokeEvent, key: string, tier?: TierId) => {
    const field = describeTier(normalizeTier(tier ?? 'standard')).keyField
    const outcome = setSecretLater(field, key.trim())
    if (field === 'encryptedApiKey') store.set('manualApiKey', true)
    if (field === 'encryptedLlmKey') store.set('manualLlmKey', true)
    invalidateTierHealth() // 换了 key，5 分钟缓存立刻作废，别让人改完还要等
    return { ok: true, outcome }
  })

  // ---- 模型档位（标准/增强）：语义写死，映射留运维口（见 ai/tiers.ts）----
  ipcMain.handle('ai:tiers', () => ({ tiers: listTiers() }))
  ipcMain.handle(
    'ai:setTierConfig',
    (_e, id: TierId, cfg: { baseUrl?: string; model?: string; fastModel?: string }) => {
      setTierConfig(normalizeTier(id), cfg)
      invalidateTierHealth(normalizeTier(id))
      return { ok: true, tier: describeTier(normalizeTier(id)) }
    }
  )
  // 结果缓存 5 分钟，force 只给管理员区的「重新检测」用（不得每次发送都探）
  ipcMain.handle('ai:tierHealth', (_e, id: TierId, force?: boolean) => tierHealth(normalizeTier(id), !!force))

  // ---- 用量（按月 jsonl → 汇总）----
  ipcMain.handle('usage:summary', (_e, month?: string) => summarize(month || currentMonth()))
  ipcMain.handle('usage:months', () => listMonths())
  // 单价与汇率是运维配置：只有管理员区调它，普通用户看到的永远是算好的人民币
  ipcMain.handle('usage:pricing', () => getPricing())
  ipcMain.handle('usage:setPricing', (_e, p: { routes?: unknown; usdCny?: number }) =>
    setPricing(p as Parameters<typeof setPricing>[0])
  )

  // ---- vault ----
  ipcMain.handle('vault:pickExisting', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    // N6：家目录 / 磁盘根 / 外接卷根 / iCloud 根 整个当库会扫几十万文件、盯整块盘——在这儿拦，理由给向导 toast
    const safe = isSafeVaultRoot(r.filePaths[0])
    if (!safe.ok) throw new Error(safe.reason)
    return openVault(r.filePaths[0])
  })

  ipcMain.handle('vault:createNew', async (_e, preset: PresetId = 'general') => {
    // MCNAI_E2E_VAULT_FAIL（值 = 先卡住多少毫秒）只给走查用：验 H-12 的「失败/耗时」分支。
    // 真让 createVault 失败得造只读盘，而系统保存框一弹起来 Playwright 就没法继续了。
    // 生产不读这个变量（同 MCNAI_SUPABASE_URL 的用法，见 HANDOFF §4-21/§4-22）
    const e2eFail = process.env.MCNAI_E2E_VAULT_FAIL
    if (e2eFail) {
      await new Promise((r) => setTimeout(r, Number(e2eFail) || 0))
      throw new Error('磁盘不可写（e2e 模拟）')
    }
    // MCNAI_E2E_NEW_VAULT（值 = 建到哪个路径）同样只给走查用：**成功那条分支**在这之前
    // 一次都没被 e2e 覆盖过——原因和上面那条一样，系统保存框挡住了 Playwright，
    // 于是"模板新建库"只能靠人手点。而 A-3 那个「双链 352 → 2」的 bug 正好长在这条路上
    // （模板建的库里没有实体清单目录，07 建链无从下手），2026-08-18 发布前自测补上。
    // 生产不读这个变量（判据同 HANDOFF §4-22：真触发它需要驱动原生对话框）
    const e2eNew = process.env.MCNAI_E2E_NEW_VAULT
    if (e2eNew) {
      await createVault(e2eNew, preset)
      return openVault(e2eNew)
    }
    const r = await dialog.showSaveDialog({
      title: '新建知识库',
      nameFieldLabel: '库名称',
      defaultPath: '我的知识库',
      buttonLabel: '创建',
    })
    if (r.canceled || !r.filePath) return null
    const safe = isSafeVaultRoot(r.filePath) // N6：保存框里也能选到磁盘根/家目录本身
    if (!safe.ok) throw new Error(safe.reason)
    await createVault(r.filePath, preset)
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
  ipcMain.handle('vault:createFolder', (_e, dir: string, name: string) => vaultManager.createFolder(dir, name))
  ipcMain.handle('vault:deleteNote', (_e, relPath: string) => vaultManager.deleteNote(relPath))
  ipcMain.handle('vault:renameNote', (_e, relPath: string, newName: string) => vaultManager.renameNote(relPath, newName))
  ipcMain.handle('vault:reveal', (_e, relPath: string) => vaultManager.reveal(relPath))
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
  ipcMain.handle(
    'chat:send',
    (_e, sessionId: string, prompt: string, resume?: string, tier?: TierId, attachments?: string[]) => {
      if (agentManager.isStreaming(sessionId)) {
        return { ok: false, reason: 'busy' as const, error: '这个对话还在生成中' }
      }
      // attachments 是**追加**的第 5 个参数：IPC 一次定死（§4-9）之后少见的签名变更，
      // 按可选参数往后加，前四个位次一个不动
      void agentManager.send(sessionId, prompt, resume, normalizeTier(tier ?? 'standard'), attachments ?? [])
      return { ok: true }
    }
  )
  /** 输入框的附件按钮：主进程弹系统选择框、生成缩略图，渲染进程零 FS 能力 */
  ipcMain.handle('attach:pick', () => pickAttachments(BrowserWindow.getAllWindows()[0] ?? null))
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

  // ---- 自动更新 ----
  // state 是权威快照（`update:ready` 推送在窗口 reload 期间会丢，同任务层那条约定）
  // ---- B4：AI 写知识库的确认与撤销 ----
  ipcMain.handle('agent:confirmWrite', (_e, id: string, allow: boolean) => {
    agentManager.resolveWriteConfirm(id, !!allow)
    return { ok: true }
  })
  ipcMain.handle('agent:undoWrite', (_e, id: string) => undoWrite(id))
  // 诊断口（R1）：当前库的对话 system prompt 原文，只读。走查拿它扫"通用库不许有 MCN 字眼"
  ipcMain.handle('agent:systemPrompt', () => agentManager.systemPromptForDiag())

  ipcMain.handle('update:state', () => updateState())
  ipcMain.handle('update:install', () => installUpdateNow())

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
  /**
   * 「立即处理」。**空投递箱不许起 pipeline**——pipeline 的后半段是对全库跑的
   * （实体建卡 / MOC 重建 / 主题索引），空着点一下等于把整个库重过一遍：
   * 白等几分钟、可能烧打标额度，而界面上只有一条进度条，看不出其实没有新东西。
   * 现在直接回一句话让渲染层 toast，不动 pipeline。
   */
  ipcMain.handle('inbox:runNow', async () => {
    const pending = await inboxOrchestrator.pendingCount()
    // 上一轮被停掉且没跑完时**必须放行**：那时投递箱可能已经空了（文件在更早的阶段就
    // 进了 `.done/`），但对全库跑的那些阶段还没做完，而取消提示指的就是这条路
    const resumable = inboxOrchestrator.hasUnfinishedWork()
    if (pending === 0 && !resumable) return { started: false, pending: 0, resumable: false }
    void inboxOrchestrator.run()
    return { started: true, pending, resumable }
  })
  ipcMain.handle('inbox:pending', () => inboxOrchestrator.pendingCount())
  // B3b：旧标签补齐——查有多少 / 显式发起。**入库不再顺带做这件事**
  ipcMain.handle('inbox:staleTags', () => inboxOrchestrator.staleTagCount())
  // **不许 void**：`void promise` 把结果和异常一起丢掉，渲染层永远拿不到"为什么没开始"
  ipcMain.handle('inbox:tagBackfill', () => inboxOrchestrator.runTagBackfill())
  ipcMain.handle('inbox:openFailed', () => inboxOrchestrator.openFailedDir())
  // 停止本轮：杀整个 pipeline 进程组，已落位的文件不回滚（H-13，设计 §5.1）
  ipcMain.handle('inbox:cancel', () => inboxOrchestrator.cancel('user'))
}

/** 启动时与知识库页共用：打开上次的库（对话工作台是首页，不能等用户进知识库页才加载库） */
export async function openStoredVault(): Promise<{ path: string; noteCount: number; stoppedInbox?: boolean } | null> {
  const p = process.env.MCNAI_VAULT || store.get('vaultPath')
  if (!p) return null
  try {
    return await openVault(p)
  } catch {
    return null
  }
}

async function openVault(path: string): Promise<{ path: string; noteCount: number; stoppedInbox?: boolean }> {
  const { noteCount } = await vaultManager.open(path)
  store.set('vaultPath', path)
  // configure → stop('switch')：上一库还在跑的 pipeline 在这里被杀干净（R2，bug#10）
  await inboxOrchestrator.configure(path)
  const stoppedInbox = inboxOrchestrator.takeStoppedForSwitch()
  await artifactsWatcher.configure(path)
  await ensureRouteFolders(path)
  /**
   * 抖音经营数据是**MCN 专属功能**（笔记落位 `40_带货/抖音经营数据/`）。
   * 除了用户开关，还要这个库的 persona 带 `bizdata` 才跑——否则管理咨询客户
   * 的库里会凭空长出一个「40_带货」目录。开关写死成"只看设置"就等于
   * 埋第二个 MCN 假设（拍板：功能开关跟 persona 走）。
   */
  if (store.get('bizSyncEnabled') && hasFeature(await readVaultConfig(path), 'bizdata')) startBizSync(path)
  return stoppedInbox ? { path, noteCount, stoppedInbox } : { path, noteCount }
}
