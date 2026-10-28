/**
 * Shared IPC contract between main, preload, and renderer.
 * Channel names are prefixed `revva:`; payloads are zod-validated in main.
 * NOTE: the preload may only import *types* from this module (and IPC names
 * from ./ipc-channels) — zod itself must never load in the preload context.
 */
import { z } from 'zod'
import { IPC } from './ipc-channels'

export { IPC }

export type ServiceState = 'connecting' | 'connected' | 'missing' | 'error'

export const serviceStatusSchema = z.object({
  state: z.enum(['connecting', 'connected', 'missing', 'error']),
  url: z.string().optional(),
  version: z.string().optional(),
  message: z.string().optional(),
  lastCheckedAt: z.number()
})
export type ServiceStatus = z.infer<typeof serviceStatusSchema>

/* ---------- Inventory ---------- */

export const agentInfoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  mode: z.string().optional()
})
export type AgentInfo = z.infer<typeof agentInfoSchema>

export const modelInfoSchema = z.object({
  providerID: z.string(),
  id: z.string(),
  name: z.string().optional(),
  /** Whether AWS/Bedrock readiness (M3) may be required before use. */
  context: z.number().optional()
})
export type ModelInfo = z.infer<typeof modelInfoSchema>

export const skillInfoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional()
})
export type SkillInfo = z.infer<typeof skillInfoSchema>

/* ---------- Settings / workspaces ---------- */

export const workspaceSchema = z.object({
  id: z.string(),
  path: z.string(),
  defaultBaseBranch: z.string().optional()
})
export type Workspace = z.infer<typeof workspaceSchema>

export const settingsKeySchema = z.enum([
  'generalChat.agentID',
  'generalChat.model',
  'worktreeRoot',
  'autoDefault',
  'jira.connected',
  'jira.siteUrl'
])
export type SettingsKey = z.infer<typeof settingsKeySchema>

export const modelRefSchema = z.object({
  providerID: z.string(),
  id: z.string()
})
export type ModelRef = z.infer<typeof modelRefSchema>

/* ---------- Chat (M0.5 core, started in M0) ---------- */

export const chatSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  directory: z.string(),
  agentID: z.string().optional(),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  updatedAt: z.number()
})
export type ChatSummary = z.infer<typeof chatSummarySchema>

export const chatCreateInputSchema = z.object({
  directory: z.string().min(1),
  title: z.string().optional(),
  agentID: z.string().optional(),
  model: modelRefSchema.optional()
})
export type ChatCreateInput = z.infer<typeof chatCreateInputSchema>

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  text: z.string(),
  toolName: z.string().optional(),
  createdAt: z.number()
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

/* ---------- Events pushed main → renderer ---------- */

export const pushEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('service'), status: serviceStatusSchema }),
  z.object({ kind: z.literal('chat.delta'), sessionId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('chat.message'), sessionId: z.string(), message: chatMessageSchema }),
  z.object({ kind: z.literal('chat.idle'), sessionId: z.string() }),
  z.object({ kind: z.literal('chat.tool'), sessionId: z.string(), tool: z.string(), state: z.string() })
])
export type PushEvent = z.infer<typeof pushEventSchema>

/* ---------- Renderer-facing API surface (implemented in preload) ---------- */

export interface RevvaApi {
  service: {
    status(): Promise<ServiceStatus>
    retry(): Promise<ServiceStatus>
  }
  inventory: {
    agents(): Promise<AgentInfo[]>
    models(): Promise<ModelInfo[]>
    skills(): Promise<SkillInfo[]>
  }
  settings: {
    get(key: SettingsKey): Promise<unknown>
    set(key: SettingsKey, value: unknown): Promise<void>
  }
  workspace: {
    list(): Promise<Workspace[]>
    add(path: string): Promise<Workspace>
    remove(id: string): Promise<void>
    pickFolder(): Promise<string | null>
  }
  chat: {
    list(): Promise<ChatSummary[]>
    create(input: ChatCreateInput): Promise<ChatSummary>
    messages(sessionId: string): Promise<ChatMessage[]>
    prompt(sessionId: string, text: string): Promise<void>
    interrupt(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
    remove(sessionId: string): Promise<void>
  }
  events: {
    /** Subscribe to main-process pushes; returns unsubscribe. */
    on(handler: (event: PushEvent) => void): () => void
  }
}
