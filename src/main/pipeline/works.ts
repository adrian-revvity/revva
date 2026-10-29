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
import { join, basename } from 'node:path'
import { BrowserWindow } from 'electron'
import { openCodeService, describeError } from '../opencode/service'
import { eventBus, type RawEvent } from '../opencode/bus'
import { getTicket } from '../jira/board'
import { getDb, settingGet } from '../db'
import { sessionIndex } from '../opencode/session-index'
import { streamBuffer } from '../opencode/stream-buffer'
import { pushToWindows } from '../push'
import { notifyInbound } from '../notify'
import { collectAdfText, isConflict, promptImageFiles } from '../util'
import { reviewManager } from '../review'
import { shipManager } from '../ship'
import { performRemoval, preflightWorktreeRemoval, requireAbsenceOfAgents, staleConfirmationError } from '../worktree-safety'
import { renderPrompt, DEFAULT_START_PROMPT } from '@shared/prompts'
import {
  IPC,
  type PromptImage,
  type PromptRefs,
  type StartWorkInput,
  type WorkAbandonPreflight,
  type WorkState,
  type WorkSummary
} from '@shared/types'
import { fileAttachments, skillAttachments } from '../opencode/prompt-refs'

const exec = promisify(execFile)

interface WorkRow {
  id: string
  ticket_key: string
  workspace_id: string
  repo_dir: string
  branch: string
  worktree_dir: string
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

  wire(): void {
    if (this.wired) return
    this.wired = true
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
      ticketSummary: ticket?.summary ?? r.ticket_key,
      repoDir: r.repo_dir,
      branch: r.branch,
      worktreeDir: r.worktree_dir,
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
    const session = await api.session.create({
      title: `${ticket.key}: ${ticket.summary}`.slice(0, 100),
      agent: input.agentID ?? null,
      model: input.model ? { providerID: input.model.providerID, id: input.model.id } : null,
      location: { directory: worktreeDir },
      metadata: { revva: { kind: 'work', workId: id, ticketKey: ticket.key, phase: 'build', mode: input.mode } }
    })
    getDb().prepare('UPDATE work SET session_id = ? WHERE id = ?').run(session.id, id)
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

    // Prefer the service-managed worktree API.
    try {
      const api = openCodeService.api
      const projects = await api.project.list({})
      const project = projects.find((p) => p.canonical === repoDir)
      if (project) {
        const info = await api.worktree.create({
          projectID: project.id,
          name,
          ...(baseRef ? { from: baseRef } : {})
        } as never)
        const dir = (info as unknown as { directory?: string }).directory
        if (dir) return dir
      }
    } catch {
      // fall through to git
    }

    // Lazy fetch: only hit the network when the requested base isn't already local.
    const base = baseRef ?? (await defaultBranch(repoDir))
    if (!(await refExists(repoDir, base))) {
      await exec('git', ['-C', repoDir, 'fetch', '--all', '--prune'], { timeout: 120_000 }).catch(() => undefined)
      if (!(await refExists(repoDir, base))) throw new Error(`Base branch ${base} was not found in ${repoDir}.`)
    }

    await mkdir(root, { recursive: true }).catch(() => undefined)
    // Directory collision (crashed run left a worktree, or same ticket twice): bump a suffix.
    let target = join(root, name)
    for (let i = 2; existsSync(target); i++) target = join(root, `${name}-${i}`)

    const receipt = `revva-create:${process.pid}:${randomUUID()}`
    // Existing branch (rerun after a crashed/removed worktree): adopt it as-is rather
    // than fail or reset — its commits are the point. Same policy as a taken directory.
    const branchExists = await refExists(repoDir, `refs/heads/${branch}`)
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
      await exec('git', ['-C', target, 'config', 'branch.' + branch + '.base', base])
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
  setReviewState(id: string, state: WorkState, blocker?: string): void {
    const work = getDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string } | undefined
    if (!work || work.state === 'ABANDONED' || work.state === 'SHIPPED') return
    if (work.state === state && !blocker) return
    this.setState(id, state, blocker)
  }

  private emit(id: string, state: WorkState): void {
    pushToWindows({ kind: 'work.updated', workId: id, state })
  }

