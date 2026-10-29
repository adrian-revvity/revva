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
  'jira.commentPollSecs',
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
  updatedAt: z.number(),
  /** Finished a run since the user last opened it (sidebar dot). */
  unread: z.boolean().optional()
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

/** One image rendered inside a transcript bubble (base64 data URL). */
export const chatImageSchema = z.object({
  name: z.string().optional(),
  mime: z.string(),
  data: z.string()
})
export type ChatImage = z.infer<typeof chatImageSchema>

/** A tool invocation summarized from OpenCode message parts. */
export const chatToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(['streaming', 'running', 'completed', 'error']),
  /** One-line summary of the input (command, path, pattern…). */
  detail: z.string().optional(),
  /** Truncated text output or error message. */
  output: z.string().optional()
})
export type ChatToolCall = z.infer<typeof chatToolCallSchema>

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  text: z.string(),
  toolName: z.string().optional(),
  /** Images attached to a user message (composer attachments, pasted screenshots). */
  images: z.array(chatImageSchema).optional(),
  /** One collapsed step per tool call the assistant made (rendered expandable). */
  tools: z.array(chatToolCallSchema).optional(),
  /** Model reasoning/thinking text, when the provider surfaced it. */
  thinking: z.string().optional(),
  createdAt: z.number()
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

/* ---------- Composer attachments ---------- */

const MAX_ATTACHMENTS = 8

/** Renderer sends images as base64 (data URLs or bare base64); main forwards them to OpenCode. */
export const promptImageSchema = z.object({
  name: z.string().max(300).optional(),
  mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z.string().min(1).max(14_000_000)
})
export type PromptImage = z.infer<typeof promptImageSchema>

/** One message waiting in OpenCode's session inbox. */
export const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  imageCount: z.number(),
  createdAt: z.number()
})
export type QueuedMessage = z.infer<typeof queuedMessageSchema>

/* ---------- Worktree cleanup ---------- */

export const worktreeInfoSchema = z.object({
  /** Main checkout that owns the worktree. */
  repoDir: z.string(),
  directory: z.string(),
  branch: z.string().optional(),
  detached: z.boolean().optional(),
  locked: z.string().optional(),
  /** Git says the admin entry is stale (directory gone). */
  prunable: z.boolean().optional(),
  /** Lives under revva's worktree root. */
  inWorktreeRoot: z.boolean(),
  /** A revva work row references this directory. */
  revva: z.boolean(),
  ticketKey: z.string().optional(),
  /** Revva work still live — removal must go through abandon. */
  busy: z.boolean().optional()
})
export type WorktreeInfo = z.infer<typeof worktreeInfoSchema>

export const worktreeRemoveInputSchema = z.object({
  repoDir: z.string().min(1),
  directory: z.string().min(1),
  force: z.boolean().default(true)
})
export type WorktreeRemoveInput = z.infer<typeof worktreeRemoveInputSchema>

/* ---------- Composer autocomplete ---------- */

/** One file hit from `file.find` in the session's directory (slash/@ command menus). */
export const fileHitSchema = z.object({
  path: z.string(),
  type: z.enum(['file', 'directory'])
})
export type FileHit = z.infer<typeof fileHitSchema>

/** A skill or file the composer tokenized out of the message text (`/skill`, `@file`). */
export const promptRefsSchema = z.object({
  skills: z
    .array(z.object({ id: z.string(), name: z.string(), start: z.number().int(), end: z.number().int(), text: z.string() }))
    .max(8)
    .default([]),
  files: z
    .array(z.object({ path: z.string().max(1000), start: z.number().int(), end: z.number().int(), text: z.string().max(1000) }))
    .max(12)
    .default([])
})
export type PromptRefs = z.infer<typeof promptRefsSchema>

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
  blocker: z.string().optional(),
  updatedAt: z.number(),
  /** Pipeline reached a human-relevant state since the user last opened the cockpit. */
  unread: z.boolean().optional()
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
  /** Also ship automatically in interactive mode; AUTO always ships after approval. */
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
  updatedAt: z.number(),
  /** Enriched from GraphQL: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / ... */
  reviewDecision: z.string().optional(),
  /** True when merged (search lists recently-merged PRs too). */
  merged: z.boolean().optional(),
  commentsCount: z.number().optional(),
  /** Unseen (by the user) comments from someone else exist on this PR. */
  hasNewComments: z.boolean().optional(),
  latestOtherCommentAuthor: z.string().optional(),
  latestOtherCommentAt: z.number().optional(),
  /** GraphQL mergeable: MERGEABLE / CONFLICTING / UNKNOWN. */
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional(),
  /** CLEAN / DIRTY / BLOCKED / BEHIND / DRAFT / UNSTABLE / HAS_HOOKS. */
  mergeStateStatus: z.string().optional(),
  /** Became CONFLICTING since the user last looked. */
  hasNewConflicts: z.boolean().optional(),
  /** Review decision became APPROVED since the user last looked. */
  hasNewApproval: z.boolean().optional()
})
export type PullRequest = z.infer<typeof pullRequestSchema>

