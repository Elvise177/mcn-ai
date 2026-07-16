import './env-hooks'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpc, openStoredVault } from './ipc'
import { vaultManager } from './vault'
import { inboxOrchestrator } from './inbox/orchestrator'
import { agentManager } from './agent'
import { artifactsWatcher } from './agent/artifacts'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: 'mcn-ai',
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

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  void openStoredVault() // 启动即加载上次的库，工作台首页直接可问
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
