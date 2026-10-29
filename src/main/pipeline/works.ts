/**
 * Work: one ticket run = worktree + branch + OpenCode build session.
 * Uses OpenCode's worktree API where possible, falls back to plain `git worktree add`.
 * Dependency (stacked) work branches from the parent work's branch.
 *
 * M1 scope: READY → BUILDING with a live session. Review/ship phases arrive in M4/M5;
 * the state machine fields are already persisted so resume works from day one.
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { join, basename, dirname, resolve } from 'node:path'
import { BrowserWindow } from 'electron'
import { openCodeService, describeError } from '../opencode/service'
import { eventBus, type RawEvent } from '../opencode/bus'
import { getTicket } from '../jira/board'
import { getDb, settingGet } from '../db'
import { sessionIndex } from '../opencode/session-index'
import { streamBuffer } from '../opencode/stream-buffer'
import { pushToWindows } from '../push'
import { notifyInbound } from '../notify'
import { collectAdfText, fetchLastAssistantText, isConflict, promptImageFiles } from '../util'
import { reviewManager } from '../review'
import { shipManager } from '../ship'
import { throughputMeter } from '../opencode/throughput'
import { performRemoval, preflightWorktreeRemoval, probeActiveAgentsInside, requireAbsenceOfAgents, staleConfirmationError } from '../worktree-safety'
import { checkoutBranch, listRepoBranches } from '../branches'
import { renderPrompt, DEFAULT_START_PROMPT, BUILD_COMPLETION_INSTRUCTIONS } from '@shared/prompts'
import {
  IPC,
  type ConversationCheckoutResult,
  type PromptImage,
  type PromptRefs,
  type StartWorkInput,
  type WorkAbandonPreflight,
  type WorkState,
  type WorkFollowUp,
  type WorkSummary
} from '@shared/types'
import { fileAttachments, skillAttachments } from '../opencode/prompt-refs'
import { skillGuardRules } from '../opencode/skill-guard'

const exec = promisify(execFile)

interface WorkRow {
  id: string
  ticket_key: string
  workspace_id: string
  repo_dir: string
  branch: string
  worktree_dir: string
  owns_worktree: number
  parent_work_id: string | null
  mode: string
  state: string
  session_id: string | null
  review_sel: string | null
  ship_on_approve: number | null
  blocker: string | null
  pr_url: string | null
  seen_at: number | null
  created_at: number
  updated_at: number
  review_after_followup: number
}

interface FollowUpRow {
  id: string
  work_id: string
  text: string
  images: string
  refs: string
  status: WorkFollowUp['status']
  error: string | null
  created_at: number
}

function slugBranch(key: string): string {
  return `revva/${key.toLowerCase()}`
}

/** States where the last move came from the pipeline, not from you — these flag unread. */
export const UNREAD_WORTHY_STATES = new Set(['APPROVED', 'WAITING_HUMAN', 'REWORK', 'SHIPPED'])

/** Human phrasing for the OS notification body. */
function stateLabel(state: WorkState): string {
  switch (state) {
    case 'APPROVED': return 'approved'
    case 'WAITING_HUMAN': return 'needs you'
    case 'REWORK': return 'rework requested'
    case 'SHIPPED': return 'shipped'
    default: return state.toLowerCase()
  }
}

class WorkManager {
  private wired = false
  /** Invalidate an async completion check when a new turn/follow-up starts. */
  private buildRevisions = new Map<string, number>()
  private prompting = new Set<string>()
  private draining = new Set<string>()
  private deferredCompletions = new Map<string, { work: WorkRow; revision: number }>()

  wire(): void {
    if (this.wired) return
    this.wired = true
    // Never replay an ambiguously delivered prompt after a crash.
    getDb().prepare("UPDATE work_followup SET status = 'error', error = 'Revva restarted during delivery. Check the conversation before retrying; the message may already have arrived.' WHERE status = 'sending'").run()
    eventBus.on('event', (e: RawEvent) => this.onEvent(e))
  }

  list(): WorkSummary[] {
    const rows = getDb().prepare('SELECT * FROM work ORDER BY updated_at DESC').all() as WorkRow[]
    return rows.map((r) => this.toSummary(r))
  }

  private toSummary(r: WorkRow): WorkSummary {
    const ticket = getDb()
      .prepare('SELECT summary FROM ticket WHERE key = ?')
      .get(r.ticket_key) as { summary: string } | undefined
    return {
      id: r.id,
      ticketKey: r.ticket_key,
      ticketSummary: ticket?.summary ?? (r.ticket_key || (getDb().prepare('SELECT title FROM chat WHERE session_id = ?').get(r.session_id) as { title: string } | undefined)?.title || r.branch),
      repoDir: r.repo_dir,
      branch: r.branch,
      worktreeDir: r.worktree_dir,
      ownsWorktree: r.owns_worktree !== 0,
      parentWorkId: r.parent_work_id ?? undefined,
      mode: r.mode as WorkSummary['mode'],
      state: r.state as WorkSummary['state'],
      sessionId: r.session_id ?? undefined,
      prUrl: r.pr_url ?? undefined,
      blocker: r.blocker ?? undefined,
      updatedAt: r.updated_at,
      unread: (r.seen_at ?? 0) < r.updated_at && UNREAD_WORTHY_STATES.has(r.state)
    }
  }

  /** Session identity, not the shared Jira key, determines pipeline ownership. */
  forSession(sessionId: string): WorkSummary | undefined {
    const work = this.workBySession(sessionId)
    return work && work.state !== 'ABANDONED' ? this.toSummary(work) : undefined
  }