export const prMergeMethodSchema = z.enum(['squash', 'merge', 'rebase'])
export type PrMergeMethod = z.infer<typeof prMergeMethodSchema>

/** What changed on a PR since the user last acknowledged it (sidebar bell). */
export const prAlertSchema = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  kinds: z.array(z.enum(['comment', 'conflict', 'approval']))
})
export type PrAlert = z.infer<typeof prAlertSchema>

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
  rawFields: z.unknown().optional(),
  /** Tail of the agent's last message before it blocked (card preview). */
  lastMessage: z.string().optional()
})
export type PendingItem = z.infer<typeof pendingItemSchema>

export const inboxAnswerSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
export const permissionDecisionSchema = z.enum(['once', 'always', 'reject'])

/* ---------- Triage inbox (email-style: everything waiting on you) ---------- */

/**
 * A finished run the user has not looked at yet (chat reply or ticket-work
 * outcome). Sits in the triage feed beside pending forms/permissions, ranked
 * below them; dismissed by opening the session or marking it read.
 */
export const finishedRunSchema = z.object({
  sessionID: z.string(),
  source: z.enum(['chat', 'work']),
  /** Ticket works only: cockpit target and pipeline state for the badge. */
  workId: z.string().optional(),
  workState: workStateSchema.optional(),
  /** Chat title or ticket key. */
  owner: z.string(),
  directory: z.string(),
  updatedAt: z.number(),
  /** Full text of the final assistant message, when available. */
  preview: z.string().optional()
})
export type FinishedRun = z.infer<typeof finishedRunSchema>

