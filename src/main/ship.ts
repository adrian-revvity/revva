/**
 * M5 ship: commit-tree checks → push → PR via gh (open in browser) → Jira transition + summary.
 * Stacked work targets the parent work's branch as PR base, which is what gh-stack expects.
 * Never merges, never force-pushes. AUTO mode ships right after all gates approve;
 * interactive mode waits for the Ship button. Every choice is written to auto_decision.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { shell } from 'electron'
import { getDb } from './db'
import { jiraMcp } from './jira/mcp'
import { workManager } from './pipeline/works'
import { mergeRevvaSection } from '@shared/pr-description'
import type { ShipCheck, ShipResult } from '@shared/types'

const exec = promisify(execFile)

interface ShipWorkRow {
  id: string
  ticket_key: string
  repo_dir: string
  branch: string
  worktree_dir: string
  mode: string
  state: string
  parent_work_id: string | null
  pr_url: string | null
  review_head: string | null
}

function audit(workId: string, kind: string, detail: string): void {
  console.log(`[ship:${kind}] ${workId}: ${detail}`)
  getDb().prepare('INSERT INTO auto_decision(work_id, round, kind, detail, created_at) VALUES(?,?,?,? ,?)').run(workId, null, kind, detail, Date.now())
}

/** Parse git@github.com:owner/repo(.git) or https://github.com/owner/repo(.git). */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const m = url.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  return m ? { owner: m[1]!, repo: m[2]! } : undefined
}

class ShipManager {
  private shipping = new Set<string>()

  isShipping(workId: string): boolean {
    return this.shipping.has(workId)
  }

  /** Cheap pre-flight; every check says what to fix. ok=true ⇒ Ship is safe. */
  async checks(workId: string): Promise<ShipCheck[]> {
    const work = this.requireWork(workId)
    const checks: ShipCheck[] = []

    const gh = await this.probe('gh', ['--version'])
    checks.push(
      gh.ok
        ? { name: 'GitHub CLI', ok: true, detail: gh.out.split('\n')[0] ?? 'found' }
        : { name: 'GitHub CLI', ok: false, detail: 'install gh (https://cli.github.com) — coding/review still work without it' }
    )
    if (gh.ok) {
      const auth = await this.probe('gh', ['auth', 'status'])
      checks.push(
        auth.ok
          ? { name: 'GitHub auth', ok: true, detail: 'logged in' }
          : { name: 'GitHub auth', ok: false, detail: 'run `gh auth login` in a terminal' }
      )
    }

    const remote = await this.probe('git', ['-C', work.worktree_dir, 'remote', 'get-url', 'origin'])
    const repo = remote.ok ? parseGitHubRemote(remote.out) : undefined
    checks.push(
      repo
        ? { name: 'GitHub remote', ok: true, detail: `${repo.owner}/${repo.repo}` }
        : { name: 'GitHub remote', ok: false, detail: `origin is not a GitHub repo (${remote.out || 'no remote'})` }
    )

    const status = await this.probe('git', ['-C', work.worktree_dir, 'status', '--porcelain'])
    const dirty = status.ok && status.out.trim().length > 0
    checks.push(
      !status.ok
        ? { name: 'Clean tree', ok: false, detail: 'worktree not readable — recreate the work' }
        : dirty
          ? { name: 'Clean tree', ok: false, detail: `${status.out.trim().split('\n').length} uncommitted change(s) — resume the build and commit them` }
          : { name: 'Clean tree', ok: true, detail: 'everything committed' }
    )

    const head = await this.probe('git', ['-C', work.worktree_dir, 'rev-parse', 'HEAD'])
    // review_head is set at the start of a round, not when it passes. A matching
    // hash alone must never turn a failed or still-running review green.
    const latestRound = getDb().prepare("SELECT MAX(round) AS round FROM review WHERE work_id = ? AND role != 'fixer'").get(workId) as { round: number | null }
    const approved = latestRound.round != null && !!getDb().prepare("SELECT 1 FROM auto_decision WHERE work_id = ? AND round = ? AND kind = 'approved' LIMIT 1").get(workId, latestRound.round)
    const latest = new Map<string, { status: string; findings: string }>()
    if (latestRound.round != null) {
      const rows = getDb().prepare("SELECT role, status, findings FROM review WHERE work_id = ? AND round = ? AND role != 'fixer' ORDER BY id").all(workId, latestRound.round) as Array<{ role: string; status: string; findings: string }>
      for (const row of rows) latest.set(row.role, row)
    }
    const gatesPassed = (['sol', 'testAudit', 'impeccable'] as const).every((role) => {
      const row = latest.get(role)
      return row?.status === 'approved' || (role === 'impeccable' && row?.status === 'skipped' && row.findings === 'no UI files changed on this branch')
    })
    checks.push(
      (work.state === 'APPROVED' || work.state === 'SHIPPED') && approved && gatesPassed && head.ok && !!work.review_head && head.out.trim() === work.review_head
        ? { name: 'Reviewed commit', ok: true, detail: 'current commit passed review' }
        : { name: 'Reviewed commit', ok: false, fatal: false, detail: 'current commit has not passed review — re-run review, or ship anyway from the dialog' }
    )

    let ahead = { ok: false, out: '', err: '' }
    for (const baseRef of ['origin/HEAD', 'origin/main', 'main', 'origin/master', 'master']) {
      ahead = await this.probe('git', ['-C', work.worktree_dir, 'rev-list', '--count', 'HEAD', `^${baseRef}`])
      if (ahead.ok) break
    }
    const nCommits = ahead.ok ? Number(ahead.out.trim()) : NaN
    checks.push(
      Number.isFinite(nCommits) && nCommits > 0
        ? { name: 'Commits ahead of base', ok: true, detail: `${nCommits} commit(s) to ship` }
        : { name: 'Commits ahead of base', ok: false, detail: 'nothing committed on this branch yet' }
    )

    const jiraOk = jiraMcp.connected
    checks.push({
      name: 'Jira sync',
      ok: jiraOk,
      fatal: false,
      detail: jiraOk ? 'status transition + summary comment after PR' : 'not connected — PR will be created without Jira updates'
    })
    return checks
  }

