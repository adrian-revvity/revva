/**
 * M4 review pipeline: parallel read-only reviewer fan-out → fan-in → one fixer → bounded re-review.
 *
 * - One round spawns concurrent reviewer sessions (sol-loop always; test-audit always;
 *   impeccable only when UI files changed AND the skill exists).
 * - Reviewers never edit: prompts forbid writes/commits/subagents. Any incomplete or
 *   errored reviewer blocks approval — a missing skill is 'skipped', never 'approved'.
 * - Every role resolves agent/model as per-run override → role default → service default.
 * - Verdict protocol: reviewer's LAST line must be `VERDICT: APPROVED` or `VERDICT: CHANGES`.
 * - Fixer is a single session with the consolidated findings; rounds are bounded (default 3).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import { openCodeService, describeError } from './opencode/service'
import { eventBus, type RawEvent } from './opencode/bus'
import { listSkills } from './opencode/inventory'
import { getDb, roleConfigGet, settingGet } from './db'
import { workManager } from './pipeline/works'
import { shipManager } from './ship'
import {
  IPC,
  type ModelRef,
  type PipelineRole,
  type ReviewRole,
  type ReviewRow,
  type ReviewStatus
} from '@shared/types'

const exec = promisify(execFile)

/** Watchdog: a reviewer/fixer session stuck this long is errored out. */
const SESSION_TIMEOUT_MS = 20 * 60_000

interface ReviewDbRow {
  id: number
  work_id: number | string
  round: number
  role: string
  session_id: string | null
  status: string
  findings: string
  error: string | null
  agent_id: string | null
  provider_id: string | null
  model_id: string | null
  created_at: number
  updated_at: number
}

function ensureSchema(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id TEXT NOT NULL, round INTEGER NOT NULL, role TEXT NOT NULL,
    session_id TEXT, status TEXT NOT NULL, findings TEXT NOT NULL DEFAULT '',
    error TEXT, agent_id TEXT, provider_id TEXT, model_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_work ON review(work_id, round);
  CREATE TABLE IF NOT EXISTS auto_decision (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id TEXT NOT NULL, round INTEGER, kind TEXT NOT NULL,
    detail TEXT NOT NULL, created_at INTEGER NOT NULL
  );`)
}

function toRow(r: ReviewDbRow): ReviewRow {
  return {
    id: r.id,
    workId: String(r.work_id),
    round: r.round,
    role: r.role as ReviewRole | 'fixer',
    sessionId: r.session_id ?? undefined,
    status: r.status as ReviewStatus,
    findings: r.findings,
    error: r.error ?? undefined,
    agentID: r.agent_id ?? undefined,
    model: r.provider_id && r.model_id ? { providerID: r.provider_id, id: r.model_id } : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** Role selection: per-run override → role default → undefined (service default). */
function resolveSel(workId: string, role: PipelineRole, perRun?: Record<string, { agentID?: string; model?: ModelRef } | undefined>): {
  agentID?: string
  model?: ModelRef
} {
  return perRun?.[role] ?? roleConfigGet(role) ?? {}
}

/**
 * Verdict parsing — conservative: only an explicit APPROVED token approves.
 * Missing/garbled verdicts count as CHANGES so nothing slips through silently.
 */
export function parseVerdict(text: string): 'approved' | 'changes' {
  const lines = text
    .split('\n')
    .map((l) => l.trim().replace(/[*`>_#]/g, '').trim())
    .filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  return /^VERDICT:\s*APPROVED\b/i.test(last) ? 'approved' : 'changes'
}

interface TrackedSession {
  workId: string
  round: number
  role: ReviewRole | 'fixer'
  reviewId: number
  timer: NodeJS.Timeout
}

class ReviewManager {
  private wired = false
  private sessions = new Map<string, TrackedSession>()
  private settling = new Set<string>()
  private starting = new Set<string>()
  /** Fan-in guard: a round is decided exactly once. */
  private settledRounds = new Set<string>()

  wire(): void {
    if (this.wired) return
    this.wired = true
    ensureSchema()
    eventBus.on('event', (e: RawEvent) => this.onEvent(e))
    // Sessions cannot survive an app restart: mark anything still 'running' as errored.
    const stale = getDb().prepare("SELECT * FROM review WHERE status IN ('pending','running')").all() as ReviewDbRow[]
    for (const r of stale) {
      this.update(r.id, 'error', undefined, 'revva restarted while this review was running')
    }
    const interrupted = getDb().prepare("SELECT id FROM work WHERE state IN ('REVIEW', 'FIXING')").all() as Array<{ id: string }>
    for (const work of interrupted) {
      workManager.setReviewState(work.id, 'WAITING_HUMAN', 'Revva restarted during review. Re-run review to continue.')
    }
  }

