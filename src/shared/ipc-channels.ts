/**
 * IPC channel names — dependency-free so the preload can import it safely
 * (Electron preload contexts disallow code generation, which zod needs).
 */
export const IPC = {
  serviceStatus: 'revva:service:status',
  serviceRetry: 'revva:service:retry',
  inventoryAgents: 'revva:inventory:agents',
  inventoryModels: 'revva:inventory:models',
  inventorySkills: 'revva:inventory:skills',
  settingsGet: 'revva:settings:get',
  settingsSet: 'revva:settings:set',
  workspaceAdd: 'revva:workspace:add',
  workspaceList: 'revva:workspace:list',
  workspaceRemove: 'revva:workspace:remove',
  chatList: 'revva:chat:list',
  chatCreate: 'revva:chat:create',
  chatPrompt: 'revva:chat:prompt',
  chatInterrupt: 'revva:chat:interrupt',
  chatMessages: 'revva:chat:messages',
  chatRename: 'revva:chat:rename',
  chatDelete: 'revva:chat:delete',
  dialogPickFolder: 'revva:dialog:pick-folder',
  eventPush: 'revva:event'
} as const
