/**
 * GitHub integration via the user's `gh` CLI (REQ: no GitHub tokens of our own;
 * feature-detect and surface errors honestly). Multi-repo by design: PRs are always
 * identified by URL or owner/repo#n — never a bare number.
 *
 * Review flow: fetch PR detail → reuse (or clone) the repo under a workspaces root →
 * detached worktree at the PR head → read-only review session seeded with the tuned prompt.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { app, BrowserWindow, Notification } from 'electron'
import { openCodeService, describeError } from './opencode/service'
import { chatManager } from './opencode/chats'
import { getDb, roleConfigGet, settingGet, settingSet } from './db'
import { workManager } from './pipeline/works'
import { renderPrompt, DEFAULT_PR_REVIEW_PROMPT } from '@shared/prompts'
import { IPC, type PrAlert, type PrMergeMethod, type PrDetail, type PullRequest, type TaskSessionResult } from '@shared/types'

const exec = promisify(execFile)

async function gh(args: string[], cwd?: string): Promise<{ ok: boolean; out: string; err: string }> {
  return run('gh', args, cwd)
}

/** gh does not understand `-C`; git commands must run through git with -C. */
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return run('git', ['-C', cwd, ...args], undefined)
}

async function run(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const res = await exec(cmd, args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, out: res.stdout, err: res.stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: e.stdout ?? '', err: e.stderr ?? e.message ?? String(err) }
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
}
const SEEN_KEY = 'githubPrSeen'
const MERGED_LOOKBACK_DAYS = 14
const POLL_INTERVAL_MS = 5 * 60_000