  /** Lightweight utility state shared by Jira- and PR-linked conversations.
   *  No session creation, agent prompt, checkout or file operation happens here. */
  async conversationContext(sessionId: string, directory?: string): Promise<WorkSummary> {
    const chat = getDb().prepare('SELECT ticket_key, directory, pr_url FROM chat WHERE session_id = ?').get(sessionId) as
      { ticket_key: string | null; directory: string; pr_url: string | null } | undefined
    if (!chat) throw new Error('Conversation not found.')
    const existing = this.workBySession(sessionId)
    if (!chat.ticket_key && !chat.pr_url && (!existing || existing.state === 'ABANDONED')) throw new Error('Link this conversation to a Jira ticket or PR to enable its review utilities.')
    if (existing && existing.state !== 'ABANDONED' && !directory) {
      sessionIndex.register(sessionId, 'work')
      return this.toSummary(existing)
    }
    if (existing && existing.state !== 'ABANDONED') {
      if (existing.state === 'SHIPPED') throw new Error('The shipped run’s review folder cannot be reassigned. Start another linked conversation for new work.')
      if (reviewManager.isBusyReviewing(existing.id) || shipManager.isShipping(existing.id) || this.isPrompting(existing.id) || this.hasFollowUps(existing.id)) throw new Error('Stop review and send or remove saved follow-ups before changing the review folder.')
      await reviewManager.requireStoppedReviews(existing.id)
    }
    const [session, active] = await Promise.all([
      openCodeService.api.session.get({ sessionID: sessionId }),
      openCodeService.api.session.active()
    ])
    const folder = directory ? await realpath(directory) : session.location.directory
    let worktreeDir = folder
    let repoDir = folder
    let branch = ''
    let blocker: string | undefined
    try {
      worktreeDir = (await exec('git', ['-C', folder, 'rev-parse', '--show-toplevel'])).stdout.trim()
      const common = (await exec('git', ['-C', worktreeDir, 'rev-parse', '--git-common-dir'])).stdout.trim()
      repoDir = dirname(resolve(worktreeDir, common))
      branch = (await exec('git', ['-C', worktreeDir, 'branch', '--show-current'])).stdout.trim()
      if (!branch) blocker = 'This conversation is on detached HEAD. Check out a branch before review or shipping.'
    } catch {
      blocker = 'Choose a Git repository or worktree for this conversation before reviewing or shipping. Its transcript and files stay where they are.'
    }
    if (existing && existing.state !== 'ABANDONED') {
      if (reviewManager.isBusyReviewing(existing.id) || shipManager.isShipping(existing.id) || this.isPrompting(existing.id) || this.hasFollowUps(existing.id)) throw new Error('Review, shipping or a follow-up started while selecting the folder; retry once it finishes.')
      if (existing.pr_url && existing.branch && (existing.repo_dir !== repoDir || existing.branch !== branch)) throw new Error('This conversation is linked to a PR. Choose that PR’s existing repository and branch, not an unrelated checkout.')
    }
    // Recheck after the service/FS probes: the user may have unlinked meanwhile.
    const linked = getDb().prepare('SELECT ticket_key FROM chat WHERE session_id = ?').get(sessionId) as { ticket_key: string | null } | undefined
    if (!linked || linked.ticket_key !== chat.ticket_key) throw new Error('Conversation properties changed while loading its utilities; retry.')
    // Concurrent opens must share the same review state, not create two runs.
    const latest = this.forSession(sessionId)
    if (latest && !directory) return latest
    if (latest && latest.id !== existing?.id) throw new Error('Conversation settings changed; retry selecting the review folder.')
    const now = Date.now()
    const state: WorkState = sessionId in active ? 'BUILDING' : 'WAITING_HUMAN'
    const id = existing && existing.state !== 'ABANDONED' ? existing.id : randomUUID()
    if (existing && existing.state !== 'ABANDONED') {
      getDb().prepare('UPDATE work SET repo_dir = ?, worktree_dir = ?, branch = ?, state = ?, blocker = ?, owns_worktree = 0, parent_work_id = NULL, review_head = NULL, review_base = NULL, updated_at = ? WHERE id = ?')
        .run(repoDir, worktreeDir, branch, state, blocker ?? null, now, id)
    } else {
      getDb().prepare(`INSERT INTO work(id, ticket_key, repo_dir, branch, worktree_dir, owns_worktree, mode, state, session_id, pr_url, blocker, created_at, updated_at)
        VALUES(?,?,?,?,?,0,'interactive',?,?,?,?,?,?)`)
        .run(id, chat.ticket_key ?? '', repoDir, branch, worktreeDir, state, sessionId, chat.pr_url, blocker ?? null, now, now)
    }
    sessionIndex.register(sessionId, 'work')
    this.emit(id, state)
    return this.toSummary(getDb().prepare('SELECT * FROM work WHERE id = ?').get(id) as WorkRow)
  }

  /**
   * Point a conversation at one of Revva's known worktrees and/or check a branch out
   * in it — both picked from lists Revva already has, never by navigating folders.
   *
   * The conversation's own OpenCode session is moved (`session.move`), so the agent
   * works where the user picked, and the transcript stays where it was: messages are
   * not touched, nothing is deleted, no branch is renamed. Revva's review anchor is
   * re-read from git by re-running `conversationContext`, so review/ship follow the
   * new checkout instead of the folder they happened to see last.
   *
   * Refusals all happen before the first write and say so: a running response, a
   * live review/ship/follow-up, a shipped run, a PR-linked conversation (those stay
   * on the PR's repository and branch), an agent or terminal inside the folder being
   * moved into, a dirty checkout when a branch is requested, a branch another worktree
   * holds, a branch name two remotes both carry. Git is then asked with plain
   * `checkout`/`checkout --track` only: it can discard or rewrite nothing, and its own
   * refusal is reported verbatim.
   */
  async setCheckout(sessionId: string, input: { directory?: string; branch?: string }): Promise<ConversationCheckoutResult> {
    const chat = getDb().prepare('SELECT ticket_key, pr_url FROM chat WHERE session_id = ?').get(sessionId) as
      | { ticket_key: string | null; pr_url: string | null }
      | undefined
    if (!chat) throw new Error('Conversation not found.')
    const branch = input.branch?.trim()
    const wanted = input.directory?.trim()
    if (!wanted && !branch) throw new Error('Pick a worktree or a branch first.')

    const work = this.workBySession(sessionId)
    if (work && work.state !== 'ABANDONED') {
      if (work.state === 'SHIPPED') throw new Error('This run shipped from its checkout. Start another linked conversation to work somewhere else.')
      if (this.isPrompting(work.id) || this.hasFollowUps(work.id)) throw new Error('Send or remove the saved follow-ups before changing where this conversation works.')
      if (reviewManager.isBusyReviewing(work.id) || reviewManager.isStartingReview(work.id)) throw new Error('Stop review before changing where this conversation works.')
      if (shipManager.isShipping(work.id)) throw new Error('Shipping is in progress; wait for it to finish before changing where this conversation works.')
      await reviewManager.requireStoppedReviews(work.id)
    }

    const api = openCodeService.api
    const session = await api.session.get({ sessionID: sessionId })
    const from = await realpath(session.location.directory).catch(() => session.location.directory)
    let to = from
    if (wanted) {
      try {
        to = await realpath(wanted)
      } catch {
        throw new Error(`That worktree is gone: ${wanted}. Nothing was changed.`)
      }
    }
    if (to === from && !branch) return { work: work && work.state !== 'ABANDONED' ? this.toSummary(work) : null, note: 'Already working there — nothing changed.' }

    // The target must be a checkout this repository registered, and the branch must be
    // one the picker could have offered (current, free, local or on exactly one remote).
    // Both are proven before the first write; `checkoutBranch` proves them again right
    // before git runs, because the user may have changed things in another window.
    if (chat.pr_url && branch) throw new Error('This conversation is linked to a PR, so it stays on the PR’s branch. Pick its worktree instead, or open another conversation for a different branch.')
    const inventory = await listRepoBranches(to)
    if (branch) {
      const found = inventory.branches.find((b) => b.name === branch)
      if (!found) throw new Error(`No branch named ${branch} in ${inventory.repoDir}, locally or on a remote. Nothing was changed.`)
      if (found.checkedOutIn) throw new Error(`Branch ${branch} is checked out in ${found.checkedOutIn}. Git allows one checkout per branch — pick that worktree instead. Nothing was changed.`)
      if (found.remotes) throw new Error(`${branch} exists on ${found.remotes.length} remotes (${found.remotes.join(', ')}). Revva will not guess which one — nothing was changed.`)
    }
    // A PR-linked run keeps working on its PR's repository and branch, so refuse a
    // worktree that would move it off them *before* the session moves, not after.
    if (chat.pr_url && work && work.state !== 'ABANDONED' && work.branch) {
      if (inventory.repoDir !== work.repo_dir || (inventory.current && inventory.current !== work.branch)) {
        throw new Error(`This conversation is linked to a PR, so it works in ${work.repo_dir} on ${work.branch}. Pick a worktree of that branch, or open another conversation. Nothing was changed.`)
      }
    }

    // A response in flight would keep working in the folder we are leaving, and an
    // agent or terminal inside the folder we are moving into (or switching in place)
    // would meet a checkout change under its feet. The folder being left is not
    // probed: nothing is written there, and an unrelated session in it keeps its own work.
    const active = await api.session.active().catch(() => undefined)
    if (!active) throw new Error('The OpenCode service could not be consulted about running sessions — nothing was changed.')
    if (sessionId in active) throw new Error('This conversation is answering right now. Stop the response before changing its worktree or branch.')
    const proof = await probeActiveAgentsInside(to)
    if (!proof.free) throw new Error(`Nothing was changed: ${to} — ${proof.reason}.`)

    let note = ''
    if (to !== from) {
      await api.session.move({ sessionID: sessionId, directory: to })
      getDb().prepare('UPDATE chat SET directory = ? WHERE session_id = ?').run(to, sessionId)
      note = `Now working in ${to}`
    }
    if (branch) {
      const switchNote = await checkoutBranch(to, branch)
      note = note ? `${note}. ${switchNote}` : switchNote
    }

    // Re-read the checkout (folder, repository, branch, detached state) from git so
    // review and shipping follow the new state instead of the last one they saw.
    const linked = chat.ticket_key || chat.pr_url || (work && work.state !== 'ABANDONED')
    let refreshed: WorkSummary | null = null
    if (linked) {
      try {
        refreshed = await this.conversationContext(sessionId, to)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(`${note ? `${note}. ` : ''}Revva could not re-read that checkout: ${reason} Nothing was lost — reopen Details to see where it stands.`)
      }
    }
    if (!note) note = 'Nothing changed.'
    return { work: refreshed, note: note.endsWith('.') ? note : `${note}.` }
  }

