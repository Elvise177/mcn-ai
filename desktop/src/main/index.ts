import './env-hooks'
import { app, BrowserWindow, dialog, Menu } from 'electron'
import { log } from './lib/logger'

process.on('uncaughtException', (e) => log('error', 'main-uncaught', e))
process.on('unhandledRejection', (r) => log('error', 'main-rejection', r instanceof Error ? r : String(r)))
import { join } from 'path'
import { registerIpc, openStoredVault } from './ipc'
import { probeCloud, provisionKeys } from './auth'
import { startSyncRetry } from './knowledge/sync-queue'
import { vaultManager } from './vault'
import { inboxOrchestrator } from './inbox/orchestrator'
import { agentManager } from './agent'
import { artifactsWatcher } from './agent/artifacts'
import { tasks } from './tasks/registry'
import { registerAssetScheme, registerAssetProtocol } from './vault/assets'
import { initUpdater } from './updater'
import { pruneBackups } from './agent/write-backup'
import { clearAttachments, clearAttachmentsSync } from './agent/attachments'

// 库内图片协议：**注册 scheme 必须在 app ready 之前**（Electron 硬性要求），
// handler 在 ready 之后挂。没有它，笔记里抽出来的嵌图在渲染进程里是死链（见 vault/assets.ts）
registerAssetScheme()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: 'SamePage',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#FAF9F5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  vaultManager.attachWindow(win)
  inboxOrchestrator.attachWindow(win)
  agentManager.attachWindow(win)
  artifactsWatcher.attachWindow(win)
  tasks.attachWindow(win)

  // 兜底：拖文件进窗口时 Electron 默认导航到 file://，整个应用被那个文件替换、只能退出重开。
  // 渲染层已在 main.tsx 全局 preventDefault，这里再拦一层（同 URL 放行，别挡住 reload）
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return
    e.preventDefault()
    log('warn', 'nav-blocked', url)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    log('error', 'renderer-gone', details.reason)
    dialog.showErrorBox('SamePage 界面异常', `界面进程异常退出（${details.reason}），即将自动恢复。\n如反复出现，请在设置页导出诊断报告。`)
    win.reload()
  })

  // 云端与密钥相关的启动动作**等界面画出来再做**：恢复会话要解密，
  // 而 safeStorage 在一个进程里的首次调用是同步的、可能几十秒（M-29）。
  // 在 did-finish-load 之前触发它，用户看到的就是一扇白窗
  win.webContents.once('did-finish-load', () => {
    void provisionKeys() // 已登录用户启动时刷新服务端下发的 AI 配置（值没变则零写入）
    void probeCloud() // 云端可达性：探测有超时，Supabase 被暂停时不会把启动拖住
    startSyncRetry() // 上次退出时没同步上去的聊天记录，开机补一轮（退避 1m/5m/30m→转手动）
    initUpdater(win) // 自动更新：内部自带 20 秒延迟，不与上面几件事抢冷启动那一段
    void pruneBackups() // AI 写入备份保留 30 天，启动时清一次（B4）
    /**
     * 上次运行留下的对话附件，开机清掉（B7 发现：`clearAttachments` 导出了却**从没人调**，
     * 于是临时目录一直在累积）。B7 之后躺在里面的不再是缩略图，是**用户的真实文档**——
     * 转出来的 md 里就是文件全文。放着不管等于把客户的资料摊在临时目录里。
     * 退出时也清一次（见 before-quit），两头堵：崩溃退出时开机这次兜底。
     */
    void clearAttachments()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'SamePage',
        submenu: [
          { label: '关于 SamePage', role: 'about' },
          { type: 'separator' },
          { label: '隐藏', role: 'hide' },
          { label: '退出 SamePage', role: 'quit' },
        ],
      },
      {
        label: '文件',
        submenu: [
          {
            label: '新对话',
            accelerator: 'CmdOrCtrl+N',
            click: () => BrowserWindow.getFocusedWindow()?.webContents.send('shortcut', 'new-chat'),
          },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { label: '撤销', role: 'undo' },
          { label: '重做', role: 'redo' },
          { type: 'separator' },
          { label: '剪切', role: 'cut' },
          { label: '复制', role: 'copy' },
          { label: '粘贴', role: 'paste' },
          { label: '全选', role: 'selectAll' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { label: '最小化', role: 'minimize' },
          { label: '缩放', role: 'zoom' },
          { type: 'separator' },
          { label: '重新加载界面', role: 'reload' },
          { label: '开发者工具', role: 'toggleDevTools' },
        ],
      },
    ])
  )
}

app.whenReady().then(() => {
  buildMenu()
  registerIpc()
  registerAssetProtocol()
  createWindow()
  void openStoredVault() // 启动即加载上次的库，工作台首页直接可问
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * 退出前把 pipeline 进程组杀干净（设计 §5.1 第 5 条）。
 *
 * 这是**当前就存在的 bug**，只是没人注意到：spawn 出去的 pipeline 不跟着应用退，
 * 用户以为关掉了应用，实际还有个 Python 在写 vault、烧 LLM 额度。
 * 用 preventDefault 拿回控制权，等 kill 走完（SIGTERM → 3 秒 → SIGKILL）再真的退。
 */
let quitting = false
app.on('before-quit', (e) => {
  // 文件监听必须显式关掉，否则**进程退不掉**。
  // Electron 30 上不关也能退，30 → 43 之后不行了：打开过知识库（= 起了 vault/投递箱/产物
  // 三个 chokidar watcher）的实例调 app.quit() 会挂住，进程一直活着。
  // 二分确认过：不开库秒退、开空库必挂；与 window-all-closed 无关（最小 Electron 应用
  // 复刻同样的 macOS 行为照样秒退）。关掉 watcher 之后恢复正常。
  void vaultManager.close()
  void inboxOrchestrator.stop()
  void artifactsWatcher.stop()
  clearAttachmentsSync() // 对话附件是"仅本轮参考"，不该留在临时目录过夜。**必须同步**：异步版在进程退出前跑不完（B7 走查实测）

  if (quitting || !inboxOrchestrator.hasChild()) return
  quitting = true
  e.preventDefault()
  log('info', 'main', '退出前清理投递箱 pipeline 进程组')
  void inboxOrchestrator.cancel('quit').finally(() => {
    /**
     * **收尾必须走 `app.quit()` 而不是 `app.exit(0)`**（0.1.2 修）。
     *
     * `app.exit(0)` 是立即终止：它跳过 electron-updater 挂在退出流程上的安装动作。
     * 后果是——投递箱正在跑的时候用户点「立即重启」，应用是退了，**更新没装上**，
     * 下次打开还是老版本。`autoInstallOnAppQuit` 那句"重启生效"也跟着变成假话。
     *
     * `quitting` 已经置位，所以再次进 before-quit 会在第一行直接 return，
     * 不会又拦一次；正常退出流程走完，更新才装得上。
     *
     * 仍然留 `app.exit(0)` 兜底：Electron 43 起 watcher 不关就退不掉，
     * 万一还有别的东西挂住进程，3 秒后强制终止——**宁可少装一次更新，也不能退不掉**。
     */
    setTimeout(() => {
      log('warn', 'main', 'app.quit() 3 秒没退掉，强制终止（这次更新不会被安装）')
      app.exit(0)
    }, 3000).unref?.()
    app.quit()
  })
})