  reviewsFor(workId: string): ReviewRow[] {
    ensureSchema()
    const rows = getDb()
      .prepare('SELECT * FROM review WHERE work_id = ? ORDER BY round ASC, id ASC')
      .all(workId) as ReviewDbRow[]
    return rows.map(toRow)
  }

  latestRound(workId: string): number {
    const row = getDb()
      .prepare('SELECT MAX(round) AS r FROM review WHERE work_id = ? AND role != ?')
      .get(workId, 'fixer') as { r: number | null } | undefined
    return row?.r ?? 0
  }

  /** Kick off reviewer fan-out for a round. Called after a build settles or on demand. */
  async startRound(workId: string, round: number, newCycle = false): Promise<void> {
    ensureSchema()
    const work = getDb().prepare('SELECT * FROM work WHERE id = ?').get(workId) as
      | { id: string; ticket_key: string; branch: string; worktree_dir: string; mode: string; review_sel: string | null }
      | undefined
    if (!work) throw new Error('Work not found.')
    if (this.isBusyReviewing(workId)) throw new Error('A review round is already in flight for this work.')
    if (shipManager.isShipping(workId)) throw new Error('Shipping is in progress.')
    const state = (getDb().prepare('SELECT state FROM work WHERE id = ?').get(workId) as { state: string }).state
    if (state === 'BUILDING' || state === 'ABANDONED' || state === 'SHIPPED') throw new Error(`Cannot review from state ${state}.`)
    if (this.reviewsFor(workId).some((r) => r.round === round && r.role !== 'fixer')) throw new Error('This review round already exists.')
    this.starting.add(workId)
    if (newCycle) getDb().prepare('UPDATE work SET review_cycle_start = ? WHERE id = ?').run(round, workId)
    workManager.setReviewState(workId, 'REVIEW')

    try {
      const status = await exec('git', ['-C', work.worktree_dir, 'status', '--porcelain'])
      if (status.stdout.trim()) throw new Error('Commit all worktree changes before starting review.')
      const head = (await exec('git', ['-C', work.worktree_dir, 'rev-parse', 'HEAD'])).stdout.trim()
      if (!head) throw new Error('Could not determine the commit to review.')
      getDb().prepare('UPDATE work SET review_head = ? WHERE id = ?').run(head, workId)

      const perRun = (work.review_sel ? JSON.parse(work.review_sel) : undefined) as Record<
        string,
        { agentID?: string; model?: ModelRef } | undefined
      > | undefined
      const skills = new Set((await listSkills().catch(() => [])).map((s) => s.id))
      const uiChanged = await this.uiFilesChanged(work.worktree_dir)

      const plan: Array<{ role: ReviewRole; skipReason?: string; error?: string }> = [
        { role: 'sol' },
        { role: 'testAudit' },
        uiChanged
          ? skills.has('impeccable')
            ? { role: 'impeccable' }
            : { role: 'impeccable', error: 'UI changes detected but the impeccable skill is not installed' }
          : { role: 'impeccable', skipReason: 'no UI files changed on this branch' }
      ]

      const now = Date.now()
      // Columns: work_id, round, role, session_id, status, findings, error, agent_id, provider_id, model_id, created_at, updated_at
      const insert = getDb().prepare(
        `INSERT INTO review(work_id, round, role, session_id, status, findings, error, agent_id, provider_id, model_id, created_at, updated_at)
         VALUES(?,?,?,NULL,?,?,NULL,?,?,?,?,?)`
      )

      const live: Array<{ reviewId: number; role: ReviewRole; sel: { agentID?: string; model?: ModelRef } }> = []
      for (const p of plan) {
        const sel = resolveSel(workId, p.role, perRun)
        if (p.error) {
          const res = insert.run(workId, round, p.role, 'error', '', sel.agentID ?? null, sel.model?.providerID ?? null, sel.model?.id ?? null, now, now)
          this.update(Number(res.lastInsertRowid), 'error', undefined, p.error)
          continue
        }
        if (p.skipReason) {
          insert.run(workId, round, p.role, 'skipped', p.skipReason, sel.agentID ?? null, sel.model?.providerID ?? null, sel.model?.id ?? null, now, now)
          continue
        }
        const res = insert.run(workId, round, p.role, 'pending', '', sel.agentID ?? null, sel.model?.providerID ?? null, sel.model?.id ?? null, now, now)
        live.push({ reviewId: Number(res.lastInsertRowid), role: p.role, sel })
      }
      this.push(workId, round)

      // Fan out concurrently — one OpenCode session per reviewer.
      await Promise.allSettled(
        live.map(async ({ reviewId, role, sel }) => {
          try {
            const api = openCodeService.api
            const session = await api.session.create({
              title: `${work.ticket_key} · ${role} (round ${round})`,
              agent: sel.agentID ?? null,
              model: sel.model ? { providerID: sel.model.providerID, id: sel.model.id } : null,
              location: { directory: work.worktree_dir },
              metadata: { revva: { kind: 'review', workId, round, role } }
            })
            this.update(reviewId, 'running', undefined, undefined, session.id)
            const timer = setTimeout(() => {
              const t = this.sessions.get(session.id)
              if (t) void this.settle(session.id, 'error', undefined, `reviewer timed out after ${SESSION_TIMEOUT_MS / 60000} min`)
              void openCodeService.api.session.interrupt({ sessionID: session.id }).catch(() => undefined)
            }, SESSION_TIMEOUT_MS)
            this.sessions.set(session.id, { workId, round, role, reviewId, timer })
            await api.session.prompt({ sessionID: session.id, text: reviewerPrompt(role, work, round, skills) })
          } catch (err) {
            for (const [sessionId, tracked] of this.sessions) {
              if (tracked.reviewId === reviewId) {
                clearTimeout(tracked.timer)
                this.sessions.delete(sessionId)
                void openCodeService.api.session.interrupt({ sessionID: sessionId }).catch(() => undefined)
              }
            }
            this.update(reviewId, 'error', undefined, describeError(err))
          }
        })
      )
      this.push(workId, round)
      // Sessions that failed to even start settle the round immediately.
    } catch (err) {
      workManager.setReviewState(workId, 'WAITING_HUMAN', `Could not start review: ${describeError(err)}`)
      throw err
    } finally {
      this.starting.delete(workId)
    }
    void this.settleRoundIfDone(workId, round)
  }

