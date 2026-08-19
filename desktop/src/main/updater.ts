import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { log } from './lib/logger'

/**
 * 自动更新（electron-updater / generic provider）。
 *
 * 策略 = **提示后更新，不静默**：
 *   后台静默下载 → 下完在界面顶部挂一条「新版本已就绪，重启生效」→ 用户点「立即重启」才换版本。
 *   下载期间界面上什么都不出（下载失败也不出）——更新链路的任何故障都不许打扰正在干活的人。
 *
 * 三条硬约定（改这层前先看）：
 * ① **占位源不发请求**：更新源 URL 现在是占位（见 electron-builder.yml 的 publish.url），
 *    真实的阿里云 OSS 地址用户稍后给。占位期间整条链路直接跳过——否则每台客户机
 *    每 4 小时往一个不存在的域名打一次请求，日志里堆一串 ENOTFOUND，看着像产品坏了。
 *    切真实源的步骤写在 docs/RELEASE.md §C。
 * ② **push 尽力而为、snapshot 才是权威**（同任务层的约定）：`update:ready` 事件在窗口
 *    reload 期间会静默丢，所以渲染层每次挂载都要先 `update:state` 打底。
 * ③ **只在打包形态生效**：dev 下 electron-updater 没有 app-update.yml，调它只会抛。
 */

/** 占位源的标记。真实源换上去之后这个判断自然失效（`.invalid` 是 RFC 2606 保留后缀，永远解析不了） */
const PLACEHOLDER_MARK = '.invalid'

/** 启动后延迟这么久再查更新：让位给 safeStorage 冷调用与首屏渲染（M-29） */
const FIRST_CHECK_DELAY_MS = 20_000
/** 之后的复查间隔 */
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

type UpdateState = { ready: boolean; version: string | null; disabledReason: string | null }

let state: UpdateState = { ready: false, version: null, disabledReason: null }
let win: BrowserWindow | null = null
let timer: NodeJS.Timeout | null = null

export function updateState(): UpdateState {
  return state
}

/** 读打包进 resources 的 app-update.yml，拿到这台机器实际会去查的更新源 */
function feedUrl(): string | null {
  try {
    const yml = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
    return /^\s*url:\s*(\S+)/m.exec(yml)?.[1] ?? null
  } catch {
    return null
  }
}

function push(): void {
  win?.webContents.send('update:ready', state)
}

export function initUpdater(window: BrowserWindow): void {
  win = window

  if (!app.isPackaged) {
    state = { ...state, disabledReason: 'dev 形态无 app-update.yml' }
    return
  }

  const url = feedUrl()
  if (!url) {
    state = { ...state, disabledReason: '未找到 app-update.yml' }
    log('warn', 'updater', '包里没有 app-update.yml，自动更新关闭')
    return
  }
  if (url.includes(PLACEHOLDER_MARK)) {
    state = { ...state, disabledReason: '更新源仍是占位地址' }
    log('info', 'updater', `更新源是占位地址（${url}），本次不查更新。切换步骤见 docs/RELEASE.md §C`)
    return
  }

  // 延迟到这里再 require：占位/dev 形态下连模块都不加载，省一次磁盘与初始化
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')

  autoUpdater.autoDownload = true
  // 用户点「立即重启」是主路径；但他要是直接 Cmd+Q 了，下次启动也该是新版本——
  // 否则界面上那句「重启生效」就成了假话。
  // 注意：投递箱有活时 before-quit 走的是 app.exit(0)，会跳过这条安装；
  // 那种情况下更新包留在缓存里，下次启动秒出同一条提示，不会丢。
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m: unknown) => log('info', 'updater', m),
    warn: (m: unknown) => log('warn', 'updater', m),
    error: (m: unknown) => log('error', 'updater', m),
    debug: () => {},
  }

  autoUpdater.on('update-downloaded', (info) => {
    state = { ready: true, version: info.version, disabledReason: null }
    log('info', 'updater', `新版本已下载完成：${info.version}`)
    push()
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  })

  // 更新链路的失败**永远不上界面**：客户在离线/内网环境里照常干活，
  // 一条查不到更新的红条只会让他去查网络。
  autoUpdater.on('error', (e) => log('warn', 'updater', e instanceof Error ? e.message : String(e)))

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((e) => log('warn', 'updater', `查更新失败：${String(e)}`))
  }
  setTimeout(check, FIRST_CHECK_DELAY_MS)
  timer = setInterval(check, RECHECK_INTERVAL_MS)
  log('info', 'updater', `自动更新已启用，源：${url}`)
}

/** 渲染层点「立即重启」走这里 */
export function installUpdateNow(): { ok: boolean; error?: string } {
  if (!state.ready) return { ok: false, error: '还没有下载好的更新' }
  try {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    // isSilent=false（安装器可见）、isForceRunAfter=true（装完自动开回来）
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return { ok: true }
  } catch (e) {
    log('error', 'updater', e instanceof Error ? e : String(e))
    return { ok: false, error: String(e) }
  }
}
