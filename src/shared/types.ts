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

export interface McpStatus {
  location: string
  servers: Array<{
    name: string
    title?: string
    status: 'connected' | 'pending' | 'disabled' | 'failed' | 'needs_auth'
    error?: string
  }>
}

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
  'chat.lastSelection',
  'prompt.start',
  'prompt.tackle',
  'prompt.review',
  'prompt.description',
  'watchdog.staleSecs',
  'cards.pinnedOrder',
  'keepAwake.enabled'
])
export type SettingsKey = z.infer<typeof settingsKeySchema>

export const modelRefSchema = z.object({
  providerID: z.string(),
  id: z.string(),
  variant: z.string().optional()
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
  prUrl: z.string().optional(),
  /** Context delivered with the user's first message instead of a kickoff prompt. */
  context: z.string().optional()
})
export type ChatCreateInput = z.infer<typeof chatCreateInputSchema>

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

/** One transcript image: a local attachment URL, or an optimistic base64 data URL. */
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
  output: z.string().optional(),
  /** Raw streamed input prefix length, independent of the truncated summary. */
  inputLength: z.number().optional()
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
  /** Untrimmed prefix lengths for overlap-safe incremental delivery. */
  streamLengths: z.object({ text: z.number(), thinking: z.number() }).optional(),
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

/** One message waiting in OpenCode's session inbox. `steer` items are already
 *  injected into the running turn at the next step boundary; `queue` waits idle. */
export const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  imageCount: z.number(),
  createdAt: z.number(),
  delivery: z.enum(['queue', 'steer'])
})
export type QueuedMessage = z.infer<typeof queuedMessageSchema>

/** Persisted in Revva, not OpenCode's idle build-session inbox. */
export interface WorkFollowUp {
  id: string
  text: string
  imageCount: number
  createdAt: number
  status: 'queued' | 'sending' | 'error'
  error?: string
}

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
  busy: z.boolean().optional(),
  /** The repository's main checkout. Only listed when the caller asks for them; never a removal target. */
  mainCheckout: z.boolean().optional()
})
export type WorktreeInfo = z.infer<typeof worktreeInfoSchema>

/** Branches of one repository, for the conversation's branch picker (`worktrees.branches`). */
export const repoBranchSchema = z.object({
  name: z.string(),
  /** Checked out in the directory the listing was asked for. */
  current: z.boolean(),
  /** Another worktree of the same repo holds it out; git refuses a second checkout. */
  checkedOutIn: z.string().optional(),
  /** Only exists on a remote — selecting it creates the local tracking branch. */
  remoteOnly: z.boolean(),
  /** Whose remote branch this is (undefined for local-only branches). */
  remote: z.string().optional(),
  /** Every remote carrying it when more than one does; git would guess, so Revva refuses. */
  remotes: z.array(z.string()).optional(),
  lastCommitAt: z.number().optional()
})
export type RepoBranch = z.infer<typeof repoBranchSchema>

export const repoBranchListSchema = z.object({
  /** Repository root the listing came from. */
  repoDir: z.string(),
  /** Branch the given directory is on; absent when it is detached or not a checkout. */
  current: z.string().optional(),
  /** True when the directory is the repository's main checkout. */
  mainCheckout: z.boolean(),
  branches: z.array(repoBranchSchema)
})
export type RepoBranchList = z.infer<typeof repoBranchListSchema>

/** The branch listing for one checkout (`worktrees.branches`). */
export const worktreeBranchesInputSchema = z.object({ directory: z.string().min(1).max(2048) })

/** `worktrees.list` options. Main checkouts are off unless asked for: cleanup must never offer them. */
export const worktreeListInputSchema = z.object({ includeMainCheckouts: z.boolean().optional() })

/** Where a conversation works: one of Revva's known worktrees, and the branch to check out there. */
export const conversationCheckoutInputSchema = z.object({
  /** Linked worktree or main checkout to work in; omit to stay where the conversation is. */
  directory: z.string().min(1).optional(),
  /** Branch to check out in that folder (local, or a remote branch to start tracking). */
  branch: z.string().min(1).optional()
})
export type ConversationCheckoutInput = z.infer<typeof conversationCheckoutInputSchema>