  /** workManager calls this when a tracked reviewer/fixer session finished. */
  isBusyReviewing(workId: string): boolean {
    if (this.starting.has(workId)) return true
    for (const t of this.sessions.values()) if (t.workId === workId) return true
    return false
  }

  isStartingReview(workId: string): boolean {
    return this.starting.has(workId)
  }

  /** Interrupt everything in flight and mark rows error. Used by abandon(). */
  async cancelWork(workId: string): Promise<void> {
    for (const [sessionId, t] of [...this.sessions]) {
      if (t.workId !== workId) continue
      clearTimeout(t.timer)
      this.sessions.delete(sessionId)
      await openCodeService.api.session.interrupt({ sessionID: sessionId }).catch(() => undefined)
      this.update(t.reviewId, 'error', undefined, 'cancelled')
    }
  }

  /* ---------- event handling ---------- */

  private onEvent(e: RawEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>
    const sessionId = data.sessionID
    if (typeof sessionId !== 'string') return
    const tracked = this.sessions.get(sessionId)
    if (!tracked) return

    switch (e.type) {
      case 'session.text.delta': {
        // Forward live text so the cockpit can show reviewers thinking in real time.
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.eventPush, {
            kind: 'review.delta',
            workId: tracked.workId,
            sessionId,
            messageId: String(data.assistantMessageID ?? ''),
            text: String(data.delta ?? '')
          })
        }
        break
      }
      case 'session.execution.succeeded':
        void this.settle(sessionId, undefined)
        break
      case 'session.execution.failed':
        void this.settle(sessionId, 'error', undefined, describeError(data.error ?? 'session failed'))
        break
      case 'session.execution.interrupted':
        void this.settle(sessionId, 'error', undefined, 'reviewer was interrupted')
        break
    }
  }

  /** Pull the reviewer's final message, parse its verdict, persist, maybe finish the round. */
  private async settle(sessionId: string, forcedStatus?: ReviewStatus, findings?: string, error?: string): Promise<void> {
    const t = this.sessions.get(sessionId)
    if (!t || this.settling.has(sessionId)) return
    this.settling.add(sessionId)
    clearTimeout(t.timer)

    let status: ReviewStatus = forcedStatus ?? 'changes'
    let text = findings ?? ''
    if (!forcedStatus) {
      try {
        // desc so the limit keeps the newest messages; first assistant = final reply.
        const res = await openCodeService.api.message.list({ sessionID: sessionId, order: 'desc', limit: 200 })
        const lastAssistant = res.data.find((m) => m.type === 'assistant')
        for (const part of (lastAssistant as { content?: unknown[] })?.content ?? []) {
          const p = part as Record<string, unknown>
          if (p.type === 'text' && typeof p.text === 'string') text += p.text
        }
        status = t.role === 'fixer' ? 'approved' : parseVerdict(text)
      } catch (err) {
        status = 'error'
        error = describeError(err)
      }
    }
    if (this.sessions.get(sessionId) !== t) {
      this.settling.delete(sessionId)
      return
    }
    this.update(t.reviewId, status, text, error)
    this.sessions.delete(sessionId)
    this.settling.delete(sessionId)
    this.push(t.workId, t.round)

    if (t.role === 'fixer') {
      if (status === 'approved') {
        // Fixes committed → next round of reviewers.
        workManager.setReviewState(t.workId, 'REVIEW')
        await this.startRound(t.workId, t.round + 1).catch((err) => {
          workManager.setReviewState(t.workId, 'WAITING_HUMAN', `Could not restart review: ${describeError(err)}`)
          this.audit(t.workId, t.round, 'review-restart-failed', describeError(err))
        })
      } else {
        workManager.setReviewState(t.workId, 'WAITING_HUMAN', `Fixer failed: ${error ?? 'session did not complete'}`)
        this.audit(t.workId, t.round, 'fixer-failed', error ?? 'fixer session did not complete')
      }
      return
    }
    void this.settleRoundIfDone(t.workId, t.round)
  }

  /** When every reviewer row of the round is terminal, compute the outcome (fan-in). */
  private async settleRoundIfDone(workId: string, round: number): Promise<void> {
    if (this.isBusyReviewing(workId)) return
    const key = `${workId}:${round}`
    if (this.settledRounds.has(key)) return
    const rows = this.reviewsFor(workId).filter((r) => r.round === round && r.role !== 'fixer')
    if (rows.length === 0) return
    if (rows.some((r) => r.status === 'pending' || r.status === 'running')) return
    this.settledRounds.add(key) // fan-in runs exactly once per round, even on parallel settle

    const errors = rows.filter((r) => r.status === 'error')
    const changes = rows.filter((r) => r.status === 'changes')

    if (errors.length > 0) {
      workManager.setReviewState(workId, 'WAITING_HUMAN', `Review blocked: ${errors.map((r) => `${r.role}: ${r.error ?? 'did not complete'}`).join('; ')}`)
      this.audit(workId, round, 'reviewer-error', `${errors.length} reviewer(s) did not complete — approval blocked`)
      return
    }
    if (changes.length === 0) {
      this.starting.add(workId)
      try {
        const work = getDb().prepare('SELECT worktree_dir, review_head FROM work WHERE id = ?').get(workId) as { worktree_dir: string; review_head: string | null }
        const [head, status] = await Promise.all([
          exec('git', ['-C', work.worktree_dir, 'rev-parse', 'HEAD']),
          exec('git', ['-C', work.worktree_dir, 'status', '--porcelain'])
        ])
        if (!work.review_head || head.stdout.trim() !== work.review_head || status.stdout.trim()) {
          throw new Error('The worktree changed during review. Commit the changes and re-run review.')
        }
      } catch (err) {
        const reason = describeError(err)
        workManager.setReviewState(workId, 'WAITING_HUMAN', `Review blocked: ${reason}`)
        this.audit(workId, round, 'review-invalidated', reason)
        return
      } finally {
        this.starting.delete(workId)
      }
      const work = getDb().prepare('SELECT mode, ship_on_approve FROM work WHERE id = ?').get(workId) as { mode: string; ship_on_approve: number | null } | undefined
      this.audit(workId, round, 'approved', rows.map((r) => `${r.role}: ${r.status}`).join(', '))
      workManager.setReviewState(workId, 'APPROVED')
      if (work?.mode === 'auto' || work?.ship_on_approve) {
        // Opt-in only: push + PR the moment all gates pass (existing PR is updated).
        void shipManager.autoShip(workId)
      }
      return
    }
    const maxRounds = Math.min(settingGet<number>('reviewMaxRounds') ?? 3, 5)
    const cycle = getDb().prepare('SELECT review_cycle_start FROM work WHERE id = ?').get(workId) as { review_cycle_start: number | null } | undefined
    if (round - (cycle?.review_cycle_start ?? 1) + 1 >= maxRounds) {
      workManager.setReviewState(workId, 'WAITING_HUMAN', `Review rounds exhausted: ${changes.length} reviewer(s) still request changes. Address the findings and re-run review.`)
      this.audit(workId, round, 'rounds-exhausted', `still ${changes.length} reviewer(s) requesting changes after ${round} rounds`)
      return
    }
    await this.dispatchFixer(workId, round, changes)
  }

  /** Fan-in: one fixer session gets all findings from the round. */
  private async dispatchFixer(workId: string, round: number, changes: ReviewRow[]): Promise<void> {
    const work = getDb().prepare('SELECT * FROM work WHERE id = ?').get(workId) as
      | { id: string; ticket_key: string; branch: string; worktree_dir: string; mode: string; review_sel: string | null }
      | undefined
    if (!work) return
    const perRun = (work.review_sel ? JSON.parse(work.review_sel) : undefined) as Record<string, { agentID?: string; model?: ModelRef } | undefined> | undefined
    const sel = resolveSel(workId, 'fixer', perRun)
    const now = Date.now()
    const res = getDb()
      .prepare(
        `INSERT INTO review(work_id, round, role, session_id, status, findings, error, agent_id, provider_id, model_id, created_at, updated_at)
         VALUES(?,?,?,NULL,'pending','',NULL,?,?,?,?,?)`
      )
      .run(workId, round, 'fixer', sel.agentID ?? null, sel.model?.providerID ?? null, sel.model?.id ?? null, now, now)
    const reviewId = Number(res.lastInsertRowid)
    this.audit(workId, round, 'fixer-dispatched', changes.map((c) => c.role).join(', ') + ' requested changes')
    workManager.setReviewState(workId, 'FIXING')
    this.push(workId, round)

    this.starting.add(workId)
    try {
      const api = openCodeService.api
      const session = await api.session.create({
        title: `${work.ticket_key} · fix (after round ${round})`,
        agent: sel.agentID ?? null,
        model: sel.model ? { providerID: sel.model.providerID, id: sel.model.id } : null,
        location: { directory: work.worktree_dir },
        metadata: { revva: { kind: 'review', workId, round, role: 'fixer' } }
      })
      this.update(reviewId, 'running', undefined, undefined, session.id)
      const timer = setTimeout(() => {
        if (this.sessions.has(session.id)) {
          void this.settle(session.id, 'error', undefined, 'fixer timed out')
          void api.session.interrupt({ sessionID: session.id }).catch(() => undefined)
        }
      }, SESSION_TIMEOUT_MS)
      this.sessions.set(session.id, { workId, round, role: 'fixer', reviewId, timer })
      this.starting.delete(workId)
      await api.session.prompt({ sessionID: session.id, text: fixerPrompt(work, round, changes) })
    } catch (err) {
      for (const [sessionId, tracked] of this.sessions) {
        if (tracked.reviewId === reviewId) {
          clearTimeout(tracked.timer)
          this.sessions.delete(sessionId)
          void openCodeService.api.session.interrupt({ sessionID: sessionId }).catch(() => undefined)
        }
      }
      this.update(reviewId, 'error', undefined, describeError(err))
      workManager.setReviewState(workId, 'WAITING_HUMAN', `Could not start fixer: ${describeError(err)}`)
    } finally {
      this.starting.delete(workId)
    }
    this.push(workId, round)
  }

  /* ---------- helpers ---------- */

  /** True when the branch touches UI-ish files (drives whether impeccable runs). */
  private async uiFilesChanged(worktreeDir: string): Promise<boolean> {
    let files = ''
    try {
      const bases = ['origin/main', 'main', 'origin/master', 'master']
      let base = ''
      for (const b of bases) {
        try {
          await exec('git', ['-C', worktreeDir, 'merge-base', 'HEAD', b])
          base = b
          break
        } catch {
          /* try next */
        }
      }
      files = base
        ? (await exec('git', ['-C', worktreeDir, 'diff', '--name-only', `${base}...HEAD`])).stdout
        : (await exec('git', ['-C', worktreeDir, 'show', '--name-only', '--pretty=format:', 'HEAD'])).stdout
    } catch (err) {
      throw new Error(`Could not determine whether UI files changed: ${describeError(err)}`)
    }
    return files.split('\n').some((file) => /\.(tsx|jsx|vue|svelte|css|scss|less|html)$/i.test(file.trim()))
  }

  private update(
    reviewId: number,
    status: ReviewStatus,
    findings?: string,
    error?: string,
    sessionId?: string
  ): void {
    getDb()
      .prepare(
        `UPDATE review SET status = ?,
           findings = COALESCE(?, findings),
           error = COALESCE(?, error),
           session_id = COALESCE(?, session_id),
           updated_at = ?
         WHERE id = ?`
      )
      .run(status, findings ?? null, error ?? null, sessionId ?? null, Date.now(), reviewId)
  }

  private audit(workId: string, round: number | null, kind: string, detail: string): void {
    ensureSchema()
    console.log(`[review:${kind}] ${workId} round=${round}: ${detail}`)
    getDb().prepare('INSERT INTO auto_decision(work_id, round, kind, detail, created_at) VALUES(?,?,?,?,?)').run(workId, round, kind, detail, Date.now())
  }

  private push(workId: string, round: number): void {
    const reviews = this.reviewsFor(workId)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.eventPush, { kind: 'review.updated', workId, round, reviews })
    }
  }
}

