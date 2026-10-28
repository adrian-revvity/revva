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
