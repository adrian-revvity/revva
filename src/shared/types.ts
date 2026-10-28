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

/* ---------- Jira board / works ---------- */

export const ticketSchema = z.object({
  key: z.string(),
  id: z.string(),
  summary: z.string(),
  status: z.string(),
  statusCategory: z.string(),
  storyPoints: z.number().optional(),
  issueTypeName: z.string().optional(),
  dependsOn: z.array(z.string()),
  url: z.string().optional()
})
export type Ticket = z.infer<typeof ticketSchema>

export const jiraStatusSchema = z.object({
  connected: z.boolean(),
  expired: z.boolean(),
  expiresAt: z.number().optional(),
  capabilities: z.record(z.string(), z.string().nullish()).optional()
})
export type JiraStatus = z.infer<typeof jiraStatusSchema>

export const workModeSchema = z.enum(['interactive', 'auto'])
export type WorkMode = z.infer<typeof workModeSchema>

export const workStateSchema = z.enum([
  'READY',
  'BUILDING',
  'REVIEW',
  'APPROVED',
  'WAITING_HUMAN',
  'SHIPPED',
  'ABANDONED'
])
export type WorkState = z.infer<typeof workStateSchema>

export const workSummarySchema = z.object({
  id: z.string(),
  ticketKey: z.string(),
  ticketSummary: z.string(),
  repoDir: z.string(),
  branch: z.string(),
  worktreeDir: z.string(),
  parentWorkId: z.string().optional(),
  mode: workModeSchema,
  state: workStateSchema,
  sessionId: z.string().optional(),
  updatedAt: z.number()
})
export type WorkSummary = z.infer<typeof workSummarySchema>

export const startWorkInputSchema = z.object({
  ticketKey: z.string().min(1),
  repoDir: z.string().min(1),
  mode: workModeSchema.default('interactive'),
  agentID: z.string().optional(),
  model: modelRefSchema.optional(),
  parentWorkId: z.string().optional(),
  grill: z.boolean().default(false)
})
export type StartWorkInput = z.infer<typeof startWorkInputSchema>

/* ---------- Inbox (M2) ---------- */

export const inboxFieldSchema = z.object({
  key: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'multiselect']),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })).optional()
})
export type InboxField = z.infer<typeof inboxFieldSchema>

export const pendingItemSchema = z.object({
  kind: z.enum(['form', 'permission']),
  id: z.string(),
  sessionID: z.string(),
  title: z.string(),
  directory: z.string(),
  createdAt: z.number(),
  owner: z.string().optional(),
  fields: z.array(inboxFieldSchema).optional(),
  action: z.string().optional(),
  resources: z.array(z.string()).optional(),
  /** open-ended defaults on fields are preserved verbatim */
  rawFields: z.unknown().optional()
})
export type PendingItem = z.infer<typeof pendingItemSchema>

export const inboxAnswerSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
export const permissionDecisionSchema = z.enum(['once', 'always', 'reject'])

/* ---------- Events pushed main → renderer ---------- */

export const pushEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('service'), status: serviceStatusSchema }),
  z.object({ kind: z.literal('chat.delta'), sessionId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('chat.message'), sessionId: z.string(), message: chatMessageSchema }),
  z.object({ kind: z.literal('chat.idle'), sessionId: z.string() }),
  z.object({ kind: z.literal('chat.tool'), sessionId: z.string(), tool: z.string(), state: z.string() }),
  z.object({ kind: z.literal('work.updated'), workId: z.string(), state: workStateSchema }),
  z.object({ kind: z.literal('work.delta'), workId: z.string(), sessionId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('inbox'), items: z.array(pendingItemSchema) })
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
  jira: {
    status(): Promise<JiraStatus>
    connect(): Promise<{ connected: boolean; expired: boolean; expiresAt?: number }>
    disconnect(): Promise<{ connected: boolean; expired: boolean; expiresAt?: number }>
    board(): Promise<Ticket[]>
  }
  work: {
    start(input: StartWorkInput): Promise<WorkSummary>
    list(): Promise<WorkSummary[]>
    abandon(id: string): Promise<void>
    messages(sessionId: string): Promise<ChatMessage[]>
    prompt(sessionId: string, text: string): Promise<void>
    interrupt(sessionId: string): Promise<void>
  }
  inbox: {
    list(): Promise<PendingItem[]>
    replyForm(sessionId: string, formId: string, answer: Record<string, string | number | boolean | string[]>): Promise<void>
    replyPermission(sessionId: string, requestId: string, decision: 'once' | 'always' | 'reject'): Promise<void>
  }
  events: {
    /** Subscribe to main-process pushes; returns unsubscribe. */
    on(handler: (event: PushEvent) => void): () => void
  }
}
