import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { PushEvent, RevvaApi } from '@shared/types'

const api: RevvaApi = {
  service: {
    status: () => ipcRenderer.invoke(IPC.serviceStatus),
    retry: () => ipcRenderer.invoke(IPC.serviceRetry)
  },
  mcp: {
    list: (directory) => ipcRenderer.invoke(IPC.mcpList, directory),
    reconnect: (server, directory) => ipcRenderer.invoke(IPC.mcpReconnect, server, directory)
  },
  inventory: {
    agents: () => ipcRenderer.invoke(IPC.inventoryAgents),
    models: () => ipcRenderer.invoke(IPC.inventoryModels),
    skills: () => ipcRenderer.invoke(IPC.inventorySkills)
  },
  settings: {
    get: (key) => ipcRenderer.invoke(IPC.settingsGet, key),
    set: (key, value) => ipcRenderer.invoke(IPC.settingsSet, key, value)
  },
  keepAwake: {
    get: () => ipcRenderer.invoke(IPC.keepAwakeGet),
    set: (enabled) => ipcRenderer.invoke(IPC.keepAwakeSet, enabled)
  },
  workspace: {
    list: () => ipcRenderer.invoke(IPC.workspaceList),
    repositories: (id) => ipcRenderer.invoke(IPC.workspaceRepositories, id),
    add: (path) => ipcRenderer.invoke(IPC.workspaceAdd, path),
    remove: (id) => ipcRenderer.invoke(IPC.workspaceRemove, id),
    pickFolder: () => ipcRenderer.invoke(IPC.dialogPickFolder)
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke(IPC.shellOpenExternal, url)
  },
  app: {
    meta: () => ipcRenderer.invoke(IPC.appMeta)
  },
  chat: {
    list: () => ipcRenderer.invoke(IPC.chatList),
    create: (input) => ipcRenderer.invoke(IPC.chatCreate, input),
    messages: (sessionId) => ipcRenderer.invoke(IPC.chatMessages, sessionId),
    prompt: (sessionId, text, images, queued, refs, sentAt) => ipcRenderer.invoke(IPC.chatPrompt, sessionId, text, images, queued, refs, sentAt),
    interrupt: (sessionId) => ipcRenderer.invoke(IPC.chatInterrupt, sessionId),
    rename: (sessionId, title) => ipcRenderer.invoke(IPC.chatRename, sessionId, title),
    setTicket: (sessionId, ticketKey) => ipcRenderer.invoke(IPC.chatSetTicket, sessionId, ticketKey),
    markSeen: (sessionId) => ipcRenderer.invoke(IPC.chatSeen, sessionId),
    remove: (sessionId) => ipcRenderer.invoke(IPC.chatDelete, sessionId)
  },
  session: {
    model: (sessionId) => ipcRenderer.invoke(IPC.sessionModel, sessionId),
    setModel: (sessionId, model) => ipcRenderer.invoke(IPC.sessionSetModel, sessionId, model),
    agent: (sessionId) => ipcRenderer.invoke(IPC.sessionAgent, sessionId),
    setAgent: (sessionId, agentID) => ipcRenderer.invoke(IPC.sessionSetAgent, sessionId, agentID),
    copyId: (sessionId) => ipcRenderer.invoke(IPC.sessionCopyId, sessionId),
    contextUsage: (sessionId) => ipcRenderer.invoke(IPC.sessionContextUsage, sessionId),
    active: () => ipcRenderer.invoke(IPC.sessionActive),
    queue: (sessionId) => ipcRenderer.invoke(IPC.sessionQueue, sessionId),
    cancelQueued: (sessionId, inboxId) => ipcRenderer.invoke(IPC.sessionQueueCancel, sessionId, inboxId),
    promoteQueued: (sessionId, inboxId) => ipcRenderer.invoke(IPC.sessionQueuePromote, sessionId, inboxId)
  },
  worktrees: {
    list: () => ipcRenderer.invoke(IPC.worktreeList),
    preflight: (input) => ipcRenderer.invoke(IPC.worktreePreflight, input),
    remove: (input) => ipcRenderer.invoke(IPC.worktreeRemove, input),
    inspect: (input) => ipcRenderer.invoke(IPC.worktreeInspect, input)
  },
  jira: {
    status: () => ipcRenderer.invoke(IPC.jiraStatus),
    connect: () => ipcRenderer.invoke(IPC.jiraConnect),
    reconnect: () => ipcRenderer.invoke(IPC.jiraReconnect),
    disconnect: () => ipcRenderer.invoke(IPC.jiraDisconnect),
    board: () => ipcRenderer.invoke(IPC.boardFetch),
    subtasks: (key) => ipcRenderer.invoke(IPC.jiraSubtasks, key)
  },
  work: {
    start: (input) => ipcRenderer.invoke(IPC.workStart, input),
    list: () => ipcRenderer.invoke(IPC.workList),
    abandonPreflight: (id) => ipcRenderer.invoke(IPC.workAbandonPreflight, id),
    abandon: (input) => ipcRenderer.invoke(IPC.workAbandon, input),
    messages: (sessionId) => ipcRenderer.invoke(IPC.workMessages, sessionId),
    prompt: (sessionId, text, images, queued, refs, sentAt) => ipcRenderer.invoke(IPC.workPrompt, sessionId, text, images, queued, refs, sentAt),
    interrupt: (sessionId) => ipcRenderer.invoke(IPC.workInterrupt, sessionId),
    reviews: (workId) => ipcRenderer.invoke(IPC.workReviews, workId),
    reviewStart: (workId) => ipcRenderer.invoke(IPC.workReviewStart, workId),
    reviewRetry: (workId, reviewId) => ipcRenderer.invoke(IPC.workReviewRetry, workId, reviewId),
    shipCheck: (workId) => ipcRenderer.invoke(IPC.workShipCheck, workId),
    ship: (workId) => ipcRenderer.invoke(IPC.workShip, workId)
  },
  roleConfig: {
    list: () => ipcRenderer.invoke(IPC.roleConfigList),
    save: (cfg) => ipcRenderer.invoke(IPC.roleConfigSave, cfg)
  },
  comments: {
    pending: () => ipcRenderer.invoke(IPC.commentsPending),
    tackle: (workId) => ipcRenderer.invoke(IPC.commentsTackle, workId)
  },
  github: {
    list: (scope) => ipcRenderer.invoke(IPC.githubList, scope),
    review: (prUrl) => ipcRenderer.invoke(IPC.githubReview, prUrl),
    chat: (prUrl) => ipcRenderer.invoke(IPC.githubChat, prUrl),
    solveConflicts: (prUrl) => ipcRenderer.invoke(IPC.githubSolveConflicts, prUrl),
    solveComments: (prUrl) => ipcRenderer.invoke(IPC.githubSolveComments, prUrl),
    markSeen: (prUrl) => ipcRenderer.invoke(IPC.githubSeen, prUrl),
    alerts: () => ipcRenderer.invoke(IPC.githubAlerts),
    markAlertsSeen: (urls) => ipcRenderer.invoke(IPC.githubAlertsSeen, urls),
    merge: (prUrl, method) => ipcRenderer.invoke(IPC.githubMerge, prUrl, method),
    rebase: (prUrl) => ipcRenderer.invoke(IPC.githubRebase, prUrl),
    detail: (prUrl) => ipcRenderer.invoke(IPC.githubPrDetail, prUrl),
    push: (prUrl, directory) => ipcRenderer.invoke(IPC.githubPush, prUrl, directory),
    stack: (prUrl, directory) => ipcRenderer.invoke(IPC.githubStack, prUrl, directory),
    stackRebase: (prUrl, directory) => ipcRenderer.invoke(IPC.githubStackRebase, prUrl, directory),
    describe: (prUrl, instructions) => ipcRenderer.invoke(IPC.githubDescribe, prUrl, instructions),
    describeSave: (prUrl, original, head, body) => ipcRenderer.invoke(IPC.githubDescribeSave, prUrl, original, head, body)
  },
  task: {
    ticketSession: (input) => ipcRenderer.invoke(IPC.taskTicketSession, input)
  },
  models: {
    favorites: () => ipcRenderer.invoke(IPC.modelsFavorites),
    toggleFavorite: (key) => ipcRenderer.invoke(IPC.modelsFavoriteToggle, key)
  },
  file: {
    find: (sessionId, query) => ipcRenderer.invoke(IPC.fileFind, sessionId, query)
  },
  inbox: {
    list: () => ipcRenderer.invoke(IPC.inboxList),
    replyForm: (sessionId, formId, answer) => ipcRenderer.invoke(IPC.inboxReplyForm, sessionId, formId, answer),
    replyPermission: (sessionId, requestId, decision) => ipcRenderer.invoke(IPC.inboxReplyPermission, sessionId, requestId, decision)
  },
  triage: {
    list: () => ipcRenderer.invoke(IPC.triageList),
    markRead: (source, id) => ipcRenderer.invoke(IPC.triageMarkRead, source, id)
  },
  scripts: {
    list: () => ipcRenderer.invoke(IPC.scriptList),
    save: (input) => ipcRenderer.invoke(IPC.scriptSave, input),
    remove: (id) => ipcRenderer.invoke(IPC.scriptRemove, id),
    run: (id) => ipcRenderer.invoke(IPC.scriptRun, id),
    kill: (id) => ipcRenderer.invoke(IPC.scriptKill, id),
    status: () => ipcRenderer.invoke(IPC.scriptStatus),
    history: (id) => ipcRenderer.invoke(IPC.scriptHistory, id),
    providerNeeds: () => ipcRenderer.invoke(IPC.scriptProviderNeeds)
  },
  events: {
    on(handler: (event: PushEvent) => void) {
      // Payloads are validated in main before sending; zod cannot run in the preload context.
      const listener = (_e: IpcRendererEvent, payload: PushEvent): void => handler(payload)
      ipcRenderer.on(IPC.eventPush, listener)
      return () => ipcRenderer.removeListener(IPC.eventPush, listener)
    }
  }
}

contextBridge.exposeInMainWorld('revva', api)
