/**
 * Typed IPC surface. Renderer never touches node/electron APIs directly.
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { IPC, settingsKeySchema, chatCreateInputSchema, type Workspace } from '@shared/types'
import { openCodeService } from './opencode/service'
import { chatManager } from './opencode/chats'
import { listAgents, listModels, listSkills } from './opencode/inventory'
import { jiraAuth } from './jira/auth'
import { jiraMcp } from './jira/mcp'
import { fetchBoard } from './jira/board'
import { workManager } from './pipeline/works'
import { getDb, settingGet, settingSet } from './db'
import { startWorkInputSchema } from '@shared/types'

export function registerIpc(): void {
  /* ---------- service ---------- */
  ipcMain.handle(IPC.serviceStatus, () => openCodeService.getStatus())
  ipcMain.handle(IPC.serviceRetry, async () => {
    const status = await openCodeService.ensure()
    if (status.state === 'connected') void chatManager.reconcile()
    return status
  })

  /* ---------- inventory ---------- */
  ipcMain.handle(IPC.inventoryAgents, () => listAgents())
  ipcMain.handle(IPC.inventoryModels, () => listModels())
  ipcMain.handle(IPC.inventorySkills, () => listSkills())

  /* ---------- settings ---------- */
  ipcMain.handle(IPC.settingsGet, (_e, key: string) => {
    settingsKeySchema.parse(key)
    return settingGet(key) ?? null
  })
  ipcMain.handle(IPC.settingsSet, (_e, key: string, value: unknown) => {
    settingsKeySchema.parse(key)
    settingSet(key, value)
  })

  /* ---------- workspaces (folders revva may target) ---------- */
  ipcMain.handle(IPC.workspaceList, () => {
    const rows = getDb().prepare('SELECT * FROM workspace ORDER BY path').all() as Array<{
      id: string
      path: string
      default_base_branch: string | null
    }>
    return rows.map((r) => ({ id: r.id, path: r.path, defaultBaseBranch: r.default_base_branch ?? undefined }) satisfies Workspace)
  })
  ipcMain.handle(IPC.workspaceAdd, (_e, path: string) => {
    const resolved = path.trim()
    const isDir = (() => {
      try {
        return statSync(resolved).isDirectory()
      } catch {
        return false
      }
    })()
    if (!isDir) throw new Error(`Not a directory: ${resolved}`)
    const id = randomUUID()
    getDb().prepare('INSERT OR IGNORE INTO workspace(id, path) VALUES(?, ?)').run(id, resolved)
    const row = getDb().prepare('SELECT * FROM workspace WHERE path = ?').get(resolved) as {
      id: string
      path: string
      default_base_branch: string | null
    }
    return { id: row.id, path: row.path, defaultBaseBranch: row.default_base_branch ?? undefined } satisfies Workspace
  })
  ipcMain.handle(IPC.workspaceRemove, (_e, id: string) => {
    getDb().prepare('DELETE FROM workspace WHERE id = ?').run(id)
  })
  ipcMain.handle(IPC.dialogPickFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a project folder'
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  /* ---------- chats ---------- */
  ipcMain.handle(IPC.chatList, () => chatManager.list())
  ipcMain.handle(IPC.chatCreate, (_e, input: unknown) => chatManager.create(chatCreateInputSchema.parse(input)))
  ipcMain.handle(IPC.chatMessages, (_e, sessionId: string) => chatManager.messages(String(sessionId)))
  ipcMain.handle(IPC.chatPrompt, (_e, sessionId: string, text: string) => chatManager.prompt(String(sessionId), String(text)))
  ipcMain.handle(IPC.chatInterrupt, (_e, sessionId: string) => chatManager.interrupt(String(sessionId)))
  ipcMain.handle(IPC.chatRename, (_e, sessionId: string, title: string) => chatManager.rename(String(sessionId), String(title)))
  ipcMain.handle(IPC.chatDelete, (_e, sessionId: string) => chatManager.remove(String(sessionId)))

  /* ---------- jira ---------- */
  ipcMain.handle(IPC.jiraStatus, () => ({
    ...jiraAuth.status(),
    capabilities: jiraMcp.connected ? jiraMcp.capabilities() : undefined
  }))
  ipcMain.handle(IPC.jiraConnect, async () => {
    await jiraAuth.connect()
    await jiraMcp.connect()
    return jiraAuth.status()
  })
  ipcMain.handle(IPC.jiraDisconnect, async () => {
    await jiraMcp.disconnect()
    await jiraAuth.disconnect()
    return jiraAuth.status()
  })
  ipcMain.handle(IPC.boardFetch, () => fetchBoard())

  /* ---------- works (ticket pipeline) ---------- */
  ipcMain.handle(IPC.workStart, (_e, input: unknown) => workManager.start(startWorkInputSchema.parse(input)))
  ipcMain.handle(IPC.workList, () => workManager.list())
  ipcMain.handle(IPC.workAbandon, (_e, id: string) => workManager.abandon(String(id)))
  ipcMain.handle(IPC.workMessages, (_e, sessionId: string) => chatManager.messages(String(sessionId)))
  ipcMain.handle(IPC.workPrompt, (_e, sessionId: string, text: string) => workManager.followUp(String(sessionId), String(text)))
  ipcMain.handle(IPC.workInterrupt, (_e, sessionId: string) => workManager.interrupt(String(sessionId)))
}
