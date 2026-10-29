/**
 * Typed IPC surface. Renderer never touches node/electron APIs directly.
 */
import { app, ipcMain, dialog, shell, clipboard, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { IPC, settingsKeySchema, chatCreateInputSchema, modelRefSchema, type Workspace } from '@shared/types'
import { keepAwake } from './keep-awake'
import { openCodeService } from './opencode/service'
import { chatManager } from './opencode/chats'
import { throughputMeter } from './opencode/throughput'
import { inboxManager } from './opencode/inbox'
import { triageManager } from './opencode/triage'
import { listAgents, listModels, listSkills } from './opencode/inventory'
import { jiraAuth } from './jira/auth'
import { jiraMcp } from './jira/mcp'
import { fetchBoard, fetchSubtasks } from './jira/board'
import { commentWatcher } from './jira/watch'
import { workManager } from './pipeline/works'
import { worktreeManager } from './worktrees'
import { reviewManager } from './review'
import { shipManager } from './ship'
import { scriptManager } from './scripts'
import { githubManager } from './github'
import { prDescriptionWriter } from './pr-description'
import { startTicketSession } from './tasks'
import { discoverRepositories } from './repositories'
import { parsePrRef } from '@shared/pr-ref'
import { getDb, settingGet, settingSet, roleConfigList, roleConfigSet, favoriteModels, toggleFavoriteModel } from './db'
import {
  startWorkInputSchema,
  inboxAnswerSchema,
  permissionDecisionSchema,
  prMergeMethodSchema,
  scriptInputSchema,
  roleConfigSchema,
  taskSessionInputSchema,
  promptImageSchema,
  promptRefsSchema,
  worktreeRemoveInputSchema,
  worktreeInspectInputSchema,
  workAbandonInputSchema,
  type PromptImage,
  type PromptRefs
} from '@shared/types'

/** Validate the image array arriving from the renderer (untrusted). */
function promptImageList(images: unknown): PromptImage[] {
  if (!Array.isArray(images)) return []
  return images.map((img) => promptImageSchema.parse(img))
}

/** Validate composer skill/file refs (untrusted); absent or invalid → none. */
function promptRefs(refs: unknown): PromptRefs {
  if (!refs || typeof refs !== 'object') return { skills: [], files: [] }
  return promptRefsSchema.parse(refs)
}

/** Working directory of a chat or work session ('' when unknown) — scopes @-file search. */
function sessionDirectory(sessionId: string): string {
  const chat = getDb().prepare('SELECT directory FROM chat WHERE session_id = ?').get(sessionId) as { directory: string } | undefined
  if (chat) return chat.directory
  const work = getDb().prepare('SELECT worktree_dir AS directory FROM work WHERE session_id = ?').get(sessionId) as
    | { directory: string }
    | undefined
  return work?.directory ?? ''
}

export function registerIpc(): void {
  /* ---------- service ---------- */
  ipcMain.handle(IPC.serviceStatus, () => openCodeService.getStatus())
  ipcMain.handle(IPC.serviceRetry, async () => {
    const status = await openCodeService.ensure()
    if (status.state === 'connected') void chatManager.reconcile()
    return status
  })

  /* ---------- OpenCode MCP connections ---------- */
  ipcMain.handle(IPC.mcpList, async (_e, directory: unknown) => {
    if (directory !== undefined && (typeof directory !== 'string' || !directory.trim())) throw new Error('Invalid MCP location.')
    const result = await openCodeService.api.mcp.list(directory ? { location: { directory: directory as string } } : {})
    return {
      location: result.location.directory,
      servers: result.data.map((server) => ({
        name: server.name,
        title: server.title,
        status: server.status.status,
        error: 'error' in server.status ? server.status.error : undefined
      }))
    }
  })
  ipcMain.handle(IPC.mcpReconnect, async (_e, server: unknown, directory: unknown) => {
    if (typeof server !== 'string' || !server.trim()) throw new Error('Invalid MCP server.')
    if (directory !== undefined && (typeof directory !== 'string' || !directory.trim())) throw new Error('Invalid MCP location.')
    const location = directory ? { directory: directory as string } : undefined
    const current = await openCodeService.api.mcp.list(location ? { location } : {})
    const match = current.data.find((item) => item.name === server)
    if (!match) throw new Error('MCP server is no longer available in this location.')
    if (match.status.status !== 'failed') throw new Error('Only failed MCP connections can be retried here. Refresh status first.')
    await openCodeService.api.mcp.connect({ server, location: { directory: current.location.directory } })
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

  /* ---------- keep awake (caffeinate equivalent) ---------- */
  ipcMain.handle(IPC.keepAwakeGet, () => keepAwake.enabled)
  ipcMain.handle(IPC.keepAwakeSet, (_e, enabled: unknown) => keepAwake.set(enabled === true))

  /* ---------- workspaces (folders revva may target) ---------- */
  ipcMain.handle(IPC.workspaceList, () => {
    const rows = getDb().prepare('SELECT * FROM workspace ORDER BY path').all() as Array<{
      id: string
      path: string
      default_base_branch: string | null
    }>
    return rows.map((r) => ({ id: r.id, path: r.path, defaultBaseBranch: r.default_base_branch ?? undefined }) satisfies Workspace)
  })
  ipcMain.handle(IPC.workspaceRepositories, async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid workspace.')
    const row = getDb().prepare('SELECT path FROM workspace WHERE id = ?').get(id) as { path: string } | undefined
    if (!row) throw new Error('Workspace not found. Refresh Setup and try again.')
    return discoverRepositories(row.path)
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
  ipcMain.handle(IPC.shellOpenExternal, async (_e, url: string) => {
    // Only web links from chat markdown; never file:// or arbitrary schemes.
    try {
      const parsed = new URL(String(url))
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') await shell.openExternal(parsed.toString())
    } catch {
      /* malformed URL — ignore */
    }
  })
  ipcMain.handle(IPC.appMeta, () => {
    // CHANGELOG.md ships inside the app package (see electron-builder files).
    let changelog = ''
    try {
      changelog = readFileSync(join(app.getAppPath(), 'CHANGELOG.md'), 'utf8')
    } catch {
      /* dev mode from a source tree without one — renderer shows a fallback */
    }
    return { version: app.getVersion(), changelog }
  })

  /* ---------- chats ---------- */
  ipcMain.handle(IPC.chatList, () => chatManager.list())
  ipcMain.handle(IPC.chatCreate, (_e, input: unknown) => chatManager.create(chatCreateInputSchema.parse(input)))
  ipcMain.handle(IPC.chatMessages, (_e, sessionId: string) => chatManager.messages(String(sessionId)))
  ipcMain.handle(IPC.chatPrompt, (_e, sessionId: string, text: string, images?: unknown, queued?: unknown, refs?: unknown, sentAt?: unknown) =>
    throughputMeter.measurePrompt(String(sessionId), sentAt, () =>
      chatManager.prompt(String(sessionId), String(text), promptImageList(images), Boolean(queued), promptRefs(refs)))
  )
  ipcMain.handle(IPC.chatInterrupt, (_e, sessionId: string) => chatManager.interrupt(String(sessionId)))
  ipcMain.handle(IPC.chatSeen, (_e, sessionId: string) => {
    chatManager.markSeen(String(sessionId))
    // Opening the session discharges its finished-unread card — re-push the feed.
    triageManager.push()
  })
  ipcMain.handle(IPC.chatRename, (_e, sessionId: string, title: string) => chatManager.rename(String(sessionId), String(title)))
  ipcMain.handle(IPC.chatSetTicket, (_e, sessionId: string, ticketKey: unknown) => {
    if (ticketKey !== null && typeof ticketKey !== 'string') throw new Error('Invalid ticket key.')
    return chatManager.setTicket(String(sessionId), ticketKey)
  })
  ipcMain.handle(IPC.chatDelete, (_e, sessionId: string) => chatManager.remove(String(sessionId)))
  ipcMain.handle(IPC.sessionModel, async (_e, sessionId: string) => {
    const session = await openCodeService.api.session.get({ sessionID: String(sessionId) })
    return session.model ?? null
  })
  // Mid-conversation switches: OpenCode applies them to subsequent provider turns.
  // 'session.model.selected' / 'session.agent.selected' push the refresh; we also
  // keep the local index row honest so lists and /new inherit the new choice.
  ipcMain.handle(IPC.sessionSetModel, async (_e, sessionId: string, model: unknown) => {
    const ref = modelRefSchema.parse(model)
    await openCodeService.api.session.switchModel({ sessionID: String(sessionId), model: ref })
    getDb().prepare('UPDATE chat SET provider_id = ?, model_id = ? WHERE session_id = ?').run(ref.providerID, ref.id, String(sessionId))
  })
  ipcMain.handle(IPC.sessionAgent, async (_e, sessionId: string) => {
    const session = await openCodeService.api.session.get({ sessionID: String(sessionId) })
    return session.agent ?? null
  })
  ipcMain.handle(IPC.sessionSetAgent, async (_e, sessionId: string, agentID: unknown) => {
    const agent = z.string().min(1).max(200).parse(agentID)
    await openCodeService.api.session.switchAgent({ sessionID: String(sessionId), agent })
    getDb().prepare('UPDATE chat SET agent_id = ? WHERE session_id = ?').run(agent, String(sessionId))
  })
  ipcMain.handle(IPC.sessionCopyId, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 500) throw new Error('Invalid session ID.')
    clipboard.writeText(sessionId)
  })
  ipcMain.handle(IPC.sessionContextUsage, async (_e, sessionId: string) => {
    const api = openCodeService.api
    const [messages, session] = await Promise.all([
      api.session.context({ sessionID: String(sessionId) }),
      api.session.get({ sessionID: String(sessionId) })
    ])
    // Context excludes history before compaction. Use the last reported response,
    // not a sum of usage across turns.
    const boundary = session.revert?.messageID
    const end = boundary ? messages.findIndex((message) => message.id === boundary) : messages.length
    if (end < 0) return null
    const last = messages.slice(0, end).findLast((message) => message.type === 'assistant' && message.tokens !== undefined)
    if (!last || last.type !== 'assistant' || !last.tokens) return null
    const usage = last.tokens
    const tokens = usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write
    if (!Number.isFinite(tokens) || tokens <= 0) return null
    const models = await api.model.list({ location: { directory: session.location.directory } }).catch(() => undefined)
    const model = models?.data.find((m) => m.providerID === last.model.providerID && (m.id === last.model.id || m.modelID === last.model.id))
    const limit = model?.limit?.context
    return { tokens, limit: limit && limit > 0 ? limit : undefined, providerID: last.model.providerID, modelID: last.model.id }
  })
  ipcMain.handle(IPC.sessionActive, async () => Object.keys(await openCodeService.api.session.active()))
  ipcMain.handle(IPC.sessionQueue, (_e, sessionId: string) => chatManager.queue(String(sessionId)))
  ipcMain.handle(IPC.sessionQueueCancel, (_e, sessionId: string, inboxId: string) =>
    chatManager.cancelQueued(String(sessionId), String(inboxId))
  )
  ipcMain.handle(IPC.sessionQueuePromote, (_e, sessionId: string, inboxId: string) =>
    chatManager.promoteQueued(String(sessionId), String(inboxId))
  )

  /* ---------- worktree cleanup ---------- */
  ipcMain.handle(IPC.worktreeList, () => worktreeManager.list())
  ipcMain.handle(IPC.worktreePreflight, (_e, input: unknown) => {
    const { repoDir, directory } = worktreeRemoveInputSchema.parse(input)
    return worktreeManager.preflight(repoDir, directory)
  })
  ipcMain.handle(IPC.worktreeRemove, (_e, input: unknown) => {
    const parsed = worktreeRemoveInputSchema.parse(input)
    return worktreeManager.remove(parsed.repoDir, parsed.directory, parsed.confirmedSignature, parsed.confirmed)
  })
  ipcMain.handle(IPC.worktreeInspect, (_e, input: unknown) => {
    const parsed = worktreeInspectInputSchema.parse(input)
    return worktreeManager.inspect(parsed.repoDir, parsed.directory)
  })

  /* ---------- jira ---------- */
  ipcMain.handle(IPC.jiraStatus, () => ({
    ...jiraAuth.status(),
    mcpConnected: jiraMcp.connected,
    capabilities: jiraMcp.connected ? jiraMcp.capabilities() : undefined
  }))
  ipcMain.handle(IPC.jiraConnect, async () => {
    await jiraAuth.connect()
    await jiraMcp.reconnect()
    return jiraAuth.status()
  })
  ipcMain.handle(IPC.jiraReconnect, async () => {
    if (jiraMcp.connected) return
    const auth = jiraAuth.status()
    if (!auth.connected && !auth.expired) throw new Error('Jira is not configured. Sign in first.')
    await jiraMcp.connect()
  })
  ipcMain.handle(IPC.jiraDisconnect, async () => {
    await jiraMcp.disconnect()
    await jiraAuth.disconnect()
    return jiraAuth.status()
  })
  ipcMain.handle(IPC.boardFetch, () => fetchBoard())
  ipcMain.handle(IPC.jiraSubtasks, (_e, key: string) => fetchSubtasks(String(key)))

  /* ---------- works (ticket pipeline) ---------- */
  ipcMain.handle(IPC.workStart, (_e, input: unknown) => workManager.start(startWorkInputSchema.parse(input)))
  ipcMain.handle(IPC.workList, () => workManager.list())
  ipcMain.handle(IPC.workAbandonPreflight, (_e, id: string) => workManager.abandonPreflight(String(id)))
  ipcMain.handle(IPC.workAbandon, (_e, input: unknown) => {
    const parsed = workAbandonInputSchema.parse(input)
    return workManager.abandon(parsed.id, parsed.confirmedSignature, parsed.confirmed)
  })
  ipcMain.handle(IPC.workMessages, (_e, sessionId: string) => chatManager.messages(String(sessionId)))
  ipcMain.handle(IPC.workPrompt, (_e, sessionId: string, text: string, images?: unknown, queued?: unknown, refs?: unknown, sentAt?: unknown) =>
    throughputMeter.measurePrompt(String(sessionId), sentAt, () =>
      workManager.followUp(String(sessionId), String(text), promptImageList(images), Boolean(queued), promptRefs(refs)))
  )
  ipcMain.handle(IPC.workInterrupt, (_e, sessionId: string) => workManager.interrupt(String(sessionId)))
  ipcMain.handle(IPC.workReviews, (_e, workId: string) => reviewManager.reviewsFor(String(workId)))
  ipcMain.handle(IPC.workReviewStart, async (_e, workId: string) => {
    const round = reviewManager.latestRound(String(workId)) + 1
    await reviewManager.startRound(String(workId), round, true)
  })
  ipcMain.handle(IPC.workReviewRetry, (_e, workId: string, reviewId: number) => {
    if (!Number.isSafeInteger(reviewId) || reviewId < 1) throw new Error('Invalid review ID.')
    return reviewManager.retryReview(String(workId), reviewId)
  })
  ipcMain.handle(IPC.workShipCheck, (_e, workId: string) => shipManager.checks(String(workId)))
  ipcMain.handle(IPC.workShip, (_e, workId: string) => shipManager.ship(String(workId)))

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

  /* ---------- triage inbox (finished-unseen feed) ---------- */
  ipcMain.handle(IPC.triageList, () => triageManager.list())
  ipcMain.handle(IPC.triageMarkRead, (_e, source: unknown, id: string) =>
    triageManager.markRead(source === 'work' ? 'work' : 'chat', String(id)))

  /* ---------- comment watcher (M6) ---------- */
  ipcMain.handle(IPC.commentsPending, () => commentWatcher.pending())
  ipcMain.handle(IPC.commentsTackle, (_e, workId: string) => commentWatcher.tackleComments(String(workId)))

  /* ---------- github + task sessions + favorites ---------- */
  ipcMain.handle(IPC.githubList, (_e, scope?: unknown) =>
    githubManager.list(scope === 'review' ? 'review' : 'mine')
  )
  ipcMain.handle(IPC.githubReview, (_e, ref: string) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL or owner/repo#123 (bare numbers are ambiguous across projects).')
    return githubManager.startReview(parsed.url)
  })
  ipcMain.handle(IPC.githubChat, (_e, ref: string) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL.')
    return githubManager.startChat(parsed.url)
  })
  ipcMain.handle(IPC.githubSolveConflicts, (_e, ref: string) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL.')
    return githubManager.solveConflicts(parsed.url)
  })
  ipcMain.handle(IPC.githubSolveComments, (_e, ref: unknown) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL.')
    return githubManager.solveComments(parsed.url)
  })
  ipcMain.handle(IPC.githubSeen, (_e, prUrl: string) => githubManager.markSeen(String(prUrl)))
  ipcMain.handle(IPC.githubAlerts, () => githubManager.alerts())
  ipcMain.handle(IPC.githubAlertsSeen, (_e, urls?: unknown) =>
    githubManager.markAlertsSeen(Array.isArray(urls) ? urls.map(String) : undefined)
  )
  ipcMain.handle(IPC.githubMerge, (_e, ref: unknown, method: unknown) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL or owner/repo#123 (bare numbers are ambiguous across projects).')
    return githubManager.merge(parsed.url, prMergeMethodSchema.parse(method))
  })
  ipcMain.handle(IPC.githubRebase, (_e, ref: unknown) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL or owner/repo#123 (bare numbers are ambiguous across projects).')
    return githubManager.rebase(parsed.url)
  })
  ipcMain.handle(IPC.githubPrDetail, (_e, ref: unknown) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL or owner/repo#123 (bare numbers are ambiguous across projects).')
    return githubManager.detail(parsed.url)
  })
  ipcMain.handle(IPC.githubPush, (_e, ref: unknown, directory: unknown) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL or owner/repo#123 (bare numbers are ambiguous across projects).')
    if (typeof directory !== 'string' || !directory) throw new Error('No conversation directory to push from.')
    return githubManager.push(parsed.url, directory)
  })
  ipcMain.handle(IPC.githubStack, async (_e, ref: unknown, directory?: unknown) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL or owner/repo#123 (bare numbers are ambiguous across projects).')
    // Detection is best-effort (no stack, or no extension, is a null, not an error).
    try {
      return await githubManager.stackForPr(parsed.url, typeof directory === 'string' ? directory : undefined)
    } catch {
      return null
    }
  })
  ipcMain.handle(IPC.githubStackRebase, (_e, ref: unknown, directory: unknown) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL or owner/repo#123 (bare numbers are ambiguous across projects).')
    if (typeof directory !== 'string' || !directory) throw new Error('No checkout to rebase the stack in.')
    return githubManager.rebaseStack(parsed.url, directory)
  })
  ipcMain.handle(IPC.githubDescribe, (_e, ref: unknown, instructions?: unknown) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL or owner/repo#123 (bare numbers are ambiguous across projects).')
    return prDescriptionWriter.describe(parsed.url, typeof instructions === 'string' && instructions.trim() ? instructions : undefined)
  })
  ipcMain.handle(IPC.githubDescribeSave, (_e, ref: unknown, original: unknown, head: unknown, body: unknown) => {
    const parsed = parsePrRef(String(ref))
    if (!parsed?.url) throw new Error('Pass a full PR URL or owner/repo#123 (bare numbers are ambiguous across projects).')
    if (typeof original !== 'string' || typeof head !== 'string' || typeof body !== 'string') throw new Error('Invalid PR description.')
    return prDescriptionWriter.save(parsed.url, original, head, body)
  })
  ipcMain.handle(IPC.taskTicketSession, (_e, input: unknown) => {
    const parsed = taskSessionInputSchema.parse({ ...((input ?? {}) as object), kind: 'ticket' })
    if (parsed.kind !== 'ticket') throw new Error('invalid input')
    return startTicketSession(parsed.ticketKey, parsed.repoDir)
  })
  ipcMain.handle(IPC.modelsFavorites, () => favoriteModels())
  ipcMain.handle(IPC.modelsFavoriteToggle, (_e, key: string) => toggleFavoriteModel(String(key)))
  ipcMain.handle(IPC.fileFind, async (_e, sessionId: string, query: string) => {
    const q = String(query)
    if (!q) return []
    const directory = sessionDirectory(String(sessionId))
    if (!directory) return []
    try {
      const res = await openCodeService.api.file.find({
        location: { directory },
        query: q,
        type: 'file',
        limit: 20
      })
      return res.data.map((entry) => ({ path: entry.path, type: entry.type }))
    } catch {
      // dir missing / service hiccup — the picker just stays empty
      return []
    }
  })

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
