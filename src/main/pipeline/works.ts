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
import { join, basename } from 'node:path'
import { BrowserWindow } from 'electron'
import { openCodeService, describeError } from '../opencode/service'
import { eventBus, type RawEvent } from '../opencode/bus'
import { getTicket } from '../jira/board'
import { getDb, settingGet } from '../db'
import { reviewManager } from '../review'
import { renderPrompt, DEFAULT_START_PROMPT } from '@shared/prompts'
import { IPC, type StartWorkInput, type WorkState, type WorkSummary } from '@shared/types'

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
  pr_url: string | null
  created_at: number
  updated_at: number
}

function ensureSchema(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS work (
    id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, workspace_id TEXT, repo_dir TEXT NOT NULL,
    branch TEXT NOT NULL, worktree_dir TEXT NOT NULL, parent_work_id TEXT,
    mode TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`)
  // Forward-only column additions (M4).
  const cols = getDb().prepare('PRAGMA table_info(work)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'review_sel')) {
    getDb().exec('ALTER TABLE work ADD COLUMN review_sel TEXT')
  }
  if (!cols.some((c) => c.name === 'ship_on_approve')) {
    getDb().exec('ALTER TABLE work ADD COLUMN ship_on_approve INTEGER')
  }
  if (!cols.some((c) => c.name === 'pr_url')) {
    getDb().exec('ALTER TABLE work ADD COLUMN pr_url TEXT')
  }
}

function slugBranch(key: string): string {
  return `revva/${key.toLowerCase()}`
}

class WorkManager {
  private wired = false

  wire(): void {
    if (this.wired) return
    this.wired = true
    ensureSchema()
    eventBus.on('event', (e: RawEvent) => this.onEvent(e))
  }

  list(): WorkSummary[] {
    ensureSchema()
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
      updatedAt: r.updated_at
    }
  }

  async start(input: StartWorkInput): Promise<WorkSummary> {
    if (!openCodeService.connected) throw new Error('Connect OpenCode first.')
    ensureSchema()

    const ticket = await getTicket(input.ticketKey)
    if (!ticket) throw new Error(`Ticket ${input.ticketKey} not found. Refresh the board first.`)

    // Parent (stacked) work → branch base.
    let baseRef: string | undefined
    if (input.parentWorkId) {
      const parent = getDb().prepare('SELECT * FROM work WHERE id = ?').get(input.parentWorkId) as WorkRow | undefined
      if (!parent) throw new Error('Parent work not found.')
      if (!existsSync(parent.worktree_dir)) throw new Error(`Parent worktree is gone: ${parent.worktree_dir}`)
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
        input.shipOnApprove ? 1 : 0,
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

  /** OpenCode worktree API first, `git worktree add` fallback. */
  private async createWorktree(repoDir: string, branch: string, baseRef?: string): Promise<string> {
    const root = settingGet<string>('worktreeRoot') || join(repoDir, '..', `${basename(repoDir)}-worktrees`)
    const name = branch.replace(/\//g, '-')
    const target = join(root, name)

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

    await exec('git', ['-C', repoDir, 'fetch', '--all', '--prune']).catch(() => undefined)
    const base = baseRef ?? (await defaultBranch(repoDir))
    try {
      await exec('git', ['-C', repoDir, 'worktree', 'add', '-B', branch, target, base])
    } catch (err) {
      throw new Error(`git worktree add failed: ${describeError(err)}`)
    }
    return target
  }

  private setState(id: string, state: WorkState): void {
    getDb().prepare('UPDATE work SET state = ?, updated_at = ? WHERE id = ?').run(state, Date.now(), id)
    this.emit(id, state)
  }

  /** Called by the review pipeline (REVIEW/FIXING/APPROVED/WAITING_HUMAN). */
  setReviewState(id: string, state: WorkState): void {
    const work = getDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string } | undefined
    if (!work || work.state === 'ABANDONED' || work.state === 'SHIPPED') return
    if (work.state === state) return
    this.setState(id, state)
  }

  private emit(id: string, state: WorkState): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.eventPush, { kind: 'work.updated', workId: id, state })
    }
  }

  private workBySession(sessionId: string): WorkRow | undefined {
    return getDb().prepare('SELECT * FROM work WHERE session_id = ?').get(sessionId) as WorkRow | undefined
  }

  private onEvent(e: RawEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>
    const sessionId = data.sessionID
    if (typeof sessionId !== 'string') return
    const work = this.workBySession(sessionId)
    if (!work) return

    switch (e.type) {
      case 'session.text.delta': {
        if (work.state !== 'BUILDING') return
        const msgId = String(data.assistantMessageID ?? '')
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.eventPush, {
            kind: 'work.delta',
            workId: work.id,
            sessionId,
            messageId: msgId,
            text: String(data.delta ?? '')
          })
        }
        break
      }
      case 'session.execution.succeeded': {
        if (work.state !== 'BUILDING') return
        // M4: build finished → concurrent read-only reviewer fan-out (no more auto-approve).
        this.setState(work.id, 'REVIEW')
        void reviewManager.startRound(work.id, 1).catch((err) => {
          console.warn('[work] review fan-out failed:', describeError(err))
          this.setState(work.id, 'WAITING_HUMAN')
        })
        break
      }
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        if (work.state === 'BUILDING') this.setState(work.id, 'WAITING_HUMAN')
        break
      }
    }
  }

  async abandon(id: string): Promise<void> {
    const work = getDb().prepare('SELECT * FROM work WHERE id = ?').get(id) as WorkRow | undefined
    if (!work) return
    await reviewManager.cancelWork(id)
    if (work.session_id) await openCodeService.api.session.remove({ sessionID: work.session_id }).catch(() => undefined)
    await exec('git', ['-C', work.repo_dir, 'worktree', 'remove', '--force', work.worktree_dir]).catch(() => undefined)
    this.setState(id, 'ABANDONED')
  }

  /** Follow-up message into a running/finished build session. */
  async followUp(sessionId: string, text: string): Promise<void> {
    const work = this.workBySession(sessionId)
    if (work) {
      // A human re-prompting a settled build takes it back through review.
      if (['WAITING_HUMAN', 'APPROVED', 'REVIEW', 'FIXING'].includes(work.state)) this.setState(work.id, 'BUILDING')
      this.touch(work.id)
    }
    await openCodeService.api.session.prompt({ sessionID: sessionId, text })
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

async function defaultBranch(repoDir: string): Promise<string> {
  const candidates = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']
  for (const ref of candidates) {
    try {
      await exec('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', ref])
      return ref.replace('origin/', '')
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `No usable base branch in ${repoDir} (no main/master, no commits?). Commit something or pick another repository.`
  )
}

function extractDescription(raw: unknown): string {
  const fields = (raw as { fields?: Record<string, unknown> })?.fields
  const d = fields?.description
  if (typeof d === 'string') return d
  if (d && typeof d === 'object') {
    // ADF → crude text extraction; rich rendering lands with the UI polish pass.
    const texts: string[] = []
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return void n.forEach(walk)
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>
        if (typeof o.text === 'string') texts.push(o.text)
        if (o.content) walk(o.content)
      }
    }
    walk(d)
    return texts.join('\n')
  }
  return ''
}

export const workManager = new WorkManager()
