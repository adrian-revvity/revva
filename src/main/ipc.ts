/**
 * Typed IPC surface. Renderer never touches node/electron APIs directly.
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { IPC, settingsKeySchema, chatCreateInputSchema, type Workspace } from '@shared/types'
import { openCodeService } from './opencode/service'
import { chatManager } from './opencode/chats'
import { inboxManager } from './opencode/inbox'
import { listAgents, listModels, listSkills } from './opencode/inventory'
import { jiraAuth } from './jira/auth'
import { jiraMcp } from './jira/mcp'
import { fetchBoard } from './jira/board'
import { workManager } from './pipeline/works'
import { reviewManager } from './review'
import { scriptManager } from './scripts'
import { getDb, settingGet, settingSet, roleConfigList, roleConfigSet } from './db'
import { startWorkInputSchema, inboxAnswerSchema, permissionDecisionSchema, scriptInputSchema, roleConfigSchema } from '@shared/types'

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
  ipcMain.handle(IPC.workReviews, (_e, workId: string) => reviewManager.reviewsFor(String(workId)))
  ipcMain.handle(IPC.workReviewStart, async (_e, workId: string) => {
    const round = reviewManager.latestRound(String(workId)) + 1
    await reviewManager.startRound(String(workId), round)
  })

  /* ---------- role config (per-role agent/model defaults) ---------- */
  ipcMain.handle(IPC.roleConfigList, () => roleConfigList())
  ipcMain.handle(IPC.roleConfigSave, (_e, cfg: unknown) => {
    const parsed = roleConfigSchema.parse(cfg)
    roleConfigSet(parsed)
  })
  /* ---------- inbox (M2) ---------- */
  ipcMain.handle(IPC.inboxList, () => inboxManager.list())
  ipcMain.handle(IPC.inboxReplyForm, (_e, sessionId: string, formId: string, answer: unknown) =>
    inboxManager.replyForm(String(sessionId), String(formId), inboxAnswerSchema.parse(answer)))
  ipcMain.handle(IPC.inboxReplyPermission, (_e, sessionId: string, requestId: string, decision: unknown) =>
    inboxManager.replyPermission(String(sessionId), String(requestId), permissionDecisionSchema.parse(decision)))

  /* ---------- scripts (one-click shell, incl. Morning) ---------- */
  ipcMain.handle(IPC.scriptList, () => scriptManager.list())
  ipcMain.handle(IPC.scriptSave, (_e, input: unknown) => scriptManager.save(scriptInputSchema.parse(input)))
  ipcMain.handle(IPC.scriptRemove, (_e, id: string) => scriptManager.remove(String(id)))
  ipcMain.handle(IPC.scriptRun, (_e, id: string) => scriptManager.run(String(id)))
  ipcMain.handle(IPC.scriptKill, (_e, id: string) => scriptManager.kill(String(id)))
  ipcMain.handle(IPC.scriptStatus, () => scriptManager.status())
  ipcMain.handle(IPC.scriptHistory, (_e, id: string) => scriptManager.history(String(id)))
  ipcMain.handle(IPC.scriptProviderNeeds, () => scriptManager.providerNeeds())
}
