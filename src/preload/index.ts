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
    add: (path) => ipcRenderer.invoke(IPC.workspaceAdd, path),
    remove: (id) => ipcRenderer.invoke(IPC.workspaceRemove, id),
    pickFolder: () => ipcRenderer.invoke(IPC.dialogPickFolder)
  },
  chat: {
    list: () => ipcRenderer.invoke(IPC.chatList),
    create: (input) => ipcRenderer.invoke(IPC.chatCreate, input),
    messages: (sessionId) => ipcRenderer.invoke(IPC.chatMessages, sessionId),
    prompt: (sessionId, text) => ipcRenderer.invoke(IPC.chatPrompt, sessionId, text),
    interrupt: (sessionId) => ipcRenderer.invoke(IPC.chatInterrupt, sessionId),
    rename: (sessionId, title) => ipcRenderer.invoke(IPC.chatRename, sessionId, title),
    remove: (sessionId) => ipcRenderer.invoke(IPC.chatDelete, sessionId)
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
    prompt: (sessionId, text) => ipcRenderer.invoke(IPC.workPrompt, sessionId, text),
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