  private workBySession(sessionId: string): WorkRow | undefined {
    return getDb().prepare('SELECT * FROM work WHERE session_id = ?').get(sessionId) as WorkRow | undefined
  }

  private onEvent(e: RawEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>
    const sessionId = data.sessionID
    if (typeof sessionId !== 'string') return
    // Fast miss on the index: chat/reviewer sessions never touch SQLite here.
    if (sessionIndex.kindOf(sessionId) !== 'work') return
    const work = this.workBySession(sessionId)
    if (!work) return

    switch (e.type) {
      case 'session.text.delta': {
        if (work.state !== 'BUILDING') return
        streamBuffer.push({
          kind: 'work.delta',
          workId: work.id,
          sessionId,
          messageId: String(data.assistantMessageID ?? ''),
          text: String(data.delta ?? '')
        })
        break
      }
      case 'session.execution.succeeded': {
        if (work.state !== 'BUILDING') return
        streamBuffer.flush(sessionId)
        // M4: build finished → concurrent read-only reviewer fan-out (no more auto-approve).
        this.setState(work.id, 'REVIEW')
        void reviewManager.startRound(work.id, reviewManager.latestRound(work.id) + 1, true).catch((err) => {
          console.warn('[work] review fan-out failed:', describeError(err))
          this.setReviewState(work.id, 'WAITING_HUMAN', `Could not start review: ${describeError(err)}`)
        })
        break
      }
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        streamBuffer.flush(sessionId)
        if (work.state === 'BUILDING') this.setState(work.id, 'WAITING_HUMAN', `Build ${e.type === 'session.execution.failed' ? 'failed' : 'was interrupted'}.`)
        break
      }
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
    if (reviewManager.isBusyReviewing(id) || reviewManager.isStartingReview(id) || shipManager.isShipping(id)) {
      throw new Error('A review or ship started just now — nothing was removed. Try abandoning again once it settles.')
    }
    await requireAbsenceOfAgents(preflight.directory)
    const final = await preflightWorktreeRemoval(work.repo_dir, work.worktree_dir)
    if (final.signature !== confirmedSignature) throw staleConfirmationError()
    // Synchronous last word, directly before the git subprocess starts: no
    // await between here and performRemoval, so within this process no review
    // or ship round can slip in after the final content proof.
    if (reviewManager.isBusyReviewing(id) || reviewManager.isStartingReview(id) || shipManager.isShipping(id)) {
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
    }
    let note: string | undefined
    try {
      await exec('git', ['-C', final.repoDir, 'branch', '-d', work.branch])
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      const reason = (e.stderr || e.message || 'not fully merged').trim().slice(0, 160)
      note = `Branch ${work.branch} kept (git refused to delete it: ${reason})`
    }
    this.setState(id, 'ABANDONED')
    return note
  }

  /** Follow-up message into a running/finished build session. */
  async followUp(sessionId: string, text: string, images: PromptImage[] = [], queued = false, refs?: PromptRefs): Promise<void> {
    const work = this.workBySession(sessionId)
    let resumed = false
    if (work) {
      if (shipManager.isShipping(work.id)) throw new Error('Shipping is in progress; wait for it to finish before sending a follow-up.')
      if (reviewManager.isBusyReviewing(work.id) || work.state === 'REVIEW' || work.state === 'FIXING') {
        throw new Error('Review is in progress; wait for it to finish or re-run a stuck review before sending a follow-up.')
      }
      // A human re-prompting a settled build takes it back through review.
      if (['WAITING_HUMAN', 'APPROVED', 'SHIPPED'].includes(work.state)) {
        this.setState(work.id, 'BUILDING')
        resumed = true
      }
      this.touch(work.id)
    }
    const files = [...promptImageFiles(images), ...(refs && work ? fileAttachments(refs, work.worktree_dir) : [])]
    const skills = refs ? skillAttachments(refs) : []
    const payload = {
      sessionID: sessionId,
      text,
      ...(files.length ? { files } : {}),
      ...(skills.length ? { skills } : {}),
      delivery: (queued ? 'queue' : 'steer') as 'queue' | 'steer'
    }
    try {
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
