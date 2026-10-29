/**
 * GitHub integration via the user's `gh` CLI (REQ: no GitHub tokens of our own;
 * feature-detect and surface errors honestly). Multi-repo by design: PRs are always
 * identified by URL or owner/repo#n — never a bare number.
 *
 * Review flow: fetch PR detail → reuse (or clone) the repo under a workspaces root →
 * detached worktree at the PR head → read-only review session seeded with the tuned prompt.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { app, BrowserWindow, Notification } from 'electron'
import { openCodeService, describeError } from './opencode/service'
import { chatManager } from './opencode/chats'
import { getDb, roleConfigGet, settingGet, settingSet } from './db'
import { workManager } from './pipeline/works'
import { renderPrompt, DEFAULT_PR_REVIEW_PROMPT } from '@shared/prompts'
import { parsePrRef, repoFromGitRemote } from '@shared/pr-ref'
import { ticketKeyFromText } from '@shared/ticket-key'
import { IPC, type PrAlert, type PrMergeMethod, type PrDetail, type PrStack, type PullRequest, type TaskSessionResult } from '@shared/types'

const exec = promisify(execFile)

async function gh(args: string[], cwd?: string, opts?: { timeoutMs?: number }): Promise<{ ok: boolean; out: string; err: string; code: number }> {
  return run('gh', args, cwd, opts)
}

/** gh does not understand `-C`; git commands must run through git with -C. */
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return run('git', ['-C', cwd, ...args], undefined)
}