/** One card in the triage feed: an agent needing an answer, or a finished unread run. */
export const triageEntrySchema = z.union([
  z.object({ type: z.literal('pending'), item: pendingItemSchema }),
  z.object({ type: z.literal('finished'), item: finishedRunSchema })
])
export type TriageEntry = z.infer<typeof triageEntrySchema>

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
  /** OpenCode auto-titled the session from its first message. */
  z.object({ kind: z.literal('chat.renamed'), sessionId: z.string(), title: z.string() }),
  /** Queue contents or the session's selected model changed — renderer refetches. */
  z.object({ kind: z.literal('session.queue'), sessionId: z.string() }),
  z.object({ kind: z.literal('session.model'), sessionId: z.string() }),
  z.object({ kind: z.literal('session.activity'), sessionId: z.string(), running: z.boolean() }),
  z.object({ kind: z.literal('work.updated'), workId: z.string(), state: workStateSchema }),
  z.object({ kind: z.literal('work.delta'), workId: z.string(), sessionId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('inbox'), items: z.array(pendingItemSchema) }),
  /** Ranked triage feed: pending items + finished-unseen runs (pushed on dismissal). */
  z.object({ kind: z.literal('triage'), entries: z.array(triageEntrySchema) }),
  /** Poller found new comments/conflicts/approvals (or their flags cleared). */
  z.object({ kind: z.literal('github.alerts'), items: z.array(prAlertSchema) }),
  z.object({ kind: z.literal('review.updated'), workId: z.string(), round: z.number(), reviews: z.array(reviewRowSchema) }),
  /** Live streamed text from a reviewer/fixer session. */
  z.object({ kind: z.literal('review.delta'), workId: z.string(), sessionId: z.string(), messageId: z.string(), text: z.string() }),
  /** New Jira comments pending action (M6). */
  z.object({ kind: z.literal('comments'), items: z.array(jiraCommentSchema) }),
  z.object({ kind: z.literal('script.output'), scriptId: z.string(), chunk: z.string() }),
  z.object({ kind: z.literal('script.status'), status: z.array(scriptStatusSchema) })
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
    repositories(id: string): Promise<{ paths: string[]; incomplete: boolean }>
    add(path: string): Promise<Workspace>
    remove(id: string): Promise<void>
    pickFolder(): Promise<string | null>
  }
  shell: {
    /** Open an http(s) URL in the user's default browser. */
    openExternal(url: string): Promise<void>
  }
  app: {
    /** App version + bundled CHANGELOG.md text. */
    meta(): Promise<{ version: string; changelog: string }>
  }
  chat: {
    list(): Promise<ChatSummary[]>
    create(input: ChatCreateInput): Promise<ChatSummary>
    messages(sessionId: string): Promise<ChatMessage[]>
    /** `queued` = park in the inbox behind the running turn instead of steering into it. */
    prompt(sessionId: string, text: string, images?: PromptImage[], queued?: boolean, refs?: PromptRefs): Promise<void>
    interrupt(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
    /** Clears the unread dot after the user has looked at the chat. */
    markSeen(sessionId: string): Promise<void>
    remove(sessionId: string): Promise<void>
  }
  session: {
    model(sessionId: string): Promise<(ModelRef & { variant?: string }) | null>
    copyId(sessionId: string): Promise<void>
    contextUsage(sessionId: string): Promise<{ tokens: number; limit?: number; providerID: string; modelID: string } | null>
    active(): Promise<string[]>
    /** Messages waiting in OpenCode's inbox for this session. */
    queue(sessionId: string): Promise<QueuedMessage[]>
    cancelQueued(sessionId: string, inboxId: string): Promise<void>
  }
  worktrees: {
    /** Linked worktrees across known repos (revva-created or not). */
    list(): Promise<WorktreeInfo[]>
    /** Removes the worktree; deletes its branch only when git allows (`-d`). Returns a note. */
    remove(input: WorktreeRemoveInput): Promise<string | undefined>
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
    prompt(sessionId: string, text: string, images?: PromptImage[], queued?: boolean, refs?: PromptRefs): Promise<void>
    interrupt(sessionId: string): Promise<void>
    /** Review ledger for one work (all rounds). */
    reviews(workId: string): Promise<ReviewRow[]>
    /** Manually start another review round (e.g. after resolving a blocker). */
    reviewStart(workId: string): Promise<void>
    /** Retry one reviewer or failed fixer in the latest round. */
    reviewRetry(workId: string, reviewId: number): Promise<void>
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
    /** Open PRs authored by / reviewing for the gh user (plus recently merged in "mine"). */
    list(scope?: 'mine' | 'review'): Promise<PullRequest[]>
    /** Spin up a PR-review agent session (worktree checked out in the background). */
    review(prUrl: string): Promise<TaskSessionResult>
    /** Clear the "new comment/conflict/approval" flags for a PR. */
    markSeen(prUrl: string): Promise<void>
    /** New comments/conflicts/approvals across both scopes (poller-maintained). */
    alerts(): Promise<PrAlert[]>
    /** Clear alert flags; omit urls to clear every current alert. */
    markAlertsSeen(urls?: string[]): Promise<void>
    /** gh pr merge — explicit user action; auto ship still never merges. */
    merge(prUrl: string, method: PrMergeMethod): Promise<void>
    /** Rebase the PR head onto its base and force-with-lease push the update. */
    rebase(prUrl: string): Promise<void>
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
  file: {
    /** Fuzzy file paths in the session's directory, for the composer's @ picker. */
    find(sessionId: string, query: string): Promise<FileHit[]>
  }
  inbox: {
    list(): Promise<PendingItem[]>
    replyForm(sessionId: string, formId: string, answer: Record<string, string | number | boolean | string[]>): Promise<void>
    replyPermission(sessionId: string, requestId: string, decision: 'once' | 'always' | 'reject'): Promise<void>
  }
  triage: {
    /** Ranked feed: pending forms/permissions first, then finished-unseen chats/works. */
    list(): Promise<TriageEntry[]>
    /** Archive a finished-unseen card without opening the session. */
    markRead(source: 'chat' | 'work', id: string): Promise<void>
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