  /** Removing a conversation never deletes its folder or branch. */
  async forgetConversation(sessionId: string): Promise<void> {
    const work = this.workBySession(sessionId)
    if (!work || work.state === 'ABANDONED') return
    if (this.hasFollowUps(work.id) || this.isPrompting(work.id)) throw new Error('Send or remove the saved follow-ups before detaching or deleting this conversation.')
    if (reviewManager.isBusyReviewing(work.id) || shipManager.isShipping(work.id)) throw new Error('Stop review or wait for shipping before deleting this conversation.')
    await reviewManager.requireStoppedReviews(work.id)
    if (reviewManager.isBusyReviewing(work.id) || shipManager.isShipping(work.id)) throw new Error('Review or shipping started; wait before deleting this conversation.')
    getDb().prepare("UPDATE work SET state = 'ABANDONED', session_id = NULL, updated_at = ? WHERE id = ?").run(Date.now(), work.id)
    this.buildRevisions.delete(sessionId)
    sessionIndex.register(sessionId, 'chat')
    this.emit(work.id, 'ABANDONED')
  }

  /** Ticket tagging is a property update, not a new pipeline/run. */
  async setTicketProperty(sessionId: string, ticketKey: string | null): Promise<void> {
    const work = this.workBySession(sessionId)
    if (!work || work.state === 'ABANDONED') return
    const chat = getDb().prepare('SELECT pr_url FROM chat WHERE session_id = ?').get(sessionId) as { pr_url: string | null } | undefined
    if (!ticketKey && !chat?.pr_url) {
      await this.forgetConversation(sessionId)
      return
    }
    getDb().prepare('UPDATE work SET ticket_key = ? WHERE id = ?').run(ticketKey ?? '', work.id)
    this.emit(work.id, work.state as WorkState)
  }

  async requireEditableLinks(sessionId: string): Promise<void> {
    const work = this.workBySession(sessionId)
    if (!work || work.state === 'ABANDONED') return
    if (this.isPrompting(work.id)) throw new Error('A follow-up is being delivered; wait before changing the conversation’s links.')
    if (reviewManager.isBusyReviewing(work.id) || shipManager.isShipping(work.id)) throw new Error('Stop review or wait for shipping before changing the conversation’s links.')
    await reviewManager.requireStoppedReviews(work.id)
  }