  /** Push + PR + Jira. With an already-linked PR this just pushes to it (update);
   *  otherwise it creates one. Throws with a readable message when a fatal check fails.
   *  Outside APPROVED/SHIPPED (e.g. WAITING_HUMAN, REWORK) shipping is allowed but the
   *  unreviewed commit is audited — the dialog shows the warning; `strict` (AUTO) keeps
   *  the reviewed-commit check fatal because nobody is watching. */
  async ship(workId: string, opts: { strict?: boolean } = {}): Promise<ShipResult> {
    if (this.shipping.has(workId)) throw new Error('Shipping is already in progress.')
    this.shipping.add(workId)
    try {
      const checks = await this.checks(workId)
      const fatal = checks.find(
        (c) => !c.ok && (c.fatal !== false || (opts.strict && c.name === 'Reviewed commit'))
      )
      if (fatal) throw new Error(`Cannot ship: ${fatal.name} — ${fatal.detail}`)
      const work = this.requireWork(workId)
      if (work.state === 'BUILDING' || work.state === 'REVIEW' || work.state === 'FIXING') {
        throw new Error('Reviews are still running.')
      }
      if (work.state === 'READY' || work.state === 'ABANDONED') {
        throw new Error(`Cannot ship from state ${work.state}.`)
      }
      if (checks.some((c) => c.name === 'Reviewed commit' && !c.ok)) {
        audit(workId, 'ship-unreviewed', `shipping from ${work.state} — reviewed-commit gate acknowledged by user`)
      }


      audit(workId, 'ship-start', `branch ${work.branch}${work.pr_url ? ' (update existing PR)' : ''}`)

      // 1. Push (never force). -u so gh and gh-stack see the tracking branch.
      const push = await this.probe('git', ['-C', work.worktree_dir, 'push', '-u', 'origin', work.branch])
      if (!push.ok) throw new Error(`git push failed: ${push.err.slice(0, 400)}`)
      audit(workId, 'pushed', work.branch)

      // 2. PR: linked already ⇒ the push above updated it — no second PR, ever.
      if (work.pr_url) {
        const reviews = this.reviewLedger(workId)
        const jira = await this.syncJira(work, work.pr_url, reviews)
        audit(workId, 'jira-sync', jira)
        getDb().prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(Date.now(), workId)
        workManager.setReviewState(workId, 'SHIPPED')
        return { prUrl: work.pr_url, alreadyShipped: true }
      }

      // No PR yet: create one. Stacked work bases on the parent work's branch — this is the
      // gh-stack relationship (child base = parent branch); plain gh pr create keeps bases correct.
      const base = await this.baseFor(work)
      const reviews = this.reviewLedger(workId)
      const title = this.prTitle(work)
      const body = await this.prBody(work, reviews, base)
      const prArgs = [
        'pr', 'create',
        '--base', base,
        '--head', work.branch,
        '--title', title,
        '--body', body
      ]
      const pr = await this.probeIn(work.worktree_dir, 'gh', prArgs)
      const prUrl = pr.ok ? pr.out.trim().split('\n').filter(Boolean).at(-1) ?? '' : ''
      if (!pr.ok || !prUrl.startsWith('http')) {
        throw new Error(`gh pr create failed: ${(pr.err || pr.out).slice(0, 400)}`)
      }
      audit(workId, 'pr-created', `${prUrl} (base ${base})`)
      getDb().prepare('UPDATE work SET pr_url = ?, updated_at = ? WHERE id = ?').run(prUrl, Date.now(), workId)
      void shell.openExternal(prUrl)

      // 3. Jira: transition to review-ish status + summary comment. Best effort.
      const jira = await this.syncJira(work, prUrl, reviews)
      audit(workId, 'jira-sync', jira)

      workManager.setReviewState(workId, 'SHIPPED')
      return { prUrl, alreadyShipped: false }
    } finally {
      this.shipping.delete(workId)
    }
  }

