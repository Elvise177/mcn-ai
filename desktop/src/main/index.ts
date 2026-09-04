import './env-hooks'
import { app, BrowserWindow, dialog, Menu, screen } from 'electron'
import { log } from './lib/logger'

process.on('uncaughtException', (e) => log('error', 'main-uncaught', e))
process.on('unhandledRejection', (r) => log('error', 'main-rejection', r instanceof Error ? r : String(r)))
import { join } from 'path'
import { registerIpc, openStoredVault } from './ipc'
import { store } from './store'
import { pickBounds } from './lib/window-bounds'
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

const DEFAULT_BOUNDS = { width: 1440, height: 920 }

/**
 * 恢复上次的窗口几何（F25）。判据在 `lib/window-bounds.ts`（纯函数，零花费可验）——
 * 最要命的那条分支「上次记的坐标现在整个在屏幕外」要插拔显示器才触发得到。
 *
 * 第二扇窗口（Cmd+N）不吃这份几何，按系统默认级联偏移放，否则两扇窗完全重叠、
 * 看着像只开了一个。
 */
function restoredBounds(): { x?: number; y?: number; width: number; height: number } {
  return pickBounds(
    store.get('windowBounds'),
    screen.getAllDisplays().map((d) => d.workArea),
    DEFAULT_BOUNDS
  )
}

/** 主窗口（第一扇）才记几何：多窗口时记谁的都是错的，记第一扇最接近"用户常用的那个大小" */
let primaryWin: BrowserWindow | null = null

function rememberBounds(win: BrowserWindow): void {
  if (win !== primaryWin || win.isDestroyed()) return
  // 最大化时 getBounds() 回的是最大化后的尺寸；直接存它，取消最大化就再也回不到原尺寸
  const maximized = win.isMaximized()
  const prev = store.get('windowBounds')
  const b = maximized && prev ? prev : win.getBounds()
  store.set('windowBounds', { x: b.x, y: b.y, width: b.width, height: b.height, maximized })
}

