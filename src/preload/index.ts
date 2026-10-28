import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { PushEvent, RevvaApi } from '@shared/types'

const api: RevvaApi = {
  service: {
    status: () => ipcRenderer.invoke(IPC.serviceStatus),
    retry: () => ipcRenderer.invoke(IPC.serviceRetry)
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
    prompt: (sessionId, text, images, queued, refs) => ipcRenderer.invoke(IPC.chatPrompt, sessionId, text, images, queued, refs),
    interrupt: (sessionId) => ipcRenderer.invoke(IPC.chatInterrupt, sessionId),
    rename: (sessionId, title) => ipcRenderer.invoke(IPC.chatRename, sessionId, title),
    markSeen: (sessionId) => ipcRenderer.invoke(IPC.chatSeen, sessionId),
    remove: (sessionId) => ipcRenderer.invoke(IPC.chatDelete, sessionId)
  },
  session: {
    model: (sessionId) => ipcRenderer.invoke(IPC.sessionModel, sessionId),
    contextUsage: (sessionId) => ipcRenderer.invoke(IPC.sessionContextUsage, sessionId),
    active: () => ipcRenderer.invoke(IPC.sessionActive),
    queue: (sessionId) => ipcRenderer.invoke(IPC.sessionQueue, sessionId),
    cancelQueued: (sessionId, inboxId) => ipcRenderer.invoke(IPC.sessionQueueCancel, sessionId, inboxId)
  },
  worktrees: {
    list: () => ipcRenderer.invoke(IPC.worktreeList),
    remove: (input) => ipcRenderer.invoke(IPC.worktreeRemove, input)
  },
  jira: {
    status: () => ipcRenderer.invoke(IPC.jiraStatus),
    connect: () => ipcRenderer.invoke(IPC.jiraConnect),
    disconnect: () => ipcRenderer.invoke(IPC.jiraDisconnect),
    board: () => ipcRenderer.invoke(IPC.boardFetch)
  },
  work: {
    start: (input) => ipcRenderer.invoke(IPC.workStart, input),
    list: () => ipcRenderer.invoke(IPC.workList),
    abandon: (id) => ipcRenderer.invoke(IPC.workAbandon, id),
    messages: (sessionId) => ipcRenderer.invoke(IPC.workMessages, sessionId),
    prompt: (sessionId, text, images, queued, refs) => ipcRenderer.invoke(IPC.workPrompt, sessionId, text, images, queued, refs),
    interrupt: (sessionId) => ipcRenderer.invoke(IPC.workInterrupt, sessionId),
    reviews: (workId) => ipcRenderer.invoke(IPC.workReviews, workId),
    reviewStart: (workId) => ipcRenderer.invoke(IPC.workReviewStart, workId),
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
    markSeen: (prUrl) => ipcRenderer.invoke(IPC.githubSeen, prUrl)
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
