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
  context: z.number().optional(),
  /** Set when the provider's local endpoint (e.g. proxy script) is down — pickers gray out + explain. */
  gated: z.string().optional(),
  /** User favorited it in Setup; pickers pin favorites to the top. */
  favorite: z.boolean().optional()
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
  'reviewMaxRounds',
  'jira.connected',
  'jira.siteUrl',
  'model.favorites',
  'prompt.start',
  'prompt.tackle',
  'prompt.review'
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
  ticketKey: z.string().optional(),
  prUrl: z.string().optional(),
  updatedAt: z.number()
})
export type ChatSummary = z.infer<typeof chatSummarySchema>

export const chatCreateInputSchema = z.object({
  directory: z.string().min(1),
  title: z.string().optional(),
  agentID: z.string().optional(),
  model: modelRefSchema.optional(),
  /** Optional context links — stored on the session and mentioned in a kickoff note. */
  ticketKey: z.string().optional(),
  prUrl: z.string().optional()
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
  'FIXING',
  'APPROVED',
  'WAITING_HUMAN',
  'REWORK',
  'SHIPPED',
  'ABANDONED'
])
export type WorkState = z.infer<typeof workStateSchema>

/* ---------- Review pipeline (M4) ---------- */

/** Read-only reviewer roles, fanned out concurrently each round. */
export const reviewRoleSchema = z.enum(['sol', 'testAudit', 'impeccable'])
export type ReviewRole = z.infer<typeof reviewRoleSchema>

/** Human labels for roles (renderer). */
export const roleLabels: Record<PipelineRole, string> = {
  build: 'Build',
  sol: 'Sol-loop',
  testAudit: 'Test audit',
  impeccable: 'UI review',
  fixer: 'Fixer',
  prReview: 'PR review'
}

/** Pipeline/task roles that take an agent/model selection. */
export const pipelineRoleSchema = z.enum(['build', 'sol', 'testAudit', 'impeccable', 'fixer', 'prReview'])
export type PipelineRole = z.infer<typeof pipelineRoleSchema>

export const roleSelSchema = z.object({
  agentID: z.string().optional(),
  model: modelRefSchema.optional()
})
export type RoleSel = z.infer<typeof roleSelSchema>

/** Role-level default (persisted; every role can be overridden per run). */
export const roleConfigSchema = z.object({
  role: pipelineRoleSchema,
  agentID: z.string().optional(),
  model: modelRefSchema.optional()
})
export type RoleConfig = z.infer<typeof roleConfigSchema>

export const reviewStatusSchema = z.enum(['pending', 'running', 'approved', 'changes', 'error', 'skipped'])
export type ReviewStatus = z.infer<typeof reviewStatusSchema>

export const reviewRowSchema = z.object({
  id: z.number(),
  workId: z.string(),
  round: z.number(),
  role: pipelineRoleSchema,
  sessionId: z.string().optional(),
  status: reviewStatusSchema,
  /** Reviewer's final report (findings or approval notes). */
  findings: z.string(),
  error: z.string().optional(),
  agentID: z.string().optional(),
  model: modelRefSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type ReviewRow = z.infer<typeof reviewRowSchema>

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
  prUrl: z.string().optional(),
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
  grill: z.boolean().default(false),
  /** Push + PR automatically once all review gates approve (opt-in per run). */
  shipOnApprove: z.boolean().default(false),
  /** Per-run reviewer/fixer selections; fall back to role defaults when omitted. */
  reviewSel: z
    .object({
      sol: roleSelSchema.optional(),
      testAudit: roleSelSchema.optional(),
      impeccable: roleSelSchema.optional(),
      fixer: roleSelSchema.optional()
    })
    .optional()
})
export type StartWorkInput = z.infer<typeof startWorkInputSchema>

/* ---------- Comment watcher (M6) ---------- */

export const jiraCommentSchema = z.object({
  workId: z.string(),
  ticketKey: z.string(),
  id: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.number(),
  tackledAt: z.number().optional()
})
export type JiraComment = z.infer<typeof jiraCommentSchema>

/* ---------- Ship (M5) ---------- */

export const shipCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  /** false ⇒ informational only (e.g. Jira offline); undefined/true ⇒ blocks Ship. */
  fatal: z.boolean().optional()
})
export type ShipCheck = z.infer<typeof shipCheckSchema>

export const shipResultSchema = z.object({
  prUrl: z.string(),
  alreadyShipped: z.boolean()
})
export type ShipResult = z.infer<typeof shipResultSchema>

/* ---------- GitHub (M7) ---------- */

export const pullRequestSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  updatedAt: z.number()
})
export type PullRequest = z.infer<typeof pullRequestSchema>

export const prDetailSchema = pullRequestSchema.extend({
  headRefName: z.string(),
  baseRefName: z.string(),
  reviewDecision: z.string().optional(),
  body: z.string().optional()
})
export type PrDetail = z.infer<typeof prDetailSchema>

/** One-click task sessions (board "session" button, GitHub "Review"). */
export const taskSessionInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ticket'), ticketKey: z.string(), repoDir: z.string().optional() }),
  z.object({ kind: z.literal('prReview'), prUrl: z.string() })
])
export type TaskSessionInput = z.infer<typeof taskSessionInputSchema>