/**
 * Read-only proof gathered before any removal (main process, `worktrees.preflight`).
 * A throw means the path must not be touched at all (unprovable or forbidden:
 * main checkout, unregistered — no exceptions, nested, locked, over-limit or
 * unreadable state). A return describes reality: a `missing` folder means at
 * most one stale git registration is cleared (inert); an existing folder means
 * removal destroys files, and `confirmationReasons` counts exactly what
 * (contents are never shown) — `requiresConfirmation` then demands the user's
 * explicit per-worktree confirmation before execution. The `signature` binds
 * not just the porcelain status but the raw Git index state (`diff --cached
 * --raw -z` entries with blob OIDs — staged contents can change while status
 * and disk look untouched) and a per-path content fingerprint (size, mode,
 * inode, mtimeNs, ctimeNs, symlink target strings, nested ignored/untracked
 * content scanned under hard caps), so staging different content or editing an
 * already-dirty or already untracked file between preview and execution voids
 * the confirmation. Removal
 * is still NOT race-free (an exact-mtime rewrite passes the fingerprint, and
 * nothing can stop a writer between the last check and the unlink) — the UI
 * must warn. Execution re-proves everything immediately before acting and
 * refuses on any drift or uncheckable state.
 */
export const worktreeRemovalPreflightSchema = z.object({
  /** Canonical repository root the registration was proven against. */
  repoDir: z.string(),
  /** Canonical worktree path. */
  directory: z.string(),
  branch: z.string().optional(),
  detached: z.boolean(),
  /** The folder provably does not exist; only git's registration may linger. */
  missing: z.boolean(),
  /** Counts of what removal would destroy — every category, contents never shown. */
  trackedDirty: z.number().int().min(0),
  untracked: z.number().int().min(0),
  ignored: z.number().int().min(0),
  /** True when the folder exists and holds anything (tracked / untracked / ignored / detached HEAD) — explicit confirmation required. */
  requiresConfirmation: z.boolean(),
  /** Human-readable destruction warnings shown verbatim, per worktree. */
  confirmationReasons: z.array(z.string()),
  /** Content-bound optimistic-concurrency token; execution re-proves and refuses on any drift. */
  signature: z.string()
})
export type WorktreeRemovalPreflight = z.infer<typeof worktreeRemovalPreflightSchema>

export const worktreeRemoveInputSchema = z.object({
  repoDir: z.string().min(1),
  directory: z.string().min(1),
  /** Must equal the preflight signature the user was shown; any drift voids it. */
  confirmedSignature: z.string().default(''),
  /** The user explicitly confirmed THIS worktree (checked against a fresh requiresConfirmation). */
  confirmed: z.boolean().default(false)
})
export type WorktreeRemoveInput = z.infer<typeof worktreeRemoveInputSchema>

export const workAbandonInputSchema = z.object({
  id: z.string().min(1),
  /** Must equal `work.abandonPreflight().worktree.signature` when it required confirmation. */
  confirmedSignature: z.string().default(''),
  /** The user explicitly confirmed this ticket's worktree removal (checked against a fresh requiresConfirmation). */
  confirmed: z.boolean().default(false)
})
export type WorkAbandonInput = z.infer<typeof workAbandonInputSchema>

/** Everything the abandon confirmation needs: work identity + the worktree proof. */
export const workAbandonPreflightSchema = z.object({
  workId: z.string(),
  ticketKey: z.string(),
  branch: z.string(),
  worktreeDir: z.string(),
  worktree: worktreeRemovalPreflightSchema
})
export type WorkAbandonPreflight = z.infer<typeof workAbandonPreflightSchema>

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
  subtaskCount: z.number().optional(),
  parentKey: z.string().optional(),
  dependsOn: z.array(z.string()),
  url: z.string().optional(),
  /** The raw MCP payload, for fields the DTO does not model yet. */
  raw: z.unknown().optional()
})
export type Ticket = z.infer<typeof ticketSchema>