function createWindow(): BrowserWindow {
  const first = !primaryWin || primaryWin.isDestroyed()
  const win = new BrowserWindow({
    ...(first ? restoredBounds() : DEFAULT_BOUNDS),
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
  if (first) {
    primaryWin = win
    if (store.get('windowBounds')?.maximized) win.maximize()
    /**
     * 落盘走**去抖**：拖动窗口时 resize/move 每帧都来，每帧写一次 config.json
     * 等于把磁盘当日志用。关窗那一下再同步存一次，保证最后的状态一定落得到。
     */
    let t: NodeJS.Timeout | null = null
    const later = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(() => rememberBounds(win), 500)
      t.unref?.()
    }
    win.on('resize', later)
    win.on('move', later)
    win.on('close', () => {
      if (t) clearTimeout(t)
      rememberBounds(win)
    })
  }

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
    // **只有第一扇窗口做这些启动动作**：Cmd+N 开第二扇窗时再跑一遍
    // 等于重新 provision、重新起同步定时器、重新挂更新检查，纯属重复劳动还可能互相打架
    if (win !== primaryWin) return
    void provisionKeys() // 已登录用户启动时刷新服务端下发的 AI 配置（值没变则零写入）
    void probeCloud() // 云端可达性：探测有超时，Supabase 被暂停时不会把启动拖住
    startSyncRetry() // 上次退出时没同步上去的聊天记录，开机补一轮（退避 1m/5m/30m→转手动）
    initUpdater() // 自动更新：内部自带 20 秒延迟，不与上面几件事抢冷启动那一段
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
  return win
}

/**
 * 把一个快捷键动作转给**当前聚焦的那扇窗口**的渲染层。
 * 菜单项是唯一权威的快捷键注册处——渲染层自己 `addEventListener('keydown')` 抢
 * Cmd 系组合键的话，输入框里按 Cmd+A 之类的系统行为会被顺手吃掉。
 */
const toFocused =
  (name: string) =>
  (_item?: unknown, fromWindow?: Electron.BaseWindow): void => {
    /**
     * 目标窗口按这个顺序找：**菜单系统告诉我们的那扇 → 当前聚焦的 → 第一扇**。
     *
     * 只写 `getFocusedWindow()` 的话有一整类情况会静默无效：应用没有 OS 焦点时
     * 它回 null（走查驱动的窗口、从 Dock 菜单触发、以及 macOS 上菜单栏抢焦点的那一瞬），
     * 于是快捷键"按了没反应"——而这正是这一批要消灭的那种故障
     * （2026-09-04 走查现场：Cmd+K 的菜单项点了，面板不出来）。
     */
    const from = BrowserWindow.getAllWindows().find((w) => w.id === (fromWindow as BrowserWindow | undefined)?.id)
    const target = from ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    target?.webContents.send('shortcut', name)
  }

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'SamePage',
        submenu: [
          { label: '关于 SamePage', role: 'about' },
          { type: 'separator' },
          // Cmd+, 是 macOS 上"打开设置"的通用键位，用户会盲按（F8）
          { label: '设置…', accelerator: 'CmdOrCtrl+,', click: toFocused('settings') },
          { type: 'separator' },
          { label: '隐藏', role: 'hide' },
          { label: '退出 SamePage', role: 'quit' },
        ],
      },
      {
        label: '文件',
        submenu: [
          /**
           * **Cmd+N = 新窗口，Cmd+T = 新对话**（2026-09-03 改，用户点名要 Cmd+N 开新窗口）。
           * 原来 Cmd+N 是新对话——那是 IM 的习惯，而这个产品的窗口是"一个工作台"，
           * 同时看两个库/两轮活儿是真实需求。新对话挪到 Cmd+T（同浏览器新标签页的直觉）。
           */
          { label: '新窗口', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
          { label: '新对话', accelerator: 'CmdOrCtrl+T', click: toFocused('new-chat') },
          { type: 'separator' },
          // Cmd+W 关窗但**不退应用**（macOS 惯例，F10）：后台任务继续跑，Dock 上点一下就回来
          { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', role: 'close' },
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
          { type: 'separator' },
          // Cmd+F 在**当前这一屏**里找：对话页找聊天内容、知识库页找笔记
          { label: '查找', accelerator: 'CmdOrCtrl+F', click: toFocused('find') },
        ],
      },
      {
        label: '前往',
        submenu: [
          // Cmd+K：搜对话 / 搜笔记 / 敲命令，一个入口（F5 + F8 合并成这一颗）
          { label: '命令面板…', accelerator: 'CmdOrCtrl+K', click: toFocused('palette') },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { label: '最小化', role: 'minimize' },
          { label: '缩放', role: 'zoom' },
          { type: 'separator' },
          // F25：界面缩放。老板拿 13 寸笔记本看的就是这一档
          { label: '放大', role: 'zoomIn' },
          { label: '缩小', role: 'zoomOut' },
          { label: '实际大小', role: 'resetZoom' },
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
  /**
   * 管理器只在这儿"接一次"。下行事件全部走 `lib/windows.ts` 的 broadcast——
   * 原来是每建一扇窗就 `attachWindow(win)` 覆盖一遍，Cmd+N 开第二扇的那一刻
   * 第一扇就再也收不到任何事件了（而表现是"界面静静地不动"，最难查）。
   */
  vaultManager.attachWindow()
  inboxOrchestrator.attachWindow()
  agentManager.attachWindow()
  artifactsWatcher.attachWindow()
  tasks.attachWindow()
  createWindow()
  void openStoredVault() // 启动即加载上次的库，工作台首页直接可问
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * **关窗不退**（F10，macOS 惯例）。
 *
 * 这不只是"守个平台规矩"：投递箱一批资料要跑几分钟，用户关掉窗口去干别的，
 * 应用一起退了的话那一轮就断在半路（而他以为只是把窗口收起来了）。
 * 后台照常跑，做完发系统通知，Dock 上点一下窗口就回来（见下面的 activate）。
 * 真要退有菜单里那颗「退出 SamePage」，走的是完整的 before-quit 清理链。
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
  else log('info', 'main', '窗口已全部关闭；后台任务继续，Dock 上点一下即可回来')
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
  void inboxOrchestrator.stop('quit')
  void artifactsWatcher.stop()
  clearAttachmentsSync() // 对话附件是"仅本轮参考"，不该留在临时目录过夜。**必须同步**：异步版在进程退出前跑不完（B7 走查实测）
  /**
   * 生成中的对话也要停（PLAN-v2 R2 / 审计 Q4）：SDK 的 CLI 子进程不随主进程退，
   * 以前退出时 live 表里的 AbortController 一个都没被 abort，孤儿 CLI 继续跑完那一轮、继续计费。
   * abort 是同步的（SDK 收到信号就 kill 子进程），不用像 pipeline 那样 preventDefault 等它
   */
  const aborted = agentManager.abortAll('quit')
  if (aborted) log('info', 'main', `退出前中止了 ${aborted} 个生成中的对话`)

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