  async start(input: StartWorkInput): Promise<WorkSummary> {
    if (!openCodeService.connected) throw new Error('Connect OpenCode first.')

    const ticket = await getTicket(input.ticketKey)
    if (!ticket) throw new Error(`Ticket ${input.ticketKey} not found. Refresh the board first.`)

    // Parent (stacked) work → branch base.
    let baseRef: string | undefined
    if (input.parentWorkId) {
      const parent = getDb().prepare('SELECT * FROM work WHERE id = ?').get(input.parentWorkId) as WorkRow | undefined
      if (!parent) throw new Error('Parent work not found.')
      if (!existsSync(parent.worktree_dir)) throw new Error(`Parent worktree is gone: ${parent.worktree_dir}`)
      if (await realpath(parent.repo_dir) !== await realpath(input.repoDir)) {
        throw new Error('Parent work belongs to a different repository. Choose a parent from this repository.')
      }
      baseRef = parent.branch
    }

    const id = randomUUID()
    const branch = slugBranch(ticket.key)
    const worktreeDir = await this.createWorktree(input.repoDir, branch, baseRef)

    const state: WorkState = 'BUILDING'
    const now = Date.now()
    getDb()
      .prepare(
        `INSERT INTO work(id, ticket_key, workspace_id, repo_dir, branch, worktree_dir, parent_work_id, mode, state, session_id, review_sel, ship_on_approve, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        ticket.key,
        null,
        input.repoDir,
        branch,
        worktreeDir,
        input.parentWorkId ?? null,
        input.mode,
        state,
        null,
        input.reviewSel ? JSON.stringify(input.reviewSel) : null,
        input.mode === 'auto' || input.shipOnApprove ? 1 : 0,
        now,
        now
      )

    // Build session in the worktree.
    const api = openCodeService.api
    const guard = await skillGuardRules(worktreeDir)
    const session = await api.session.create({
      title: `${ticket.key}: ${ticket.summary}`.slice(0, 100),
      agent: input.agentID ?? null,
      model: input.model ? { providerID: input.model.providerID, id: input.model.id } : null,
      location: { directory: worktreeDir },
      ...(guard.length ? { permissions: guard } : {}),
      metadata: { revva: { kind: 'chat', workId: id, ticketKey: ticket.key, phase: 'build', mode: input.mode } }
    })
    getDb().prepare('UPDATE work SET session_id = ? WHERE id = ?').run(session.id, id)
    // A started ticket is also an ordinary conversation with ticket properties.
    getDb().prepare(`INSERT INTO chat(session_id, title, directory, agent_id, provider_id, model_id, ticket_key, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(session.id, `${ticket.key}: ${ticket.summary}`, worktreeDir, input.agentID ?? null, input.model?.providerID ?? null, input.model?.id ?? null, ticket.key, now, now)
    sessionIndex.register(session.id, 'work')

    const prompt = await this.buildPrompt(ticket.key, input)
    await api.session.prompt({ sessionID: session.id, text: prompt }).catch((err) => {
      throw new Error(`Session created but first prompt failed: ${describeError(err)}`)
    })

    this.emit(id, state)
    return this.toSummary(getDb().prepare('SELECT * FROM work WHERE id = ?').get(id) as WorkRow)
  }

  private async buildPrompt(ticketKey: string, input: StartWorkInput): Promise<string> {
    const ticket = await getTicket(ticketKey)
    const description = extractDescription(ticket?.raw)
    const template = settingGet<string>('prompt.start') || DEFAULT_START_PROMPT
    const core = renderPrompt(template, {
      ticketKey,
      summary: ticket?.summary ?? '',
      description: description || '(No ticket description.)'
    })
    const modeLines =
      input.mode === 'auto'
        ? [
            '',
            'AUTO MODE (Revva):',
            '- Achieve the ticket acceptance criteria; resolve routine choices yourself.',
            '- Prefer an option the ticket or repo conventions explicitly recommend; otherwise pick the conservative choice consistent with the codebase, and state the assumption in your final summary.',
            '- Ask (via your question tool) only for: ambiguous intent with materially different outcomes, missing credentials, or actions outside this worktree.',
            '- Do not push, do not open PRs — Revva ships after review.'
          ]
        : [
            '',
            'Interactive mode: ask when the goal or trade-offs are genuinely unclear.'
          ]
    return [
      core,
      '',
      ...(input.grill
        ? [
            'First use the grill-me skill to interrogate this ticket and sharpen the plan,',
            'answer its questions from the ticket/repo context, then implement.',
            ''
          ]
        : []),
      // Structural pipeline facts — not stylistic, always appended.
      `Pipeline context (Revva):`,
      '- You are in a dedicated git worktree on branch ' + slugBranch(ticketKey) + '.',
      '- Commit your work with clear messages referencing ' + ticketKey + '. Do not push, do not open PRs — Revva ships after review.',
      BUILD_COMPLETION_INSTRUCTIONS,
      ...modeLines
    ].join('\n')
  }

  /**
   * OpenCode worktree API first, then a crash-safe `git worktree add`:
   * the worktree is created locked with an ownership receipt in the lock reason
   * (revva's pid+uuid), the branch is (re)pointed at the base, only then checked
   * out and unlocked. A crashed create leaves a locked, identifiable worktree.
   * Same-branch reruns adopt the existing branch; a taken directory gets a suffix.
   */
  private async createWorktree(repoDir: string, branch: string, baseRef?: string): Promise<string> {
    const root = settingGet<string>('worktreeRoot') || join(repoDir, '..', `${basename(repoDir)}-worktrees`)
    const name = branch.replace(/\//g, '-')

    // Both creation paths use the same explicit base, never the checkout's
    // current feature branch. The service otherwise defaults to detached HEAD.
    const base = baseRef ?? (await defaultBranch(repoDir))
    if (!(await refExists(repoDir, base))) {
      await exec('git', ['-C', repoDir, 'fetch', '--all', '--prune'], { timeout: 120_000 }).catch(() => undefined)
      if (!(await refExists(repoDir, base))) throw new Error(`Base branch ${base} was not found in ${repoDir}.`)
    }
    const baseHead = (await exec('git', ['-C', repoDir, 'rev-parse', base])).stdout.trim()
    const branchExists = await refExists(repoDir, `refs/heads/${branch}`)
    let serviceDir: string | undefined

    // Prefer the service-managed worktree API.
    try {
      const api = openCodeService.api
      const projects = await api.project.list({})
      const project = projects.find((p) => p.canonical === repoDir)
      if (project) {
        const info = await api.worktree.create({
          projectID: project.id,
          name,
          branch,
          from: baseHead
        })
        serviceDir = info.directory
      }
    } catch {
      // fall through to git
    }

    if (serviceDir) {
      // A materialized folder must satisfy the branch contract. Do not silently
      // create a second folder or reset anything if the service returned a bad one.
      const attached = (await exec('git', ['-C', serviceDir, 'branch', '--show-current'])).stdout.trim()
      if (attached !== branch) throw new Error(`OpenCode created ${serviceDir} on ${attached || 'detached HEAD'}, not ${branch}. No build was started; inspect this worktree before retrying.`)
      const head = (await exec('git', ['-C', serviceDir, 'rev-parse', 'HEAD'])).stdout.trim()
      if (!branchExists && head !== baseHead) throw new Error(`OpenCode created ${serviceDir} at an unexpected base. No build was started; inspect this worktree before retrying.`)
      const configured = await exec('git', ['-C', serviceDir, 'config', '--get', `branch.${branch}.base`]).then((r) => r.stdout.trim()).catch(() => '')
      if (!configured) await exec('git', ['-C', serviceDir, 'config', `branch.${branch}.base`, baseHead])
      return serviceDir
    }

    await mkdir(root, { recursive: true }).catch(() => undefined)
    // Directory collision (crashed run left a worktree, or same ticket twice): bump a suffix.
    let target = join(root, name)
    for (let i = 2; existsSync(target); i++) target = join(root, `${name}-${i}`)

    const receipt = `revva-create:${process.pid}:${randomUUID()}`
    // Existing branch (rerun after a crashed/removed worktree): adopt it as-is rather
    // than fail or reset — its commits are the point. Same policy as a taken directory.
    try {
      // Phase 1: locked, detached, no checkout — ours by receipt alone; branch untouched.
      await exec('git', [
        '-C', repoDir, 'worktree', 'add', '--detach', '--no-checkout', '--lock', '--reason', receipt, target, base
      ], { timeout: 120_000 })
      // Phase 2: attach the branch (created fresh at base, or adopted), record lineage, release.
      if (branchExists) {
        await exec('git', ['-C', target, 'checkout', branch], { timeout: 120_000 })
      } else {
        await exec('git', ['-C', target, 'checkout', '-b', branch, base], { timeout: 120_000 })
      }
      const configured = await exec('git', ['-C', target, 'config', '--get', `branch.${branch}.base`]).then((r) => r.stdout.trim()).catch(() => '')
      if (!configured) await exec('git', ['-C', target, 'config', 'branch.' + branch + '.base', baseHead])
      await exec('git', ['-C', repoDir, 'worktree', 'unlock', target]).catch(() => undefined)
    } catch (err) {
      // Leave nothing half-built: only remove what our receipt still owns.
      await exec('git', ['-C', repoDir, 'worktree', 'remove', '--force', target]).catch(() => undefined)
      throw new Error(
        `git worktree add failed: ${describeError(err)}${
          branchExists ? ` (branch ${branch} exists — it may be checked out in a live worktree)` : ''
        }`
      )
    }
    return target
  }

  /** "I've looked at it": clears the finished-unread inbox card. MAX() so a
   *  state change landing in the same millisecond does not immediately re-flag it. */
  markSeen(id: string): void {
    getDb().prepare('UPDATE work SET seen_at = MAX(?, updated_at) WHERE id = ?').run(Date.now(), id)
  }

  private setState(id: string, state: WorkState, blocker?: string): void {
    getDb().prepare('UPDATE work SET state = ?, blocker = ?, updated_at = ? WHERE id = ?').run(state, blocker ?? null, Date.now(), id)
    // A pipeline move into an unread-worthy state raises a finished-unseen inbox card.
    if (UNREAD_WORTHY_STATES.has(state)) {
      const work = getDb().prepare('SELECT ticket_key FROM work WHERE id = ?').get(id) as { ticket_key: string } | undefined
      if (work) notifyInbound(`work:${id}`, 'Ticket work update', `${work.ticket_key} · ${stateLabel(state)}${blocker ? ` — ${blocker}` : ''}`)
    }
    this.emit(id, state)
  }

  /** Called by the review pipeline (REVIEW/FIXING/APPROVED/WAITING_HUMAN). */
  setReviewState(id: string, state: WorkState, blocker?: string | null): void {
    const work = getDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string } | undefined
    if (!work || work.state === 'ABANDONED' || work.state === 'SHIPPED') return
    // Explicit null clears a stale reconnect error, even if the state is unchanged.
    if (work.state === state && blocker === undefined) return
    this.setState(id, state, blocker ?? undefined)
    if (state === 'APPROVED' || state === 'WAITING_HUMAN') {
      // ReviewManager releases starting/stopping guards before this runs.
      // Startup recovery holds saved messages for explicit resume.
      if (this.wired && openCodeService.connected) setTimeout(() => void this.drainFollowUps(id), 0)
    }
  }

  private emit(id: string, state: WorkState): void {
    pushToWindows({ kind: 'work.updated', workId: id, state })
  }

  private workBySession(sessionId: string): WorkRow | undefined {
    return getDb().prepare('SELECT * FROM work WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1').get(sessionId) as WorkRow | undefined
  }

  private onEvent(e: RawEvent): void {
    // Detail is routed by the shared bus, without a SQLite read per token.
    if (!['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(e.type)) return
    const data = (e.data ?? {}) as Record<string, unknown>
    const sessionId = data.sessionID
    if (typeof sessionId !== 'string') return
    // Fast miss on the index: chat/reviewer sessions never touch SQLite here.
    if (sessionIndex.kindOf(sessionId) !== 'work') return
    const work = this.workBySession(sessionId)
    if (!work) return

    switch (e.type) {
      case 'session.execution.started': {
        this.buildRevisions.set(sessionId, (this.buildRevisions.get(sessionId) ?? 0) + 1)
        if (work.owns_worktree === 0 && work.state !== 'BUILDING') this.setState(work.id, 'BUILDING')
        break
      }
      case 'session.execution.succeeded': {
        if (work.state !== 'BUILDING') return
        streamBuffer.flush(sessionId)
        void this.finishBuildTurn(work, this.buildRevisions.get(sessionId) ?? 0)
        break
      }
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        streamBuffer.flush(sessionId)
        if (work.state === 'BUILDING') {
          this.setState(
            work.id,
            'WAITING_HUMAN',
            work.owns_worktree === 0
              ? `Conversation ${e.type === 'session.execution.failed' ? 'failed' : 'was interrupted'}.`
              : `Build ${e.type === 'session.execution.failed' ? 'failed' : 'was interrupted'}.`
          )
        }
        break
      }
    }
  }

  /** A successful prompt execution can be a refusal or a planning pause. */
  private async finishBuildTurn(work: WorkRow, revision: number): Promise<void> {
    const sessionId = work.session_id!
    const stillCurrent = (): boolean => this.workBySession(sessionId)?.state === 'BUILDING' && (this.buildRevisions.get(sessionId) ?? 0) === revision
    // Fast completions can arrive before prompt acceptance. Let queue removal
    // and the submission guard settle before deciding whether to re-review.
    if (this.isPrompting(work.id)) {
      this.deferredCompletions.set(work.id, { work, revision })
      return
    }
    if (!stillCurrent()) return
    // PR-linked conversations are always ordinary chats. Even a stale
    // re-review latch must not turn their replies into implementation turns.
    const ordinaryPrChat = work.owns_worktree === 0 && !!work.pr_url
    if (work.owns_worktree === 0 && (!work.review_after_followup || ordinaryPrChat)) {
      if (ordinaryPrChat && work.review_after_followup) {
        getDb().prepare('UPDATE work SET review_after_followup = 0 WHERE id = ?').run(work.id)
      }
      this.setState(work.id, 'READY')
      await this.drainFollowUps(work.id)
      return
    }
    try {
      const text = await fetchLastAssistantText(sessionId)
      if (!stillCurrent()) return
      if (this.hasFollowUps(work.id)) {
        this.setState(work.id, 'READY')
        await this.drainFollowUps(work.id)
        return
      }
      const lastLine = text.split('\n').map((line) => line.trim().replace(/[*`>_#]/g, '').trim()).filter(Boolean).at(-1)
      if (lastLine !== 'REVVA: DONE') {
        this.setState(work.id, 'WAITING_HUMAN', 'The build turn ended without declaring implementation complete. Review was not started. Read the agent’s reply and send a follow-up, or start review manually when ready.')
        return
      }
      this.setState(work.id, 'REVIEW')
      getDb().prepare('UPDATE work SET review_after_followup = 0 WHERE id = ?').run(work.id)
      await reviewManager.startRound(work.id, reviewManager.latestRound(work.id) + 1, true)
    } catch (err) {
      if ((this.buildRevisions.get(sessionId) ?? 0) !== revision) return
      const current = this.workBySession(sessionId)
      if (!current || !['BUILDING', 'REVIEW'].includes(current.state)) return
      console.warn('[work] completion/review failed:', describeError(err))
      this.setReviewState(work.id, 'WAITING_HUMAN', `Could not finish build/start review: ${describeError(err)}`)
    }
  }

  /**
   * Read-only preview of Abandon: what the worktree holds that removal would destroy.
   * Touches nothing — deleting the session happens only in `abandon`, and only
   * after the user's confirmation matches a fresh revalidation. An in-flight
   * review makes `abandon` refuse without cancelling anything.
   */
  async abandonPreflight(id: string): Promise<WorkAbandonPreflight> {
    const work = getDb().prepare('SELECT * FROM work WHERE id = ?').get(id) as WorkRow | undefined
    if (!work) throw new Error('Work not found.')
    if (work.owns_worktree === 0) throw new Error('This ticket workflow uses an existing conversation and folder. Remove its ticket link to detach the workflow; its files and conversation are kept.')
    const preflight = await preflightWorktreeRemoval(work.repo_dir, work.worktree_dir)
    return {
      workId: work.id,
      ticketKey: work.ticket_key,
      branch: work.branch,
      worktreeDir: work.worktree_dir,
      worktree: preflight
    }
  }

  /**
   * Remove the worktree (only with the confirmation the preview asked for —
   * never silently destructive), then delete the session and try to delete the
   * branch with `-d` only: unmerged work is never discarded silently.
   *
   * Cancellation is deliberately NOT part of this flow: an in-flight review
   * round (or a review/ship starting) makes abandon REFUSE with nothing
   * cancelled, deleted, or changed — cancelling first would leave interrupted
   * review rows behind when the removal then fails, and cancelWork awaits I/O,
   * which would let cancellation interleave with the confirmed preview. Safe
   * cancel-then-rollback coordination would need to live in ReviewManager and
   * does not exist, so abandon waits instead of gambling.
   *
   * Immediately before the deletion the guards run a final time — fresh
   * review/ship activity checks, a fresh agent-occupancy probe, then a fresh
   * full preflight (contents + index + path identity) landing directly before
   * the unlink. This narrows the window to the git subprocess itself; it does
   * NOT make deletion race-free — a round starting inside that final window is
   * possible in principle, and git's own deletion-time check plus the honest
   * UI warning are the remaining guards. Every refusal leaves the work row,
   * its files, its session and its reviews untouched and retryable. Returns a
   * note when the branch was kept.
   */
  async abandon(id: string, confirmedSignature: string, confirmed: boolean): Promise<string | undefined> {
    const work = getDb().prepare('SELECT * FROM work WHERE id = ?').get(id) as WorkRow | undefined
    if (!work) return
    if (this.hasFollowUps(id) || this.isPrompting(id)) throw new Error('Send or remove the saved follow-ups before abandoning this work. Nothing was removed.')
    if (work.owns_worktree === 0) throw new Error('Existing conversation folders are never removed by Abandon. Remove the ticket link instead; files and transcript are kept.')
    if (shipManager.isShipping(id)) throw new Error('Shipping is in progress; wait for it to finish before abandoning this work.')
    // Active review ⇒ refuse before anything (including any cancellation) can happen.
    if (reviewManager.isBusyReviewing(id)) {
      throw new Error('A review round is still in flight for this work — wait for it to finish (or let it time out) before abandoning. Nothing was cancelled or removed.')
    }
    if (reviewManager.isStartingReview(id)) throw new Error('Review is starting; wait for it to finish starting before abandoning this work.')

    // Proof first: protected path, unregistered path (exact registration is
    // required — no no-op exception), or unreadable/fingerprint-over-limit
    // state ⇒ refuse. Nothing is cancelled or deleted at any refusal point.
    const preflight = await preflightWorktreeRemoval(work.repo_dir, work.worktree_dir)
    if (preflight.signature !== confirmedSignature) throw staleConfirmationError()
    if (preflight.requiresConfirmation && !confirmed) {
      // The folder holds content the user has not explicitly confirmed destroying.
      throw new Error(
        `Explicit confirmation required — the worktree holds content that would go: ${preflight.confirmationReasons.join('; ')}. Nothing was abandoned — confirm this exact worktree first.`
      )
    }

    // A running build would keep writing into the worktree path (and could
    // recreate a vanished folder). Fails closed: unprovable ⇒ refuse.
    await requireAbsenceOfAgents(preflight.directory)
    if (work.session_id) {
      const active = await openCodeService.api.session.active().catch(() => undefined)
      if (!active) throw new Error('Nothing was removed: the OpenCode service could not be consulted about running sessions.')
      if (work.session_id in active) {
        throw new Error('The build session is still running — interrupt it before abandoning this work.')
      }
    }

    // Final rechecks immediately before the deletion. The occupancy probe is a
    // network-slow SNAPSHOT (a session can start right after it returns) and
    // runs first, so the full fresh preflight (contents + index + path
    // identity) lands last, directly before the unlink. These are awaited
    // probes: they narrow the race window rather than closing it, and no claim
    // of race-freedom is made anywhere.
    if (reviewManager.isBusyReviewing(id) || reviewManager.isStartingReview(id) || shipManager.isShipping(id) || this.isPrompting(id) || this.hasFollowUps(id)) {
      throw new Error('A review or ship started just now — nothing was removed. Try abandoning again once it settles.')
    }
    await requireAbsenceOfAgents(preflight.directory)
    const final = await preflightWorktreeRemoval(work.repo_dir, work.worktree_dir)
    if (final.signature !== confirmedSignature) throw staleConfirmationError()
    // Synchronous last word, directly before the git subprocess starts: no
    // await between here and performRemoval, so within this process no review
    // or ship round can slip in after the final content proof.
    if (reviewManager.isBusyReviewing(id) || reviewManager.isStartingReview(id) || shipManager.isShipping(id) || this.isPrompting(id) || this.hasFollowUps(id)) {
      throw new Error('A review or ship started just now — nothing was removed. Try abandoning again once it settles.')
    }

    // Deletion happens here (or the registration is cleared, folder already gone).
    // `--force` only for modified/untracked content the confirmation covered —
    // the content-bound signature binds exactly those contents, so any edit
    // since the preview (even to an already-dirty file or a staged blob)
    // voided it above. Never unlock, never broad prune. Git's own
    // deletion-time check still refuses fresh modified/untracked files; revva
    // does not escalate that.
    const force = !final.missing && final.trackedDirty + final.untracked > 0
    try {
      await performRemoval(final.repoDir, final.directory, force)
    } catch (err) {
      // Nothing was cancelled either — the whole work is intact and retryable.
      throw new Error(`${(err as Error).message} (The work, its files, its session, its reviews and its state are untouched — retry once resolved.)`)
    }

    // Filesystem removal succeeded — only now let the rest of the record follow.
    if (work.session_id) {
      sessionIndex.forget(work.session_id)
      await openCodeService.api.session.remove({ sessionID: work.session_id }).catch(() => undefined)
      getDb().prepare('DELETE FROM chat WHERE session_id = ?').run(work.session_id)
    }
    let note: string | undefined
    try {
      await exec('git', ['-C', final.repoDir, 'branch', '-d', work.branch])
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      const reason = (e.stderr || e.message || 'not fully merged').trim().slice(0, 160)
      // Legacy service-created worktrees could be detached: the recorded
      // branch never existed. Confirm absence via the exact ref, not localized
      // stderr text or refExists() (which also treats git failures as absence).
      let branchPresent: boolean | undefined
      try {
        await exec('git', ['-C', final.repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${work.branch}`])
        branchPresent = true
      } catch (probeError) {
        if ((probeError as { code?: number }).code === 1) branchPresent = false
      }
      if (branchPresent === true) note = `Branch ${work.branch} kept (git refused to delete it: ${reason})`
      else if (branchPresent === undefined) note = `Work abandoned, but branch ${work.branch} cleanup could not be verified (${reason})`
    }
    this.setState(id, 'ABANDONED')
    return note
  }

  /** Pipeline occupancy is independent of the build session's activity. */
  isPrompting(workId: string): boolean {
    return this.prompting.has(workId) || this.draining.has(workId)
  }

  hasFollowUps(workId: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM work_followup WHERE work_id = ? LIMIT 1').get(workId)
  }

  queuedFollowUps(workId: string): WorkFollowUp[] {
    const rows = getDb().prepare('SELECT * FROM work_followup WHERE work_id = ? ORDER BY created_at, rowid').all(workId) as FollowUpRow[]
    return rows.map((row) => ({
      id: row.id, text: row.text, imageCount: (JSON.parse(row.images) as PromptImage[]).length,
      createdAt: row.created_at, status: row.status, error: row.error ?? undefined
    }))
  }

  private queueChanged(workId: string): void {
    pushToWindows({ kind: 'work.queue', workId })
  }

  editQueued(workId: string, id: string, text: string, refs?: PromptRefs): void {
    const row = this.requireQueued(workId, id)
    if (!text.trim() && !(JSON.parse(row.images) as PromptImage[]).length) throw new Error('Add a message or keep an image attachment.')
    getDb().prepare('UPDATE work_followup SET text = ?, refs = ? WHERE id = ?').run(text, JSON.stringify(refs ?? { skills: [], files: [] }), id)
    this.queueChanged(workId)
  }

  cancelQueued(workId: string, id: string): void {
    this.requireQueued(workId, id)
    getDb().prepare('DELETE FROM work_followup WHERE id = ?').run(id)
    this.queueChanged(workId)
    void this.drainFollowUps(workId)
  }

  private requireQueued(workId: string, id: string): FollowUpRow {
    const row = getDb().prepare('SELECT * FROM work_followup WHERE work_id = ? AND id = ?').get(workId, id) as FollowUpRow | undefined
    if (!row) throw new Error('This follow-up was already sent or removed.')
    if (row.status === 'sending') throw new Error('This follow-up is being delivered; wait for it to finish.')
    return row
  }

  private enqueue(work: WorkRow, text: string, images: PromptImage[], refs?: PromptRefs): 'queued' {
    if (!text.trim() && !images.length) throw new Error('Add a message or an image attachment.')
    getDb().prepare('INSERT INTO work_followup(id, work_id, text, images, refs, created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), work.id, text, JSON.stringify(images), JSON.stringify(refs ?? { skills: [], files: [] }), Date.now())
    this.queueChanged(work.id)
    return 'queued'
  }

  /** Keep review/fixer writers isolated; queue at ticket level even when the build is idle. */
  async followUp(sessionId: string, text: string, images: PromptImage[] = [], queued = false, refs?: PromptRefs, sentAt?: unknown): Promise<void | 'queued'> {
    const work = this.workBySession(sessionId)
    if (work?.state === 'ABANDONED') throw new Error('This work was abandoned; start a new ticket run instead.')
    if (work && shipManager.isShipping(work.id)) throw new Error('Shipping is in progress; wait for it to finish before sending a follow-up.')
    if (work && (reviewManager.isBusyReviewing(work.id) || ['REVIEW', 'FIXING'].includes(work.state) || this.isPrompting(work.id) || this.hasFollowUps(work.id))) {
      const result = this.enqueue(work, text, images, refs)
      // Also handles a submit racing the end of a review cycle.
      if (!['REVIEW', 'FIXING', 'BUILDING'].includes(work.state)) void this.drainFollowUps(work.id)
      return result
    }
    await throughputMeter.measurePrompt(sessionId, sentAt, () => this.deliverFollowUp(sessionId, text, images, queued, refs))
  }

  /** Explicit takeover. Failed stop leaves the draft intact and never starts another writer. */
  async promptNow(sessionId: string, text: string, images: PromptImage[] = [], refs?: PromptRefs): Promise<void> {
    const work = this.workBySession(sessionId)
    if (!work || work.state === 'ABANDONED') throw new Error('Ticket workflow not found.')
    if (this.isPrompting(work.id)) throw new Error('Another follow-up is being delivered; wait for it to finish.')
    this.draining.add(work.id)
    try {
      if (reviewManager.isBusyReviewing(work.id) || ['REVIEW', 'FIXING', 'WAITING_HUMAN'].includes(work.state)) await reviewManager.stopWork(work.id)
      await reviewManager.requireStoppedReviews(work.id)
      const active = await openCodeService.api.session.active()
      if (sessionId in active) throw new Error('Implementation is running. Queue a message or stop the response first.')
      await throughputMeter.measurePrompt(sessionId, undefined, () => this.deliverFollowUp(sessionId, text, images, false, refs, true))
    } finally {
      this.draining.delete(work.id)
      this.resumeCompletion(work.id)
    }
  }

  async sendQueuedNow(workId: string, id: string): Promise<void> {
    const row = this.requireQueued(workId, id)
    const work = getDb().prepare('SELECT * FROM work WHERE id = ?').get(workId) as WorkRow | undefined
    if (!work?.session_id || work.state === 'ABANDONED') throw new Error('Ticket workflow not found. The saved message is kept.')
    if (this.isPrompting(workId)) throw new Error('Another follow-up is being delivered; wait for it to finish.')
    this.draining.add(workId)
    try {
      if (reviewManager.isBusyReviewing(workId) || ['REVIEW', 'FIXING', 'WAITING_HUMAN'].includes(work.state)) await reviewManager.stopWork(workId)
      await this.deliverQueued(work, this.requireQueued(workId, row.id))
    } finally {
      this.draining.delete(workId)
      this.resumeCompletion(workId)
    }
  }

  /** One saved message per build turn. Remaining messages run before re-review or shipping. */
  async drainFollowUps(workId: string): Promise<boolean> {
    if (!this.hasFollowUps(workId)) return false
    if (this.isPrompting(workId) || reviewManager.isBusyReviewing(workId) || shipManager.isShipping(workId)) return true
    const work = getDb().prepare('SELECT * FROM work WHERE id = ?').get(workId) as WorkRow | undefined
    if (!work?.session_id || ['ABANDONED', 'SHIPPED', 'BUILDING', 'REVIEW', 'FIXING'].includes(work.state)) return true
    const row = getDb().prepare('SELECT * FROM work_followup WHERE work_id = ? ORDER BY created_at, rowid LIMIT 1').get(workId) as FollowUpRow
    if (row.status !== 'queued') {
      // Failed/uncertain delivery requires a human retry, not an approval badge.
      if (row.status === 'error' && work.state !== 'WAITING_HUMAN') this.setState(workId, 'WAITING_HUMAN', 'A saved follow-up needs attention. Check the conversation before retrying delivery, or remove the saved message.')
      return true
    }
    this.draining.add(workId)
    try {
      await this.deliverQueued(work, row)
    } catch (err) {
      console.warn('[work] follow-up held:', describeError(err))
      this.setState(workId, 'WAITING_HUMAN', 'Follow-up delivery is held. Inspect the saved message below and retry or remove it; shipping is paused.')
    } finally {
      this.draining.delete(workId)
      this.resumeCompletion(workId)
    }
    return true
  }

  private async deliverQueued(work: WorkRow, row: FollowUpRow): Promise<void> {
    // Claim before I/O so edits/removals cannot race submission.
    getDb().prepare("UPDATE work_followup SET status = 'sending', error = NULL WHERE id = ?").run(row.id)
    this.queueChanged(work.id)
    try {
      await reviewManager.requireStoppedReviews(work.id)
      const active = await openCodeService.api.session.active()
      if (work.session_id! in active) throw new Error('Implementation is still running. Wait for it to finish before retrying this follow-up.')
      await throughputMeter.measurePrompt(work.session_id!, undefined, () => this.deliverFollowUp(
        work.session_id!, row.text, JSON.parse(row.images) as PromptImage[], false, JSON.parse(row.refs) as PromptRefs, true
      ))
      getDb().prepare('DELETE FROM work_followup WHERE id = ?').run(row.id)
    } catch (err) {
      getDb().prepare("UPDATE work_followup SET status = 'error', error = ? WHERE id = ?")
        .run(`${describeError(err)} Check the conversation before retrying; if submission reached OpenCode, the message may already have arrived.`, row.id)
      throw err
    } finally {
      this.queueChanged(work.id)
    }
  }

  /** Internal delivery path, protected against review/ship startup across awaits. */
  private async deliverFollowUp(sessionId: string, text: string, images: PromptImage[] = [], queued = false, refs?: PromptRefs, reReview = false): Promise<void> {
    const work = this.workBySession(sessionId)
    if (work) this.prompting.add(work.id)
    try {
      await this.submitFollowUp(sessionId, text, images, queued, refs, reReview)
    } finally {
      if (work) {
        this.prompting.delete(work.id)
        this.resumeCompletion(work.id)
      }
    }
  }

  private resumeCompletion(workId: string): void {
    if (this.isPrompting(workId)) return
    const pending = this.deferredCompletions.get(workId)
    if (!pending) return
    this.deferredCompletions.delete(workId)
    void this.finishBuildTurn(pending.work, pending.revision)
  }

  private async submitFollowUp(sessionId: string, text: string, images: PromptImage[], queued: boolean, refs?: PromptRefs, reReview = false): Promise<void> {
    let work = this.workBySession(sessionId)
    let resumed = false
    if (work) {
      if (work.state === 'ABANDONED') throw new Error('This work was abandoned; start a new ticket run instead.')
      if (shipManager.isShipping(work.id)) throw new Error('Shipping is in progress; wait for it to finish before sending a follow-up.')
      if (reviewManager.isBusyReviewing(work.id) || work.state === 'REVIEW' || work.state === 'FIXING') {
        throw new Error('Review is in progress. Use Stop review in the review panel, or wait for it to finish before sending a follow-up.')
      }
      await reviewManager.requireStoppedReviews(work.id)
      work = this.workBySession(sessionId)
      if (!work || work.state === 'ABANDONED') throw new Error('This work was removed or abandoned while checking the session.')
      // Recheck after the service probe: a reviewer/ship may have started.
      if (reviewManager.isBusyReviewing(work.id) || shipManager.isShipping(work.id) || work.state === 'REVIEW' || work.state === 'FIXING') throw new Error('Review or shipping started while checking the session; try again once it finishes.')
      // A human re-prompting a settled build takes it back through review.
      if (work.state !== 'BUILDING') {
        this.setState(work.id, 'BUILDING')
        resumed = true
      }
      const ordinaryPrChat = work.owns_worktree === 0 && !!work.pr_url
      if (reReview && !ordinaryPrChat) getDb().prepare('UPDATE work SET review_after_followup = 1 WHERE id = ?').run(work.id)
      this.touch(work.id)
    }
    const files = [...promptImageFiles(images), ...(refs && work ? fileAttachments(refs, work.worktree_dir) : [])]
    const skills = refs ? skillAttachments(refs) : []
    const payload = {
      sessionID: sessionId,
      text: work && !work.pr_url && (work.owns_worktree !== 0 || reReview || work.review_after_followup)
        ? `${text}\n\n${BUILD_COMPLETION_INSTRUCTIONS}`
        : text,
      ...(files.length ? { files } : {}),
      ...(skills.length ? { skills } : {}),
      delivery: (queued ? 'queue' : 'steer') as 'queue' | 'steer'
    }
    try {
      this.buildRevisions.set(sessionId, (this.buildRevisions.get(sessionId) ?? 0) + 1)
      await openCodeService.api.session.prompt(payload)
    } catch (err) {
      // Steer refused (session state raced) — park the follow-up so it is not lost.
      if (!queued && isConflict(err)) {
        try {
          await openCodeService.api.session.prompt({ ...payload, delivery: 'queue' })
          return
        } catch (queueError) {
          if (work && resumed) this.setState(work.id, work.state as WorkState, work.blocker ?? undefined)
          throw queueError
        }
      }
      if (work && resumed) this.setState(work.id, work.state as WorkState, work.blocker ?? undefined)
      throw err
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await openCodeService.api.session.interrupt({ sessionID: sessionId })
    const work = this.workBySession(sessionId)
    if (work) this.touch(work.id)
  }

  private touch(id: string): void {
    getDb().prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }
}

async function refExists(repoDir: string, ref: string): Promise<boolean> {
  try {
    await exec('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

async function defaultBranch(repoDir: string): Promise<string> {
  const candidates = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master', 'HEAD']
  for (const ref of candidates) {
    try {
      await exec('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', ref])
      return ref
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `No usable base commit in ${repoDir}. Choose a Git repository with at least one commit.`
  )
}

function extractDescription(raw: unknown): string {
  const fields = (raw as { fields?: Record<string, unknown> })?.fields
  const d = fields?.description
  if (typeof d === 'string') return d
  if (d && typeof d === 'object') {
    // ADF → crude text extraction; rich rendering lands with the UI polish pass.
    return collectAdfText(d).join('\n')
  }
  return ''
}

export const workManager = new WorkManager()