/* ---------- prompts ---------- */

function reviewerPrompt(
  role: ReviewRole,
  work: { ticket_key: string; branch: string; worktree_dir: string },
  round: number,
  skills: Set<string>
): string {
  const common = [
    `You are Revva's ${role} reviewer for ticket ${work.ticket_key}, round ${round}.`,
    `Repository worktree: ${work.worktree_dir} (branch ${work.branch}). Review ONLY the changes this branch introduces vs its base.`,
    '',
    'STRICT READ-ONLY: do not edit or create files, do not commit, do not push, do not start subagents or other agents.',
    ''
  ]
  const roleBody: Record<ReviewRole, string> = {
    sol: `${skills.has('sol-loop') ? 'Apply the sol-loop review protocol (use the sol-loop skill).' : 'Apply an adversarial senior-engineer review protocol.'}\nFor each finding give: severity (blocker / major / minor), file:line, why it matters, and a concrete fix. Judge correctness, edge cases, and fit with the ticket's intent.`,
    testAudit: `${skills.has('test-audit') ? 'Apply the test-audit skill to the changed code and tests.' : 'Audit the tests around the changed code as a strict test reviewer.'}\nFlag: untested acceptance criteria, implementation-coupled or duplicative tests, tests that cannot fail. Missing meaningful coverage for changed behavior is a major.`,
    impeccable: 'Apply the impeccable skill to the UI changes on this branch: hierarchy, spacing, typography, states, responsiveness, and copy. Flag anything that would embarrass the author in a design review.'
  }
  const verdict = `blockers or majors ⇒ CHANGES; minors-only or clean ⇒ APPROVED.`
  return [
    ...common,
    roleBody[role],
    '',
    'Report your findings concisely, then end your message with EXACTLY one final line, no punctuation after it:',
    'VERDICT: APPROVED',
    'or',
    'VERDICT: CHANGES',
    `(${verdict})`
  ].join('\n')
}

function fixerPrompt(
  work: { ticket_key: string; branch: string; worktree_dir: string },
  round: number,
  changes: ReviewRow[]
): string {
  const findings = changes
    .map((c) => `=== ${c.role} (round ${c.round}) ===\n${c.findings.trim()}`)
    .join('\n\n')
  return [
    `You are Revva's fixer for ticket ${work.ticket_key} after review round ${round}.`,
    `Worktree: ${work.worktree_dir} (branch ${work.branch}).`,
    '',
    'Independent reviewers found issues. Fix ALL blockers and majors; use judgment on minors and note anything you consciously skip.',
    'Keep the tree committable and commit your fixes with clear messages referencing ' + work.ticket_key + '. Do not push or open PRs.',
    'When done, summarize what you changed and what you skipped (with reasons).',
    '',
    findings
  ].join('\n')
}

export const reviewManager = new ReviewManager()