export const taskSessionResultSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  directory: z.string()
})
export type TaskSessionResult = z.infer<typeof taskSessionResultSchema>

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

/* ---------- Scripts (user one-click commands, e.g. "morning") ---------- */

export const scriptDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Shell one-liner or path — run with zsh. May be an alias when interactive. */
  command: z.string(),
  cwd: z.string().optional(),
  /** Run through an interactive zsh so .zshrc aliases work. */
  interactive: z.boolean().default(true),
  createdAt: z.number()
})
export type ScriptDef = z.infer<typeof scriptDefSchema>

export const scriptInputSchema = scriptDefSchema.omit({ id: true, createdAt: true }).extend({ id: z.string().optional() })
export type ScriptInput = z.infer<typeof scriptInputSchema>

export interface ScriptStatus {
  id: string
  running: boolean
  lastExit: number | null
  lastRunAt: number | null
  lastDurationMs: number | null
}

export const scriptStatusSchema = z.object({
  id: z.string(),
  running: z.boolean(),
  lastExit: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastDurationMs: z.number().nullable()
})

export interface ScriptRunRow {
  id: number
  scriptId: string
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  outputTail: string
}

/* ---------- Events pushed main → renderer ---------- */

export const pushEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('service'), status: serviceStatusSchema }),
  z.object({ kind: z.literal('chat.delta'), sessionId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('chat.message'), sessionId: z.string(), message: chatMessageSchema }),
  z.object({ kind: z.literal('chat.idle'), sessionId: z.string() }),
  z.object({ kind: z.literal('chat.tool'), sessionId: z.string(), tool: z.string(), state: z.string() }),
  z.object({ kind: z.literal('work.updated'), workId: z.string(), state: workStateSchema }),
  z.object({ kind: z.literal('work.delta'), workId: z.string(), sessionId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('inbox'), items: z.array(pendingItemSchema) }),
  z.object({ kind: z.literal('review.updated'), workId: z.string(), round: z.number(), reviews: z.array(reviewRowSchema) }),
  /** Live streamed text from a reviewer/fixer session. */
  z.object({ kind: z.literal('review.delta'), workId: z.string(), sessionId: z.string(), messageId: z.string(), text: z.string() }),
  /** New Jira comments pending action (M6). */
  z.object({ kind: z.literal('comments'), items: z.array(jiraCommentSchema) }),
  z.object({ kind: z.literal('script.output'), scriptId: z.string(), chunk: z.string() }),
  z.object({ kind: z.literal('script.status'), status: scriptStatusSchema })
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
    abandon(id: string): Promise<string | undefined>
    messages(sessionId: string): Promise<ChatMessage[]>
    prompt(sessionId: string, text: string): Promise<void>
    interrupt(sessionId: string): Promise<void>
    /** Review ledger for one work (all rounds). */
    reviews(workId: string): Promise<ReviewRow[]>
    /** Manually start another review round (e.g. after resolving a blocker). */
    reviewStart(workId: string): Promise<void>
    /** Pre-flight checks for shipping (push/PR/Jira). */
    shipCheck(workId: string): Promise<ShipCheck[]>
    /** Push + PR + Jira sync; opens the PR in the browser. */
    ship(workId: string): Promise<ShipResult>
  }
  roleConfig: {
    list(): Promise<RoleConfig[]>
    save(cfg: RoleConfig): Promise<void>
  }
  comments: {
    /** New (untackled) Jira comments across shipped works. */
    pending(): Promise<JiraComment[]>
    /** Rework session that addresses the alerts, updates the PR, replies on Jira. */
    tackle(workId: string): Promise<void>
  }
  github: {
    /** Open PRs authored by / reviewing for the gh user. */
    list(scope?: 'mine' | 'review'): Promise<PullRequest[]>
    /** Spin up a PR-review agent session (worktree checked out in the background). */
    review(prUrl: string): Promise<TaskSessionResult>
  }
  task: {
    /** Ad-hoc session linked to a ticket (no pipeline), in that ticket's repo or a chosen folder. */
    ticketSession(input: { ticketKey: string; repoDir?: string }): Promise<TaskSessionResult>
  }
  models: {
    favorites(): Promise<string[]>
    /** key = `providerID::modelID`; returns the new favorite list. */
    toggleFavorite(key: string): Promise<string[]>
  }
  inbox: {
    list(): Promise<PendingItem[]>
    replyForm(sessionId: string, formId: string, answer: Record<string, string | number | boolean | string[]>): Promise<void>
    replyPermission(sessionId: string, requestId: string, decision: 'once' | 'always' | 'reject'): Promise<void>
  }
  scripts: {
    list(): Promise<ScriptDef[]>
    save(input: ScriptInput): Promise<ScriptDef>
    remove(id: string): Promise<void>
    run(id: string): Promise<{ ok: boolean }>
    kill(id: string): Promise<void>
    status(): Promise<ScriptStatus[]>
    history(id: string): Promise<ScriptRunRow[]>
    /** Providers gated on a local endpoint (their baseURL is loopback:port). */
    providerNeeds(): Promise<{ providerID: string; baseURL: string; port: number; up: boolean }[]>
  }
  events: {
    /** Subscribe to main-process pushes; returns unsubscribe. */
    on(handler: (event: PushEvent) => void): () => void
  }
}