  private reviewLedger(workId: string): Array<{ role: string; round: number; status: string }> {
    return getDb()
      .prepare("SELECT role, round, status FROM review WHERE work_id = ? AND role != 'fixer' ORDER BY round, id")
      .all(workId) as Array<{ role: string; round: number; status: string }>
  }

  /** Push existing commits to the branch (used by rework); never force. */
  async pushOnly(worktreeDir: string, branch: string): Promise<void> {
    const push = await this.probe('git', ['-C', worktreeDir, 'push', 'origin', branch])
    if (!push.ok) throw new Error(`git push failed: ${push.err.slice(0, 400)}`)
  }

  /** AUTO mode: called by the review pipeline the moment all gates approve. */
  async autoShip(workId: string): Promise<void> {
    try {
      const res = await this.ship(workId, { strict: true })
      audit(workId, 'auto-shipped', res.prUrl)
    } catch (err) {
      // Keep the approved gate and let the user retry shipping after resolving the blocker.
      const reason = err instanceof Error ? err.message : String(err)
      audit(workId, 'auto-ship-blocked', reason)
      workManager.setReviewState(workId, 'APPROVED', `Automatic shipping failed: ${reason}`)
    }
  }

  private async baseFor(work: ShipWorkRow): Promise<string> {
    if (work.parent_work_id) {
      const parent = getDb().prepare('SELECT branch FROM work WHERE id = ?').get(work.parent_work_id) as { branch: string } | undefined
      if (parent) return parent.branch
    }
    // Lineage recorded at worktree creation survives outside our DB.
    const recorded = await this.probe('git', ['-C', work.worktree_dir, 'config', 'branch.' + work.branch + '.base'])
    if (recorded.ok && recorded.out.trim()) return recorded.out.trim().replace('origin/', '')
    const head = await this.probe('git', ['-C', work.worktree_dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'])
    if (head.ok) return head.out.trim().replace('origin/', '')
    return 'main'
  }

  private prTitle(work: ShipWorkRow): string {
    const ticket = getDb().prepare('SELECT summary FROM ticket WHERE key = ?').get(work.ticket_key) as { summary: string } | undefined
    return `${work.ticket_key}: ${ticket?.summary ?? work.branch}`
  }

  private async prBody(work: ShipWorkRow, reviews: Array<{ role: string; round: number; status: string }>, base: string, head = 'HEAD'): Promise<string> {
    const rounds = Math.max(0, ...reviews.map((r) => r.round))
    const byRole = new Map<string, string>()
    for (const r of reviews) byRole.set(r.role, r.status)
    const ticket = getDb().prepare('SELECT summary FROM ticket WHERE key = ?').get(work.ticket_key) as { summary: string } | undefined
    let log: { ok: boolean; out: string; err: string } | undefined
    for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`, base]) {
      log = await this.probe('git', ['-C', work.worktree_dir, 'log', '--format=%s', '--no-merges', `${ref}..${head}`])
      if (log.ok) break
    }
    const commits = log?.ok ? log.out.split('\n').map((line) => line.trim()).filter(Boolean) : []
    return mergeRevvaSection(
      '',
      [
        '## Summary',
        '',
        ticket?.summary ? `${work.ticket_key}: ${ticket.summary}` : work.ticket_key,
        '',
        '## Changes',
        ...(commits.length ? commits.map((subject) => `- ${subject}`) : ['- Change details were unavailable; see the PR diff.']),
        '',
        '## Review gates',
        ...([...byRole].length ? [...byRole].map(([role, status]) => `- **${role}**: ${status}`) : ['- No review results recorded.']),
        ...(rounds ? [`_${rounds} review round(s); see Revva for full findings._`] : [])
      ].join('\n')
    )
  }

  /** Transition to a review-ish status and drop the PR summary comment; never throws. */
  private async syncJira(
    work: ShipWorkRow,
    prUrl: string,
    reviews: Array<{ role: string; round: number; status: string }>
  ): Promise<string> {
    if (!jiraMcp.connected) return 'skipped: Jira not connected'
    const notes: string[] = []
    try {
      const raw = (await jiraMcp.listTransitions(work.ticket_key)) as { transitions?: Array<{ id: string; name: string; to?: { name?: string } }> }
      const options = raw?.transitions ?? []
      const pick =
        options.find((t) => /in review|review/i.test(t.to?.name ?? t.name ?? '')) ??
        options.find((t) => /ready.*(test|qa)|testing/i.test(t.to?.name ?? t.name ?? ''))
      if (pick) {
        await jiraMcp.transitionIssue(work.ticket_key, pick.id)
        notes.push(`transitioned to "${pick.to?.name ?? pick.name}"`)
      } else {
        notes.push(`no review-ish transition available (${options.map((t) => t.name).join(', ') || 'none'})`)
      }
    } catch (err) {
      notes.push(`transition failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const byRole = new Map<string, string>()
      for (const r of reviews) byRole.set(r.role, r.status)
      await jiraMcp.addComment(
        work.ticket_key,
        [
          `*revva*: PR opened — ${prUrl}`,
          '',
          ...[...byRole].map(([role, status]) => `* ${role}: ${status}`)
        ].join('\n')
      )
      notes.push('summary comment added')
    } catch (err) {
      notes.push(`comment failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return notes.join('; ')
  }

  private requireWork(workId: string): ShipWorkRow {
    const work = getDb()
      .prepare('SELECT id, ticket_key, repo_dir, branch, worktree_dir, mode, state, parent_work_id, pr_url, review_head FROM work WHERE id = ?')
      .get(workId) as ShipWorkRow | undefined
    if (!work) throw new Error('Work not found.')
    return work
  }

  /** run and capture; ok = exit 0. */
  private async probe(cmd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    return this.probeIn(undefined, cmd, args)
  }

  private async probeIn(cwd: string | undefined, cmd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    try {
      const res = await exec(cmd, args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
      return { ok: true, out: res.stdout, err: res.stderr }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      return { ok: false, out: e.stdout ?? '', err: e.stderr ?? e.message ?? String(err) }
    }
  }
}

export const shipManager = new ShipManager()