async function run(cmd: string, args: string[], cwd?: string, opts?: { timeoutMs?: number }): Promise<{ ok: boolean; out: string; err: string; code: number }> {
  try {
    const res = await exec(cmd, args, { cwd, timeout: opts?.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, out: res.stdout, err: res.stderr, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number }
    return { ok: false, out: e.stdout ?? '', err: e.stderr ?? e.message ?? String(err), code: typeof e.code === 'number' ? e.code : 1 }
  }
}

type Row = {
  repository?: { nameWithOwner?: string }
  title?: string
  url?: string
  number?: number
  isDraft?: boolean
  updatedAt?: string
  state?: string
  commentsCount?: number
}

/** Per-PR "what I've already seen" watermark, persisted across restarts. */
type PrSeen = {
  latestOtherAt: number
  total: number
  /** Whether the PR conflicted when the user last looked. */
  conflicting?: boolean
  /** Review decision the user last saw (none = first sighting baseline). */
  decision?: string
  /** Unresolved review threads the user last saw (none = first sighting baseline). */
  threads?: number
}
const SEEN_KEY = 'githubPrSeen'
const POLL_INTERVAL_MS = 60_000
const DESKTOP_NOTIFICATION_INTERVAL_MS = 5 * 60_000

class GitHubManager {
  private login: string | undefined
  /** url → latest enrichment info, so markSeen does not refetch. */
  private lastInfo = new Map<string, PrSeen>()
  private lastMine: PullRequest[] | undefined
  private refreshes = new Map<'mine' | 'review', Promise<PullRequest[]>>()

  /** Feature-detect for the UI (tab shows a hint instead of errors when gh is missing). */
  async available(): Promise<boolean> {
    return (await gh(['--version'])).ok
  }

  private async myLogin(): Promise<string | undefined> {
    if (this.login !== undefined) return this.login
    const res = await gh(['api', 'user', '--jq', '.login'])
    this.login = res.ok ? res.out.trim() : undefined
    return this.login
  }

  /**
   * Background freshness for authored PRs, independent of the selected screen.
   * Every successful Mine refresh publishes alerts, including UI refreshes.
   */
  private pollTimer: NodeJS.Timeout | undefined
  private notifiedKeys = new Set<string>()
  private polling = false
  private lastDesktopPoll = 0

  startPolling(): void {
    if (this.pollTimer) return
    const tick = async (): Promise<void> => {
      if (this.polling) return
      this.polling = true
      try {
        if (!(await this.available())) return
        const alerts = await this.alerts()
        // Sidebar freshness is independent of the existing desktop cadence.
        const now = Date.now()
        if (now - this.lastDesktopPoll < DESKTOP_NOTIFICATION_INTERVAL_MS) return
        this.lastDesktopPoll = now
        const fresh = alerts.filter((a) => a.kinds.some((k) => !this.notifiedKeys.has(`${a.url}#${k}`)))
        for (const a of fresh) a.kinds.forEach((k) => this.notifiedKeys.add(`${a.url}#${k}`))
        const keys = new Set(alerts.flatMap((a) => a.kinds.map((k) => `${a.url}#${k}`)))
        for (const k of [...this.notifiedKeys]) if (!keys.has(k)) this.notifiedKeys.delete(k)
        if (fresh.length > 0 && Notification.isSupported()) {
          const n = new Notification({
            title: fresh.length === 1 ? 'PR update' : `${fresh.length} PR updates`,
            body: fresh.slice(0, 3).map((a) => `${a.repo}#${a.number}: ${a.kinds.join(', ')}`).join('\n'),
            silent: false
          })
          n.on('click', () => {
            for (const win of BrowserWindow.getAllWindows()) {
              if (win.isMinimized()) win.restore()
              win.show()
              win.focus()
            }
          })
          n.show()
        }
      } catch (err) {
        console.log('[github] poll failed:', describeError(err))
      } finally {
        this.polling = false
      }
    }
    this.pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS)
    void tick()
  }

  /** New comments / conflicts / approvals on MY PRs only. The review-requested
   *  scope never alerts — its PRs are not even fetched until the tab is opened. */
  async alerts(): Promise<PrAlert[]> {
    await this.list('mine')
    if (!this.lastMine) throw new Error('GitHub alert status could not be refreshed. Check gh authentication and connectivity; existing alerts are kept.')
    return this.alertsFrom(this.lastMine)
  }

  private alertsFrom(prs: PullRequest[]): PrAlert[] {
    const byUrl = new Map<string, PrAlert>()
    for (const pr of prs) {
      if (pr.merged || pr.state.toLowerCase() !== 'open') continue
      const kinds: PrAlert['kinds'] = []
      if (pr.hasNewComments) kinds.push('comment')
      if (pr.hasNewConflicts) kinds.push('conflict')
      if (pr.hasNewApproval) kinds.push('approval')
      if (pr.hasNewReviewThreads) kinds.push('review')
      if (kinds.length === 0) continue
      byUrl.set(pr.url, { url: pr.url, repo: pr.repo, number: pr.number, title: pr.title, kinds })
    }
    return [...byUrl.values()]
  }

  /** UI reads and background polls both update the sidebar's alert indicator. */
  private publishAlerts(): void {
    if (!this.lastMine) return
    this.pushAlerts(this.alertsFrom(this.lastMine))
  }

  /** Clear alert flags for the given PRs (all current alerts when omitted). */
  async markAlertsSeen(urls?: string[]): Promise<void> {
    const targets = urls && urls.length > 0 ? urls : (this.lastMine ? this.alertsFrom(this.lastMine) : await this.alerts()).map((a) => a.url)
    for (const url of targets) this.markSeen(url)
    // Acknowledge the displayed snapshot, not newer events fetched during dismissal.
    this.publishAlerts()
  }

  private pushAlerts(items: PrAlert[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.eventPush, { kind: 'github.alerts', items })
    }
  }

  /** Open PRs I authored, or PRs where my review is requested. Merged PRs are
   *  deliberately absent — they are done, not waiting on anyone. */
  async list(scope: 'mine' | 'review' = 'mine'): Promise<PullRequest[]> {
    const pending = this.refreshes.get(scope)
    if (pending) return pending
    const refresh = this.fetchList(scope)
    this.refreshes.set(scope, refresh)
    try {
      return await refresh
    } finally {
      if (this.refreshes.get(scope) === refresh) this.refreshes.delete(scope)
    }
  }

  private async fetchList(scope: 'mine' | 'review'): Promise<PullRequest[]> {
    const fields = 'repository,title,url,number,isDraft,updatedAt,state,commentsCount'
    const searches: string[][] = [
      scope === 'mine'
        ? ['search', 'prs', '--author=@me', '--state=open', '--sort=updated', '--order=desc', '--limit', '40']
        : ['search', 'prs', '--review-requested=@me', '--state=open', '--sort=updated', '--order=desc', '--limit', '40']
    ]
    const rows: Row[] = []
    let errored = ''
    for (const args of searches) {
      const res = await gh([...args, '--json', fields])
      if (!res.ok) {
        errored = errored || res.err.trim().split('\n')[0] || 'gh search failed — is `gh auth login` done?'
        continue
      }
      rows.push(...(JSON.parse(res.out || '[]') as Row[]))
    }
    if (rows.length === 0 && errored) throw new Error(errored)
    const seenUrls = new Set<string>()
    const prs = rows
      .filter((r) => r.url && r.number && !seenUrls.has(r.url) && !!seenUrls.add(r.url))
      .map((r) => ({
        repo: r.repository?.nameWithOwner ?? 'unknown',
        number: r.number!,
        title: r.title ?? '',
        url: r.url!,
        state: r.state ?? 'open',
        isDraft: !!r.isDraft,
        updatedAt: Date.parse(r.updatedAt ?? '') || Date.now(),
        commentsCount: r.commentsCount
      }))
    const enriched = await this.enrich(prs)
    if (scope === 'mine') {
      if (enriched) {
        this.lastMine = prs
        this.publishAlerts()
      } else {
        // A failed status lookup is not proof that comments/conflicts disappeared.
        const previous = new Map((this.lastMine ?? []).map((pr) => [pr.url, pr]))
        for (const pr of prs) {
          const saved = previous.get(pr.url)
          if (saved) Object.assign(pr, { ...saved, ...pr })
        }
      }
    }
    return prs
  }

  /**
   * One batched GraphQL call adds reviewDecision + merged state + recent comments,
   * then flags PRs with a not-yet-seen comment from someone else (first sighting of
   * a PR only sets the baseline — no false "new" for pre-existing comments).
   */
  private async enrich(prs: PullRequest[]): Promise<boolean> {
    if (prs.length === 0) return true
    const byRepo = new Map<string, PullRequest[]>()
    for (const pr of prs) {
      const list = byRepo.get(pr.repo) ?? []
      list.push(pr)
      byRepo.set(pr.repo, list)
    }
    let q = '{'
    const refs: Array<{ path: [string, string]; pr: PullRequest }> = []
    let ri = 0
    for (const [repo, list] of byRepo) {
      const [owner, name] = repo.split('/')
      if (!owner || !name) continue
      const rAlias = `r${ri++}`
      q += ` ${rAlias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { defaultBranchRef { name }`
      list.forEach((pr, pi) => {
        const pAlias = `p${pi}`
        q += ` ${pAlias}: pullRequest(number: ${pr.number}) { reviewDecision state mergedAt mergeable mergeStateStatus headRefName baseRefName reviewThreads(first: 100) { totalCount nodes { isResolved } } comments(last: 10) { totalCount nodes { author { login } createdAt } } }`
        refs.push({ path: [rAlias, pAlias], pr })
      })
      q += ' }'
    }
    q += '}'
    const res = await gh(['api', 'graphql', '--field', `query=${q}`])
    if (!res.ok) {
      console.warn('[github] PR status refresh failed; existing alerts kept:', res.err.trim().slice(0, 300))
      return false // the list still renders; alert state stays intact
    }
    type Node = { author?: { login?: string } | null; createdAt?: string }
    type PrNode = {
      reviewDecision?: string | null
      state?: string
      mergedAt?: string | null
      mergeable?: string
      mergeStateStatus?: string
      headRefName?: string
      baseRefName?: string
      reviewThreads?: { totalCount?: number; nodes?: Array<{ isResolved?: boolean }> }
      comments?: { totalCount?: number; nodes?: Node[] }
    }
    type RepoNode = { defaultBranchRef?: { name?: string } | null; [alias: string]: unknown }
    const payload = JSON.parse(res.out) as { data?: Record<string, RepoNode>; errors?: Array<{ message?: string }> }
    const data = payload.data ?? {}
    if (payload.errors?.length || refs.length !== prs.length || refs.some(({ path }) => !data[path[0]]?.[path[1]])) {
      console.warn('[github] Incomplete PR status refresh; existing alerts kept.')
      return false
    }
    const me = await this.myLogin()
    if (!me) {
      console.warn('[github] Could not determine the GitHub account; existing alerts kept.')
      return false
    }
    const seenMap = settingGet<Record<string, PrSeen>>(SEEN_KEY) ?? {}
    let seenDirty = false

    for (const { path, pr } of refs) {
      const repo = data[path[0]]
      const node = repo?.[path[1]] as PrNode | undefined
      if (!node) continue
      pr.reviewDecision = node.reviewDecision || undefined
      pr.headRefName = node.headRefName || undefined
      pr.baseRefName = node.baseRefName || undefined
      pr.defaultBranch = repo?.defaultBranchRef?.name || undefined
      if (node.state) pr.state = node.state.toLowerCase()
      if (node.mergedAt || node.state === 'MERGED') {
        pr.merged = true
        pr.state = 'merged'
      }
      const seen = seenMap[pr.url]
      const conflicting = node.mergeable === 'CONFLICTING' || node.mergeStateStatus === 'DIRTY'
      const knownMergeability = conflicting || node.mergeable === 'MERGEABLE'
      // UNKNOWN while GitHub recomputes is not a conflict-resolution event.
      const observedConflict = knownMergeability ? conflicting : this.lastInfo.get(pr.url)?.conflicting ?? seen?.conflicting
      pr.mergeable = conflicting ? 'CONFLICTING' : node.mergeable === 'MERGEABLE' || node.mergeable === 'UNKNOWN' ? node.mergeable : undefined
      pr.mergeStateStatus = node.mergeStateStatus || undefined
      const others = (node.comments?.nodes ?? [])
        .filter((n) => n.author?.login && n.author.login !== me)
        .map((n) => ({ author: n.author!.login!, at: Date.parse(n.createdAt ?? '') || 0 }))
        .filter((n) => n.at > 0)
        .sort((a, b) => b.at - a.at)
      const total = node.comments?.totalCount ?? pr.commentsCount ?? 0
      pr.commentsCount = total
      const latest = others[0]
      const unresolved = (node.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length
      pr.unresolvedThreads = unresolved
      this.lastInfo.set(pr.url, { latestOtherAt: latest?.at ?? 0, total, conflicting: observedConflict, decision: pr.reviewDecision, threads: unresolved })
      pr.latestOtherCommentAuthor = latest?.author
      pr.latestOtherCommentAt = latest?.at
      if (!seen) {
        // First sighting: set the baseline — no false "new" for pre-existing state.
        seenMap[pr.url] = { latestOtherAt: latest?.at ?? 0, total, conflicting: observedConflict, decision: pr.reviewDecision, threads: unresolved }
        seenDirty = true
        pr.hasNewComments = false
        pr.hasNewConflicts = false
        pr.hasNewApproval = false
      } else {
        // Rearm recurring events when their prior episode definitively clears.
        // Do not acknowledge unrelated unread comments or other current alerts.
        if (knownMergeability && !conflicting && seen.conflicting !== false) {
          seen.conflicting = false
          seenDirty = true
        }
        if (node.reviewDecision !== undefined && node.reviewDecision !== 'APPROVED' && seen.decision === 'APPROVED') {
          seen.decision = pr.reviewDecision
          seenDirty = true
        }
        if (node.reviewThreads && unresolved < (seen.threads ?? 0)) {
          seen.threads = unresolved
          seenDirty = true
        }
        pr.hasNewComments = !!latest && latest.at > seen.latestOtherAt
        // Conflict and approval flags fire on the *transition* into the state.
        pr.hasNewConflicts = observedConflict === true && !seen.conflicting
        pr.hasNewApproval = pr.reviewDecision === 'APPROVED' && seen.decision !== 'APPROVED'
        // New review feedback: thread count rose since the user last looked
        // (old threads staying unresolved must not nag).
        pr.hasNewReviewThreads = unresolved > (seen.threads ?? 0)
      }
      // Merged PRs cannot be conflicted; the merged lookback listing still shows them.
      if (pr.merged) {
        pr.hasNewConflicts = false
        pr.hasNewApproval = false
      }
    }
    if (seenDirty) settingSet(SEEN_KEY, seenMap)
    return true
  }

  /** Acknowledge this PR's current comments, conflicts, approvals and review feedback. */
  markSeen(prUrl: string): void {
    const info = this.lastInfo.get(prUrl)
    if (!info) return
    const seenMap = settingGet<Record<string, PrSeen>>(SEEN_KEY) ?? {}
    seenMap[prUrl] = info
    settingSet(SEEN_KEY, seenMap)
    const pr = this.lastMine?.find((item) => item.url === prUrl)
    if (pr) {
      pr.hasNewComments = false
      pr.hasNewConflicts = false
      pr.hasNewApproval = false
      pr.hasNewReviewThreads = false
      this.publishAlerts()
    }
  }

  async detail(prUrl: string): Promise<PrDetail> {
    const res = await gh([
      'pr', 'view', prUrl,
      '--json', 'number,title,url,state,isDraft,updatedAt,headRefName,baseRefName,reviewDecision,body,mergeable,mergeStateStatus'
    ])
    if (!res.ok) throw new Error(`Could not read PR: ${res.err.trim().split('\n')[0] ?? 'gh failed'}`)
    const r = JSON.parse(res.out) as Record<string, unknown>
    return {
      repo: parsePrRef(prUrl)?.repo ?? 'unknown',
      number: Number(r.number),
      title: String(r.title ?? ''),
      url: String(r.url ?? prUrl),
      state: String(r.state ?? 'open'),
      isDraft: !!r.isDraft,
      updatedAt: Date.parse(String(r.updatedAt ?? '')) || Date.now(),
      headRefName: String(r.headRefName ?? ''),
      baseRefName: String(r.baseRefName ?? ''),
      reviewDecision: r.reviewDecision ? String(r.reviewDecision) : undefined,
      body: r.body ? String(r.body) : undefined,
      mergeable:
        r.mergeable === 'MERGEABLE' || r.mergeable === 'CONFLICTING' || r.mergeable === 'UNKNOWN'
          ? (r.mergeable as PrDetail['mergeable'])
          : undefined,
      mergeStateStatus: r.mergeStateStatus ? String(r.mergeStateStatus) : undefined
    }
  }

  private ticketForPr(pr: PrDetail): string | undefined {
    const linked = getDb().prepare('SELECT DISTINCT ticket_key FROM work WHERE pr_url = ?').all(pr.url) as Array<{ ticket_key: string }>
    if (linked.length === 1) return linked[0]!.ticket_key
    if (linked.length > 1) return undefined
    // The title is the authoritative source; the branch is only a fallback.
    return ticketKeyFromText(pr.title) ?? ticketKeyFromText(pr.headRefName)
  }

  /** Start from the current PR head in a new worktree; never modify another checkout. */
  async solveConflicts(prUrl: string): Promise<TaskSessionResult> {
    const pr = await this.detail(prUrl)
    if (pr.state.toLowerCase() !== 'open') throw new Error('Only open PRs can have conflicts resolved.')
    const [owner, name] = pr.repo.split('/')
    if (!owner || !name || !pr.baseRefName || !pr.headRefName) throw new Error('Could not determine the PR repository and branches.')

    const root = settingGet<string>('worktreeRoot') || join(app.getPath('home'), `${basename(app.getPath('home'))}-worktrees`)
    const reposDir = join(root, 'gh-reviews', owner)
    mkdirSync(reposDir, { recursive: true })
    const repoDir = join(reposDir, name)
    if (!existsSync(join(repoDir, '.git'))) {
      const clone = await gh(['repo', 'clone', pr.repo, repoDir, '--', '--quiet'])
      if (!clone.ok) throw new Error(`git clone failed: ${(clone.err || clone.out).slice(0, 300)}`)
    }
    const remote = await git(repoDir, ['remote', 'get-url', 'origin'])
    if (!remote.ok || repoFromGitRemote(remote.out)?.toLowerCase() !== pr.repo.toLowerCase()) {
      throw new Error(`The existing checkout at ${repoDir} does not have ${pr.repo} as its origin.`)
    }

    const id = randomUUID()
    const ref = `refs/revva/conflicts/${id}`
    const fetch = await git(repoDir, ['fetch', '--no-tags', 'origin', `pull/${pr.number}/head:${ref}`])
    if (!fetch.ok) throw new Error(`Could not fetch PR head: ${(fetch.err || fetch.out).slice(0, 300)}`)
    const branch = `revva/conflicts-pr${pr.number}-${id}`
    const worktreeDir = join(reposDir, `${name}-conflicts-pr${pr.number}-${id}`)
    const add = await git(repoDir, ['worktree', 'add', '-b', branch, worktreeDir, ref])
    if (!add.ok) throw new Error(`Could not create conflict worktree: ${(add.err || add.out).slice(0, 300)}`)

    const chat = await chatManager.create({
      directory: worktreeDir,
      title: `${pr.repo}#${pr.number} conflicts`.slice(0, 80),
      ticketKey: this.ticketForPr(pr),
      prUrl: pr.url
    }).catch((err) => {
      throw new Error(`Worktree created at ${worktreeDir}, but the chat could not start: ${describeError(err)}`)
    })
    const text = [
      `Resolve the merge conflicts for PR ${pr.url} (${pr.repo}#${pr.number}: ${pr.title}).`,
      `This isolated worktree starts at the fetched PR head (${pr.headRefName}) on local branch ${branch}. The PR base is ${pr.baseRefName} in ${pr.repo}.`,
      'Inspect the changes and the repository instructions. Fetch the current base branch from origin and merge it into this worktree; resolve conflicts carefully, preserving the intent of both sides. Run the relevant checks and report the result and any uncertainty.',
      'Do not alter other worktrees, rewrite existing history, force-push, push, merge the PR on GitHub, or discard unrelated changes. Leave the resolution committed locally and explain how to update the PR; ask the user before any push.'
    ].join('\n\n')
    await openCodeService.api.session.prompt({ sessionID: chat.sessionId, text }).catch((err) => {
      throw new Error(`Chat created at ${worktreeDir}, but the prompt failed: ${describeError(err)}`)
    })
    return { sessionId: chat.sessionId, title: chat.title, directory: worktreeDir }
  }

  /**
   * "Answer the review comments": a chat checked out on the PR's branch, primed
   * to read every unresolved review thread, fix what is valid, push, reply to
   * each thread and resolve it. Prefers the ticket's own worktree so the fixes
   * land on the real branch; otherwise a fresh branch worktree at the PR head.
   */
  async solveComments(prUrl: string): Promise<TaskSessionResult> {
    const pr = await this.detail(prUrl)
    if (pr.state.toLowerCase() !== 'open') throw new Error('Only open PRs have review threads to answer.')
    const [owner, name] = pr.repo.split('/')
    if (!owner || !name) throw new Error('Could not determine the PR repository.')
    const ticketKey = this.ticketForPr(pr)

    let directory: string | undefined
    let branchNote = `the PR head branch ${pr.headRefName}`
    if (ticketKey) {
      const row = getDb()
        .prepare(`SELECT worktree_dir FROM work WHERE ticket_key = ? AND branch = ? ORDER BY created_at DESC LIMIT 1`)
        .get(ticketKey, pr.headRefName) as { worktree_dir: string } | undefined
      if (row && existsSync(row.worktree_dir)) directory = row.worktree_dir
    }
    if (!directory) {
      const root = settingGet<string>('worktreeRoot') || join(app.getPath('home'), `${basename(app.getPath('home'))}-worktrees`)
      const reposDir = join(root, 'gh-reviews', owner)
      mkdirSync(reposDir, { recursive: true })
      const repoDir = join(reposDir, name)
      if (!existsSync(join(repoDir, '.git'))) {
        const clone = await gh(['repo', 'clone', pr.repo, repoDir, '--', '--quiet'])
        if (!clone.ok) throw new Error(`git clone failed: ${(clone.err || clone.out).slice(0, 300)}`)
      }
      const id = randomUUID()
      const ref = `refs/revva/comments/${id}`
      const fetch = await git(repoDir, ['fetch', '--no-tags', 'origin', `pull/${pr.number}/head:${ref}`])
      if (!fetch.ok) throw new Error(`Could not fetch PR head: ${(fetch.err || fetch.out).slice(0, 300)}`)
      const branch = `revva/comments-pr${pr.number}-${id}`
      const worktreeDir = join(reposDir, `${name}-comments-pr${pr.number}-${id}`)
      const add = await git(repoDir, ['worktree', 'add', '-b', branch, worktreeDir, ref])
      if (!add.ok) throw new Error(`Could not create comments worktree: ${(add.err || add.out).slice(0, 300)}`)
      directory = worktreeDir
      branchNote = `local branch ${branch}, fetched from the PR head — push it with \`git push origin HEAD:refs/heads/${pr.headRefName}\``
    }

    const chat = await chatManager.create({
      directory,
      title: `${pr.repo}#${pr.number} review comments`.slice(0, 80),
      ticketKey,
      prUrl: pr.url
    }).catch((err) => {
      throw new Error(`Worktree ready at ${directory}, but the chat could not start: ${describeError(err)}`)
    })
    const gqlThreads = `{ r: repository(owner: "${owner}", name: "${name}") { p: pullRequest(number: ${pr.number}) { reviewThreads(first: 100) { nodes { id isResolved path comments(first: 20) { nodes { author { login } body databaseId } } } } } } }`
    const text = [
      `Answer the unresolved review threads of PR ${pr.url} (${pr.repo}#${pr.number}: ${pr.title}). You are in the checkout of ${branchNote}.`,
      `1. List every thread and keep the unresolved ones — note each thread's node id and each first comment's databaseId:\n   \`gh api graphql -f query='${gqlThreads}'\`\n   Treat every isResolved=false thread as your worklist.`,
      '2. For each thread: verify the reviewer\'s claim against the code before touching anything. Fix valid feedback properly (root cause, not symptom-patching); where a comment is mistaken or out of scope, prepare a short factual reply instead of a change. Follow the repository\'s instructions and run the checks the changes touch.',
      directory.includes('-comments-pr')
        ? '3. Commit the fixes on this branch, then push them to the PR: `git push origin ' + `HEAD:refs/heads/${pr.headRefName}` + '`. Plain push only — never force.'
        : '3. Commit the fixes on this branch and push them to the PR head (`git push origin HEAD`). If the checkout carries unrelated uncommitted changes, do not touch or commit them.',
      `4. For every thread, reply under its first comment — \`gh api repos/${owner}/${name}/pulls/${pr.number}/comments -f body="<reply>" -F in_reply_to=<comment databaseId>\` — stating what you changed (with file:line) or why the comment does not apply. Then resolve it — \`gh api graphql -f query='mutation { resolveReviewThread(input: { threadId: "<thread node id>" }) { thread { isResolved } } }'\`.`,
      'Never force-push, never merge the PR, never touch other worktrees. Finish with a one-line-per-thread summary: fixed or answered.'
    ].join('\n\n')
    await openCodeService.api.session.prompt({ sessionID: chat.sessionId, text }).catch((err) => {
      throw new Error(`Chat created at ${directory}, but the prompt failed: ${describeError(err)}`)
    })
    this.markSeen(pr.url)
    return { sessionId: chat.sessionId, title: chat.title, directory }
  }

  /**
   * Merge a PR with the chosen method. GitHub enforces the repo's own rules
   * (approvals, checks, branch protection) — we surface its refusal verbatim.
   * This is an explicit user action; revva's automatic shipping still never merges.
   */
  async merge(prUrl: string, method: PrMergeMethod): Promise<void> {
    const args = ['pr', 'merge', prUrl, `--${method}`, '--delete-branch']
    const res = await gh(args)
    if (!res.ok) {
      const msg = (res.err || res.out).trim().split('\n').slice(0, 3).join(' ')
      throw new Error(`Merge failed: ${msg.slice(0, 300)}`)
    }
    // Reflect the merge locally at once: flags + linked work's state when known.
    this.markSeen(prUrl)
    const work = getDb().prepare('SELECT id FROM work WHERE pr_url = ?').get(prUrl) as { id: string } | undefined
    if (work) workManager.setReviewState(work.id, 'SHIPPED')
  }

  /**
   * Rebase the PR's head branch onto its base and force-with-lease push.
   * Runs in a throwaway worktree under the gh-reviews root — the user's own
   * working trees are never touched. Fails honestly when the head lives on a
   * fork we cannot push to, or when the rebase conflicts (leaving the
   * throwaway untouched state is irrelevant; the branch was never pushed).
   */
  async rebase(prUrl: string): Promise<void> {
    const pr = await this.detail(prUrl)
    if (pr.merged || pr.state === 'merged') throw new Error('This PR is already merged.')
    if (pr.state === 'closed') throw new Error('This PR is closed.')
    const root = settingGet<string>('worktreeRoot') || join(app.getPath('home'), `${basename(app.getPath('home'))}-worktrees`)
    const reposDir = join(root, 'gh-reviews', pr.repo.split('/')[0]!)
    mkdirSync(reposDir, { recursive: true })
    const repoDir = join(reposDir, pr.repo.split('/')[1]!)
    if (!existsSync(join(repoDir, '.git'))) {
      const clone = await gh(['repo', 'clone', pr.repo, repoDir, '--', '--quiet'])
      if (!clone.ok) throw new Error(`git clone failed: ${(clone.err || clone.out).slice(0, 300)}`)
    }
    const fetchHead = await git(repoDir, ['fetch', 'origin', `pull/${pr.number}/head:revva/rebase-${pr.number}`])
    if (!fetchHead.ok) throw new Error(`git fetch of PR head failed: ${fetchHead.err.slice(0, 300)}`)
    const fetchBase = await git(repoDir, ['fetch', 'origin', pr.baseRefName])
    if (!fetchBase.ok) throw new Error(`git fetch of ${pr.baseRefName} failed: ${fetchBase.err.slice(0, 300)}`)

    const worktreeDir = join(reposDir, `${pr.repo.split('/')[1]}-rebase-pr${pr.number}`)
    await git(repoDir, ['worktree', 'prune'])
    await git(repoDir, ['worktree', 'remove', '--force', worktreeDir])
    const add = await git(repoDir, ['worktree', 'add', worktreeDir, `revva/rebase-${pr.number}`])
    if (!add.ok) throw new Error(`git worktree add failed: ${add.err.slice(0, 300)}`)
    try {
      const rebase = await git(worktreeDir, ['rebase', `origin/${pr.baseRefName}`])
      if (!rebase.ok) {
        await git(worktreeDir, ['rebase', '--abort'])
        throw new Error(`Rebase conflicts in ${pr.headRefName} — resolve locally: git rebase origin/${pr.baseRefName}`)
      }
      // The PR head branch may be behind a fork; push permission is whatever gh/git grants.
      const push = await git(worktreeDir, ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${pr.headRefName}`])
      if (!push.ok) {
        throw new Error(`Push of rebased branch failed (fork head?): ${push.err.slice(0, 300)}`)
      }
      this.markSeen(prUrl)
    } finally {
      await git(repoDir, ['worktree', 'remove', '--force', worktreeDir])
      await git(repoDir, ['branch', '-D', `revva/rebase-${pr.number}`])
    }
  }

  /**
   * Push a conversation's worktree HEAD to the PR's head branch — never force.
   * This is the missing last step of the conflict-resolution chat: it commits
   * the resolution locally and asks before pushing; this is the explicit push.
   */
  async push(prUrl: string, directory: string): Promise<void> {
    const pr = await this.detail(prUrl)
    if (pr.state.toLowerCase() !== 'open') throw new Error('This PR is not open.')
    if (!existsSync(join(directory, '.git'))) throw new Error(`No git checkout at ${directory}.`)
    const remote = await git(directory, ['remote', 'get-url', 'origin'])
    if (!remote.ok || repoFromGitRemote(remote.out)?.toLowerCase() !== pr.repo.toLowerCase()) {
      throw new Error(`The checkout at ${directory} does not have ${pr.repo} as its origin.`)
    }
    const push = await git(directory, ['push', 'origin', `HEAD:refs/heads/${pr.headRefName}`])
    if (!push.ok) {
      const err = (push.err || push.out).slice(0, 300)
      if (/rejected|non-fast-forward/i.test(err)) {
        throw new Error(`Push rejected — the PR moved on GitHub. Merge or rebase the new head in ${directory} first (or use Rebase onto base).`)
      }
      throw new Error(`git push failed: ${err}`)
    }
    this.markSeen(prUrl)
  }

  /**
   * Find the `gh stack` stack containing this PR's branch, if a local checkout
   * tracks one. Stacks are local state, so this probes the candidate checkouts
   * (the conversation's worktree, linked works, the gh-reviews clone) with
   * `gh stack view --json` and matches the PR number. Null when the PR is not
   * stacked — or when the extension is not installed at all.
   */
  async stackForPr(prUrl: string, directory?: string): Promise<PrStack | null> {
    const pr = await this.detail(prUrl)
    const root = settingGet<string>('worktreeRoot') || join(app.getPath('home'), `${basename(app.getPath('home'))}-worktrees`)
    const [owner, name] = pr.repo.split('/')
    const reposDir = join(root, 'gh-reviews', owner ?? '')
    const candidates: string[] = []
    if (directory) candidates.push(directory)
    for (const row of getDb().prepare('SELECT repo_dir, worktree_dir FROM work WHERE pr_url = ? OR repo_dir IN (SELECT repo_dir FROM work WHERE pr_url = ?)').all(pr.url, pr.url) as Array<{ repo_dir: string; worktree_dir: string }>) {
      candidates.push(row.worktree_dir, row.repo_dir)
    }
    if (owner && name && existsSync(reposDir)) {
      candidates.push(join(reposDir, name))
      for (const entry of readdirSync(reposDir)) {
        if (entry.startsWith(`${name}-`) || entry === name) candidates.push(join(reposDir, entry))
      }
    }
    const seen = new Set<string>()
    for (const dir of candidates) {
      if (!dir || seen.has(dir) || !existsSync(join(dir, '.git'))) continue
      seen.add(dir)
      const remote = await git(dir, ['remote', 'get-url', 'origin'])
      if (!remote.ok || repoFromGitRemote(remote.out)?.toLowerCase() !== pr.repo.toLowerCase()) continue
      const view = await gh(['stack', 'view', '--json'], dir, { timeoutMs: 8_000 })
      if (!view.ok) continue
      try {
        const parsed = JSON.parse(view.out) as { trunk?: string; currentBranch?: string; branches?: PrStack['branches'] }
        if (parsed.branches?.some((b) => b.pr?.number === pr.number)) {
          return { directory: dir, trunk: parsed.trunk, currentBranch: parsed.currentBranch, branches: parsed.branches }
        }
      } catch {
        /* not stack JSON (old extension output, prompt text) — try next candidate */
      }
    }
    return null
  }

  /**
   * `gh stack rebase` in the checkout that tracks the stack. A conflict makes
   * gh-stack leave branches mid-rebase (exit 3), so we abort to restore the
   * pre-rebase state and hand the user the exact directory to finish by hand.
   */
  async rebaseStack(prUrl: string, directory: string): Promise<string> {
    const pr = await this.detail(prUrl)
    if (!existsSync(join(directory, '.git'))) throw new Error(`No git checkout at ${directory}.`)
    const remote = await git(directory, ['remote', 'get-url', 'origin'])
    if (!remote.ok || repoFromGitRemote(remote.out)?.toLowerCase() !== pr.repo.toLowerCase()) {
      throw new Error(`The checkout at ${directory} does not have ${pr.repo} as its origin.`)
    }
    const rebase = await gh(['stack', 'rebase'], directory, { timeoutMs: 180_000 })
    if (rebase.code === 3) {
      await gh(['stack', 'rebase', '--abort'], directory, { timeoutMs: 60_000 })
      throw new Error(`Stack rebase conflicted — the stack was restored to its previous state. Resolve by hand in ${directory}: gh stack rebase (then --continue or --abort).`)
    }
    if (!rebase.ok) throw new Error(`gh stack rebase failed: ${(rebase.err || rebase.out).slice(0, 300)}`)
    this.markSeen(prUrl)
    const lines = (rebase.err || rebase.out).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('✓') || l.startsWith('Merged'))
    return lines.slice(0, 4).join(' · ') || 'Stack rebased.'
  }

  /**
   * Clone/fetch the repo under the review root and (re)add a detached worktree
   * at the PR head. Used by the review session, which reads the code itself;
   * "Chat with this PR" never clones — it just talks about the PR via gh.
   */
  private async ensureReviewWorktree(pr: PrDetail): Promise<string> {
    const root = settingGet<string>('worktreeRoot') || join(app.getPath('home'), `${basename(app.getPath('home'))}-worktrees`)
    const reposDir = join(root, 'gh-reviews', pr.repo.split('/')[0]!)
    mkdirSync(reposDir, { recursive: true })
    const repoDir = join(reposDir, pr.repo.split('/')[1]!)

    // Clone bare-ish on first use; fetch the PR head always.
    if (!existsSync(join(repoDir, '.git'))) {
      const clone = await gh(['repo', 'clone', pr.repo, repoDir, '--', '--quiet'])
      if (!clone.ok) throw new Error(`git clone failed: ${(clone.err || clone.out).slice(0, 300)}`)
    }
    const branch = `revva/pr-${pr.number}`
    await git(repoDir, ['worktree', 'prune'])
    const existing = await git(repoDir, ['worktree', 'list', '--porcelain'])
    const alreadyAdded = existing.ok && existing.out.includes(join(reposDir, `${pr.repo.split('/')[1]}-pr${pr.number}`))
    const worktreeDir = join(reposDir, `${pr.repo.split('/')[1]}-pr${pr.number}`)
    if (!alreadyAdded) {
      const fetch = await git(repoDir, ['fetch', 'origin', `pull/${pr.number}/head:${branch}`])
      if (!fetch.ok) throw new Error(`git fetch of PR head failed: ${fetch.err.slice(0, 300)}`)
      const add = await git(repoDir, ['worktree', 'add', '--detach', worktreeDir, branch])
      if (!add.ok) throw new Error(`git worktree add failed: ${add.err.slice(0, 300)}`)
    }
    return worktreeDir
  }

  /**
   * "Chat with this PR": a new chat linked to the PR and its ticket. A chat is
   * a conversation, not a checkout — nothing is cloned here. The directory is
   * one of ours that matches the PR when we know it (a live worktree of this
   * PR's head branch, any live worktree of its ticket, a registered workspace
   * serving this repo), otherwise the same default the New chat dialog uses
   * (last selection, then last chat). The primer tells the agent when the PR
   * is not checked out locally so it works through `gh` and the URL.
   */
  async startChat(prUrl: string): Promise<TaskSessionResult> {
    const pr = await this.detail(prUrl)
    const ticketKey = this.ticketForPr(pr)
    const { directory, onPrBranch } = await this.chatDirectoryForPr(pr, ticketKey)
    const generalSelection = settingGet<{ agentID?: string; model?: { providerID: string; id: string } } | undefined>('chat.lastSelection')
    const where = onPrBranch
      ? 'The PR branch is checked out in this directory.'
      : `This chat opens in ${directory}, which is not this PR's checkout — read the code with \`gh\` and the PR URL, not local files, unless the repo happens to be here.`
    const primer = `This chat is attached to GitHub PR ${pr.url} (${pr.repo}#${pr.number}: ${pr.title}, ${pr.headRefName} → ${pr.baseRefName})${ticketKey ? `, ticket ${ticketKey}` : ''}. ${where} Inspect it with \`gh pr view ${pr.url} --json body,files\` and \`gh pr diff ${pr.url}\` as needed.`
    // The chat opens empty; the primer rides the user's first message.
    const chat = await chatManager.create({
      directory,
      title: `${ticketKey ?? `${pr.repo}#${pr.number}`} · PR #${pr.number} chat`.slice(0, 80),
      agentID: generalSelection?.agentID,
      model: generalSelection?.model,
      ticketKey,
      prUrl: pr.url,
      context: primer
    })
    this.markSeen(prUrl)
    return { sessionId: chat.sessionId, title: chat.title, directory }
  }

  /** Directory for a PR chat: our matching checkout if known, else the default/last one. Never clones. */
  private async chatDirectoryForPr(pr: PrDetail, ticketKey?: string): Promise<{ directory: string; onPrBranch: boolean }> {
    const live = (dir: unknown): dir is string => typeof dir === 'string' && !!dir && existsSync(dir)
    const works = getDb()
      .prepare('SELECT worktree_dir, branch FROM work WHERE pr_url = ? OR (? IS NOT NULL AND ticket_key = ?) ORDER BY created_at DESC')
      .all(pr.url, ticketKey ?? null, ticketKey ?? null) as Array<{ worktree_dir: string; branch: string }>
    const onBranch = works.find((w) => w.branch === pr.headRefName && live(w.worktree_dir))
    if (onBranch) return { directory: onBranch.worktree_dir, onPrBranch: true }
    const related = works.find((w) => live(w.worktree_dir))
    if (related) return { directory: related.worktree_dir, onPrBranch: false }
    for (const ws of getDb().prepare('SELECT path FROM workspace').all() as Array<{ path: string }>) {
      if (!live(ws.path)) continue
      const remote = await git(ws.path, ['remote', 'get-url', 'origin'])
      if (remote.ok && repoFromGitRemote(remote.out)?.toLowerCase() === pr.repo.toLowerCase()) {
        return { directory: ws.path, onPrBranch: false }
      }
    }
    const lastSelection = settingGet<{ directory?: string } | undefined>('chat.lastSelection')
    if (live(lastSelection?.directory)) return { directory: lastSelection.directory, onPrBranch: false }
    const lastChat = getDb().prepare('SELECT directory FROM chat ORDER BY updated_at DESC LIMIT 1').get() as { directory: string } | undefined
    if (live(lastChat?.directory)) return { directory: lastChat.directory, onPrBranch: false }
    throw new Error(`No project folder to open this chat in — start one plain chat first so Revva knows where to put new ones.`)
  }

  /**
   * Start a PR review session: find or clone the repo, add a detached worktree at the
   * PR head, and open a chat-tagged session seeded with the (tunable) review prompt.
   */
  async startReview(prUrl: string): Promise<TaskSessionResult> {
    const pr = await this.detail(prUrl)
    const worktreeDir = await this.ensureReviewWorktree(pr)

    const sel = roleConfigGet('prReview')
    const chat = await chatManager.create({
      directory: worktreeDir,
      title: `${pr.repo}#${pr.number} review`.slice(0, 80),
      agentID: sel?.agentID,
      model: sel?.model,
      ticketKey: this.ticketForPr(pr),
      prUrl: pr.url
    })
    const template = settingGet<string>('prompt.review') || DEFAULT_PR_REVIEW_PROMPT
    const text = renderPrompt(template, {
      prUrl: pr.url,
      prNumber: String(pr.number),
      repo: pr.repo,
      title: pr.title,
      base: pr.baseRefName,
      head: pr.headRefName
    })
    await openCodeService.api.session.prompt({ sessionID: chat.sessionId, text }).catch((err) => {
      throw new Error(`Session created but review prompt failed: ${describeError(err)}`)
    })
    return { sessionId: chat.sessionId, title: chat.title, directory: worktreeDir }
  }
}

export const githubManager = new GitHubManager()
