import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { openCodeService } from './opencode/service'
import { eventBus } from './opencode/bus'
import { chatManager } from './opencode/chats'
import { inboxManager } from './opencode/inbox'
import { workManager } from './pipeline/works'
import { reviewManager } from './review'
import { scriptManager } from './scripts'
import { jiraAuth } from './jira/auth'
import { jiraMcp } from './jira/mcp'
import { commentWatcher } from './jira/watch'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.setAboutPanelOptions({ applicationName: 'Revva' })
  registerIpc()
  createWindow()

  eventBus.start()
  chatManager.wire()
  workManager.wire()
  inboxManager.wire()
  reviewManager.wire()
  scriptManager.wire()
  commentWatcher.wire()
  void jiraAuth.load().then(() => {
    if (jiraAuth.status().connected) void jiraMcp.connect().catch(() => undefined)
  })
  void openCodeService.ensure().then((status) => {
    if (status.state === 'connected') void chatManager.reconcile()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  eventBus.stop()
  openCodeService.dispose()
  // Running scripts (e.g. a user's proxy) are intentionally left alive.
})