export const jiraStatusSchema = z.object({
  connected: z.boolean(),
  expired: z.boolean(),
  mcpConnected: z.boolean().optional(),
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
  prReview: 'PR review',
  prDescription: 'PR description'
}

/** Pipeline/task roles that take an agent/model selection. */
export const pipelineRoleSchema = z.enum(['build', 'sol', 'testAudit', 'impeccable', 'fixer', 'prReview', 'prDescription'])
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
  /** Latest real execution event; kept in memory while this app is running. */
  activity: z.string().optional(),
  lastActivityAt: z.number().optional(),
  error: z.string().optional(),
  agentID: z.string().optional(),
  model: modelRefSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type ReviewRow = z.infer<typeof reviewRowSchema>

/** Outcome of a conversation checkout switch: the refreshed work row plus what git actually did. */
export interface ConversationCheckoutResult {
  /** The conversation's utilities, re-anchored to the new folder/branch. Absent for an unlinked chat. */
  work: WorkSummary | null
  note: string
}

export const workSummarySchema = z.object({
  id: z.string(),
  ticketKey: z.string(),
  ticketSummary: z.string(),
  repoDir: z.string(),
  branch: z.string(),
  worktreeDir: z.string(),
  /** False for a pipeline attached to an existing conversation/folder. */
  ownsWorktree: z.boolean().optional(),
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
  hasNewApproval: z.boolean().optional(),
  /** Enriched head/base refs. Stacked PRs have a base that is another branch. */
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  /** Repository default branch (enriched) — base !== this means the PR stacks on something. */
  defaultBranch: z.string().optional(),
  /** Open review threads the user still has to answer (enriched). */
  unresolvedThreads: z.number().optional(),
  /** More unresolved threads than when the user last looked. */
  hasNewReviewThreads: z.boolean().optional()
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
  kinds: z.array(z.enum(['comment', 'conflict', 'approval', 'review']))
})
export type PrAlert = z.infer<typeof prAlertSchema>

export const prDetailSchema = pullRequestSchema.extend({  headRefName: z.string(),
  baseRefName: z.string(),
  reviewDecision: z.string().optional(),
  body: z.string().optional()
})
export type PrDetail = z.infer<typeof prDetailSchema>

/** One layer of a `gh stack` stack as reported by `gh stack view --json`. */
export const prStackBranchSchema = z.object({
  name: z.string(),
  isCurrent: z.boolean().optional(),
  isMerged: z.boolean().optional(),
  needsRebase: z.boolean().optional(),
  pr: z.object({ number: z.number(), url: z.string(), state: z.string() }).optional()
})
export type PrStackBranch = z.infer<typeof prStackBranchSchema>

/** A stack containing the PR, discovered via local checkouts (`gh stack view --json`). */
export const prStackSchema = z.object({
  /** The checkout the stack was read from. */
  directory: z.string(),
  trunk: z.string().optional(),
  currentBranch: z.string().optional(),
  branches: z.array(prStackBranchSchema)
})
export type PrStack = z.infer<typeof prStackSchema>

/** An AI-written PR description awaiting the user's review in the dialog. */
export interface PrDescriptionDraft {
  /** The body as it is on GitHub right now. */
  original: string
  /** Full new body: AI section inside Revva markers, user text preserved. */
  proposed: string
  /** Head sha the draft was built from (stale-save guard). */
  head: string
  /** 'ai' wrote it; 'template' fell back to the commit list with the reason in `note`. */
  source: 'ai' | 'template'
  note?: string
  /** `provider/model` when a role default chose one. */
  model?: string
  ticketKey?: string
}

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

export const throughputSnapshotSchema = z.object({
  sessionId: z.string(),
  tokensPerSecond: z.number(),
  totalTokens: z.number(),
  estimated: z.boolean(),
  elapsedMs: z.number(),
  msSinceOutput: z.number().nullable(),
  toolIdleMs: z.number(),
  modelIdleMs: z.number(),
  running: z.boolean()
})
export type ThroughputSnapshot = z.infer<typeof throughputSnapshotSchema>

/** A refresh includes the overlap row so a mutable last step is reconciled. */
export interface TranscriptPage {
  messages: ChatMessage[]
  reset: boolean
  /** Active drafts whose prefix was missed/evicted; wait for authoritative data. */
  missingPrefixes?: string[]
}

export interface TranscriptAttachment { epoch: string; sequence: number }
const transcriptUpdateSchema = z.object({
  messageId: z.string(),
  partId: z.string(),
  field: z.enum(['text', 'thinking', 'tool']),
  offset: z.number().optional(),
  text: z.string().optional(),
  tool: chatToolCallSchema.optional(),
  createdAt: z.number()
})
export type TranscriptUpdate = z.infer<typeof transcriptUpdateSchema>

export const pushEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('service'), status: serviceStatusSchema }),
  z.object({ kind: z.literal('mcp.changed') }),
  z.object({ kind: z.literal('inventory.models') }),
  z.object({ kind: z.literal('transcript.batch'), sessionId: z.string(), epoch: z.string(), sequence: z.number(), updates: z.array(transcriptUpdateSchema), diagnostic: z.boolean() }),
  z.object({ kind: z.literal('transcript.reset'), sessionId: z.string(), epoch: z.string() }),
  z.object({ kind: z.literal('session.metrics'), sessionId: z.string() }),
  z.object({ kind: z.literal('chat.delta'), sessionId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('chat.message'), sessionId: z.string(), message: chatMessageSchema }),
  z.object({ kind: z.literal('chat.idle'), sessionId: z.string() }),
  z.object({ kind: z.literal('chat.tool'), sessionId: z.string(), tool: z.string(), state: z.string() }),
  /** OpenCode auto-titled the session from its first message. */
  z.object({ kind: z.literal('chat.renamed'), sessionId: z.string(), title: z.string() }),
  /** Queue contents or the session's selected model changed — renderer refetches. */
  z.object({ kind: z.literal('session.queue'), sessionId: z.string() }),
  z.object({ kind: z.literal('session.model'), sessionId: z.string() }),
  z.object({ kind: z.literal('session.agent'), sessionId: z.string() }),
  z.object({ kind: z.literal('session.activity'), sessionId: z.string(), running: z.boolean() }),
  z.object({ kind: z.literal('session.transcript'), sessionId: z.string(), reset: z.boolean().optional() }),
  /** Output tokens / elapsed time since Send; frozen when the interaction ends. */
  z.object({ kind: z.literal('session.throughput'), items: z.array(throughputSnapshotSchema) }),
  z.object({ kind: z.literal('work.updated'), workId: z.string(), state: workStateSchema }),
  z.object({ kind: z.literal('work.queue'), workId: z.string() }),
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
  mcp: {
    list(directory?: string): Promise<McpStatus>
    reconnect(server: string, directory?: string): Promise<void>
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
  keepAwake: {
    /** Whether the display/system sleep is currently being held off (caffeinate equivalent). */
    get(): Promise<boolean>
    set(enabled: boolean): Promise<boolean>
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
    messages(sessionId: string, since?: string, requestId?: string): Promise<TranscriptPage>
    /** `queued` = park in the inbox behind the running turn instead of steering into it. */
    prompt(sessionId: string, text: string, images?: PromptImage[], queued?: boolean, refs?: PromptRefs, sentAt?: number): Promise<void | 'queued'>
    interrupt(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
    setTicket(sessionId: string, ticketKey: string | null): Promise<void>
    /** Clears the unread dot after the user has looked at the chat. */
    markSeen(sessionId: string): Promise<void>
    remove(sessionId: string): Promise<void>
  }
  session: {
    subscribe(sessionId: string, token: string): Promise<TranscriptAttachment>
    unsubscribe(token: string): Promise<void>
    cancelRequest(requestId: string): Promise<void>
    latestAnswer(sessionId: string, generation: number, requestId: string): Promise<string | null>
    performanceFrame(delayMs: number): Promise<void>
    model(sessionId: string): Promise<(ModelRef & { variants?: string[] }) | null>
    /** Switch the model for subsequent provider turns (live, mid-conversation). */
    setModel(sessionId: string, model: ModelRef): Promise<void>
    /** Current agent of the session (null = service default). */
    agent(sessionId: string): Promise<string | null>
    /** Switch the agent for subsequent provider turns (live, mid-conversation). */
    setAgent(sessionId: string, agentID: string): Promise<void>
    copyId(sessionId: string): Promise<void>
    contextUsage(sessionId: string): Promise<{ tokens: number; limit?: number; providerID: string; modelID: string } | null>
    active(): Promise<string[]>
    /** Messages waiting in OpenCode's inbox for this session. */
    queue(sessionId: string): Promise<QueuedMessage[]>
    cancelQueued(sessionId: string, inboxId: string): Promise<void>
    /** Promote a queued message to steer delivery — the running agent reads it at the next step boundary. */
    promoteQueued(sessionId: string, inboxId: string): Promise<void>
  }
  worktrees: {
    /** Linked worktrees across known repos (revva-created or not). Main checkouts are included on request. */
    list(input?: { includeMainCheckouts?: boolean }): Promise<WorktreeInfo[]>
    /** Branches of the repository owning a directory, with each branch's worktree occupancy. */
    branches(input: { directory: string }): Promise<RepoBranchList>
    /** Read-only safety proof for one removal path; throws a refusal when the path is not safe. */
    preflight(input: { repoDir: string; directory: string }): Promise<WorktreeRemovalPreflight>
    /** Removes the worktree; deletes its branch only when git allows (`-d`). Returns a note. */
    remove(input: WorktreeRemoveInput): Promise<string | undefined>
    /** Opens an agent chat that checks every worktree for work that would be lost, cleans up the safe ones, and reports the rest. */
    cleanupChat(): Promise<TaskSessionResult>
  }
  jira: {
    status(): Promise<JiraStatus>
    connect(): Promise<{ connected: boolean; expired: boolean; expiresAt?: number }>
    reconnect(): Promise<void>
    disconnect(): Promise<{ connected: boolean; expired: boolean; expiresAt?: number }>
    board(): Promise<Ticket[]>
    /** Sub-tickets of one issue, in board order. */
    subtasks(key: string): Promise<Ticket[]>
  }
  work: {
    start(input: StartWorkInput): Promise<WorkSummary>
    list(): Promise<WorkSummary[]>
    /** Shared utilities for an existing conversation, regardless of its Jira/PR properties. */
    conversationContext(sessionId: string, directory?: string): Promise<WorkSummary>
    /** Move a conversation to a known worktree and/or switch its branch; git refuses unsafe switches. */
    setCheckout(sessionId: string, input: ConversationCheckoutInput): Promise<ConversationCheckoutResult>
    /** Read-only proof of what abandoning would destroy (worktree safety + notes). */
    abandonPreflight(id: string): Promise<WorkAbandonPreflight>
    abandon(input: WorkAbandonInput): Promise<string | undefined>
    messages(sessionId: string, since?: string, requestId?: string): Promise<TranscriptPage>
    prompt(sessionId: string, text: string, images?: PromptImage[], queued?: boolean, refs?: PromptRefs, sentAt?: number): Promise<void | 'queued'>
    promptNow(sessionId: string, text: string, images?: PromptImage[], refs?: PromptRefs): Promise<void>
    queue(workId: string): Promise<WorkFollowUp[]>
    editQueued(workId: string, id: string, text: string, refs?: PromptRefs): Promise<void>
    cancelQueued(workId: string, id: string): Promise<void>
    sendQueuedNow(workId: string, id: string): Promise<void>
    interrupt(sessionId: string): Promise<void>
    /** Review ledger for one work (all rounds). */
    reviews(workId: string): Promise<ReviewRow[]>
    /** Manually start another review round (e.g. after resolving a blocker). */
    reviewStart(workId: string): Promise<void>
    /** Retry one reviewer or failed fixer in the latest round. */
    reviewRetry(workId: string, reviewId: number): Promise<void>
    /** Stop reviewers/fixer, including sessions still running after a restart. No deletion. */
    reviewStop(workId: string): Promise<void>
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
    /** New chat linked to the PR (+ its ticket), checked out at the PR's branch; opens directly. */
    chat(prUrl: string): Promise<TaskSessionResult>
    /** Start a writable chat in an isolated worktree to resolve PR conflicts. */
    solveConflicts(prUrl: string): Promise<TaskSessionResult>
    /** Chat on the PR's branch that fixes, answers and resolves unresolved review threads. */
    solveComments(prUrl: string): Promise<TaskSessionResult>
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
    /** Current state of one PR (conflicts, review decision, mergeability) for the header's PR menu. */
    detail(prUrl: string): Promise<PrDetail>
    /** Push a conversation's worktree HEAD to the PR head branch (never force). */
    push(prUrl: string, directory: string): Promise<void>
    /** The gh-stack stack containing this PR (from local checkouts), or null when unstacked. */
    stack(prUrl: string, directory?: string): Promise<PrStack | null>
    /** `gh stack rebase` in the checkout tracking the stack; aborts cleanly on conflict. */
    stackRebase(prUrl: string, directory: string): Promise<string>
    /** AI-write the PR's description section (user text outside Revva's markers is kept). */
    describe(prUrl: string, instructions?: string): Promise<PrDescriptionDraft>
    /** Save a reviewed draft; fails when the PR moved since the draft was made. */
    describeSave(prUrl: string, original: string, head: string, body: string): Promise<void>
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