function todayMinus(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

class GitHubManager {
  private login: string | undefined
  /** url → latest enrichment info, so markSeen does not refetch. */
  private lastInfo = new Map<string, PrSeen>()

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
   * Background freshness: refresh both scopes every few minutes, push the alert
   * set to the renderer, and raise an OS notification only for newly raised
   * alerts (never repeats while a bell is still unacknowledged).
   */
  private pollTimer: NodeJS.Timeout | undefined
  private notifiedKeys = new Set<string>()

  startPolling(): void {
    if (this.pollTimer) return
    const tick = async (): Promise<void> => {
      try {
        if (!(await this.available())) return
        const alerts = await this.alerts()
        this.pushAlerts(alerts)
        const fresh = alerts.filter((a) => a.kinds.some((k) => !this.notifiedKeys.has(`${a.url}#${k}`)))
        for (const a of fresh) a.kinds.forEach((k) => this.notifiedKeys.add(`${a.url}#${k}`))
        const keys = new Set(alerts.flatMap((a) => a.kinds.map((k) => `${a.url}#${k}`)))
        for (const k of [...this.notifiedKeys]) if (!keys.has(k)) this.notifiedKeys.delete(k)
        if (fresh.length > 0 && Notification.isSupported()) {
          const n = new Notification({
            title: fresh.length === 1 ? 'PR update' : `${fresh.length} PR updates`,
            body: fresh
              .slice(0, 3)
              .map((a) => `${a.repo}#${a.number}: ${a.kinds.join(', ')}`)
              .join('\n'),
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
      }
    }
    this.pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS)
    void tick()
  }

  /** New comments / conflicts / approvals across both scopes. */
  async alerts(): Promise<PrAlert[]> {
    const [mine, review] = await Promise.allSettled([this.list('mine'), this.list('review')])
    const byUrl = new Map<string, PrAlert>()
    for (const res of [mine, review]) {
      if (res.status !== 'fulfilled') continue
      for (const pr of res.value) {
        const kinds: PrAlert['kinds'] = []
        if (pr.hasNewComments) kinds.push('comment')
        if (pr.hasNewConflicts) kinds.push('conflict')
        if (pr.hasNewApproval) kinds.push('approval')
        if (kinds.length === 0) continue
        const existing = byUrl.get(pr.url)
        if (existing) existing.kinds = [...new Set([...existing.kinds, ...kinds])]
        else byUrl.set(pr.url, { url: pr.url, repo: pr.repo, number: pr.number, title: pr.title, kinds })
      }
    }
    return [...byUrl.values()]
  }

  /** Clear alert flags for the given PRs (all current alerts when omitted). */
  async markAlertsSeen(urls?: string[]): Promise<void> {
    const targets = urls && urls.length > 0 ? urls : (await this.alerts()).map((a) => a.url)
    for (const url of targets) this.markSeen(url)
    this.pushAlerts(await this.alerts())
  }

  private pushAlerts(items: PrAlert[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.eventPush, { kind: 'github.alerts', items })
    }
  }

  /** Open PRs I authored (plus recently merged), or PRs where my review is requested. */
  async list(scope: 'mine' | 'review' = 'mine'): Promise<PullRequest[]> {
    const fields = 'repository,title,url,number,isDraft,updatedAt,state,commentsCount'
    const searches: string[][] =
      scope === 'mine'
        ? [
            ['search', 'prs', '--author=@me', '--state=open', '--sort=updated', '--order=desc', '--limit', '40'],
            // "accepted or not" also means merged — show recent wins next to the open ones.
            ['search', 'prs', '--author=@me', '--merged', '--merged-at', `>=${todayMinus(MERGED_LOOKBACK_DAYS)}`, '--sort=updated', '--order=desc', '--limit', '10']
          ]
        : [['search', 'prs', '--review-requested=@me', '--state=open', '--sort=updated', '--order=desc', '--limit', '40']]
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
    await this.enrich(prs)
    return prs
  }

  /**
   * One batched GraphQL call adds reviewDecision + merged state + recent comments,
   * then flags PRs with a not-yet-seen comment from someone else (first sighting of
   * a PR only sets the baseline — no false "new" for pre-existing comments).
   */
  private async enrich(prs: PullRequest[]): Promise<void> {
    if (prs.length === 0) return
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
      q += ` ${rAlias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {`
      list.forEach((pr, pi) => {
        const pAlias = `p${pi}`
        q += ` ${pAlias}: pullRequest(number: ${pr.number}) { reviewDecision state mergedAt mergeable mergeStateStatus comments(last: 10) { totalCount nodes { author { login } createdAt } } }`
        refs.push({ path: [rAlias, pAlias], pr })
      })
      q += ' }'
    }
    q += '}'
    const res = await gh(['api', 'graphql', '--field', `query=${q}`])
    if (!res.ok) return // enrichment is best-effort; the list still renders without badges
    type Node = { author?: { login?: string } | null; createdAt?: string }
    type PrNode = {
      reviewDecision?: string
      state?: string
      mergedAt?: string | null
      mergeable?: string
      mergeStateStatus?: string
      comments?: { totalCount?: number; nodes?: Node[] }
    }
    const data = (JSON.parse(res.out) as { data?: Record<string, Record<string, PrNode>> }).data ?? {}
    const me = await this.myLogin()
    const seenMap = settingGet<Record<string, PrSeen>>(SEEN_KEY) ?? {}
    let seenDirty = false

    for (const { path, pr } of refs) {
      const node = data[path[0]]?.[path[1]]
      if (!node) continue
      pr.reviewDecision = node.reviewDecision || undefined
      if (node.mergedAt || node.state === 'MERGED') {
        pr.merged = true
        pr.state = 'merged'
      }
      const conflicting = node.mergeable === 'CONFLICTING'
      pr.mergeable = node.mergeable === 'MERGEABLE' || node.mergeable === 'CONFLICTING' || node.mergeable === 'UNKNOWN' ? node.mergeable : undefined
      pr.mergeStateStatus = node.mergeStateStatus || undefined
      const others = (node.comments?.nodes ?? [])
        .filter((n) => n.author?.login && n.author.login !== me)
        .map((n) => ({ author: n.author!.login!, at: Date.parse(n.createdAt ?? '') || 0 }))
        .filter((n) => n.at > 0)
        .sort((a, b) => b.at - a.at)
      const total = node.comments?.totalCount ?? pr.commentsCount ?? 0
      pr.commentsCount = total
      const latest = others[0]
      this.lastInfo.set(pr.url, { latestOtherAt: latest?.at ?? 0, total, conflicting, decision: pr.reviewDecision })
      pr.latestOtherCommentAuthor = latest?.author
      pr.latestOtherCommentAt = latest?.at
      const seen = seenMap[pr.url]
      if (!seen) {
        // First sighting: set the baseline — no false "new" for pre-existing state.
        seenMap[pr.url] = { latestOtherAt: latest?.at ?? 0, total, conflicting, decision: pr.reviewDecision }
        seenDirty = true
        pr.hasNewComments = false
        pr.hasNewConflicts = false
        pr.hasNewApproval = false
      } else {
        pr.hasNewComments = !!latest && latest.at > seen.latestOtherAt
        // Conflict and approval flags fire on the *transition* into the state.
        pr.hasNewConflicts = conflicting && !seen.conflicting
        pr.hasNewApproval = pr.reviewDecision === 'APPROVED' && seen.decision !== 'APPROVED'
      }
      // Merged PRs cannot be conflicted; the merged lookback listing still shows them.
      if (pr.merged) {
        pr.hasNewConflicts = false
        pr.hasNewApproval = false
      }
    }
    if (seenDirty) settingSet(SEEN_KEY, seenMap)
  }

  /** Dismiss the "new comment" flag (called on Review click and by the ✓ button). */
  markSeen(prUrl: string): void {
    const info = this.lastInfo.get(prUrl)
    if (!info) return
    const seenMap = settingGet<Record<string, PrSeen>>(SEEN_KEY) ?? {}
    seenMap[prUrl] = info
    settingSet(SEEN_KEY, seenMap)
  }

  async detail(prUrl: string): Promise<PrDetail> {
    const res = await gh([
      'pr', 'view', prUrl,
      '--json', 'repository,number,title,url,state,isDraft,updatedAt,headRefName,baseRefName,reviewDecision,body'
    ])
    if (!res.ok) throw new Error(`Could not read PR: ${res.err.trim().split('\n')[0] ?? 'gh failed'}`)
    const r = JSON.parse(res.out) as Record<string, unknown>
    return {
      repo: (r.repository as { nameWithOwner?: string })?.nameWithOwner ?? 'unknown',
      number: Number(r.number),
      title: String(r.title ?? ''),
      url: String(r.url ?? prUrl),
      state: String(r.state ?? 'open'),
      isDraft: !!r.isDraft,
      updatedAt: Date.parse(String(r.updatedAt ?? '')) || Date.now(),
      headRefName: String(r.headRefName ?? ''),
      baseRefName: String(r.baseRefName ?? ''),
      reviewDecision: r.reviewDecision ? String(r.reviewDecision) : undefined,
      body: r.body ? String(r.body) : undefined
    }
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
      const clone = await gh(['repo', 'clone', '--quiet', `https://github.com/${pr.repo}.git`, repoDir])
      if (!clone.ok) throw new Error(`git clone failed: ${clone.err.slice(0, 300)}`)
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
   * Start a PR review session: find or clone the repo, add a detached worktree at the
   * PR head, and open a chat-tagged session seeded with the (tunable) review prompt.
   */
  async startReview(prUrl: string): Promise<TaskSessionResult> {
    const pr = await this.detail(prUrl)
    const root = settingGet<string>('worktreeRoot') || join(app.getPath('home'), `${basename(app.getPath('home'))}-worktrees`)
    const reposDir = join(root, 'gh-reviews', pr.repo.split('/')[0]!)
    mkdirSync(reposDir, { recursive: true })
    const repoDir = join(reposDir, pr.repo.split('/')[1]!)

    // Clone bare-ish on first use; fetch the PR head always.
    if (!existsSync(join(repoDir, '.git'))) {
      const clone = await gh(['repo', 'clone', '--quiet', `https://github.com/${pr.repo}.git`, repoDir])
      if (!clone.ok) throw new Error(`git clone failed: ${clone.err.slice(0, 300)}`)
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

    const sel = roleConfigGet('prReview')
    const chat = await chatManager.create({
      directory: worktreeDir,
      title: `${pr.repo}#${pr.number} review`.slice(0, 80),
      agentID: sel?.agentID,
      model: sel?.model,
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
