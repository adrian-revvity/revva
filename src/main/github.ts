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
import { app } from 'electron'
import { openCodeService, describeError } from './opencode/service'
import { chatManager } from './opencode/chats'
import { roleConfigGet, settingGet, settingSet } from './db'
import { renderPrompt, DEFAULT_PR_REVIEW_PROMPT } from '@shared/prompts'
import type { PrDetail, PullRequest, TaskSessionResult } from '@shared/types'

const exec = promisify(execFile)

async function gh(args: string[], cwd?: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const res = await exec('gh', args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
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
type PrSeen = { latestOtherAt: number; total: number }
const SEEN_KEY = 'githubPrSeen'
const MERGED_LOOKBACK_DAYS = 14

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
        q += ` ${pAlias}: pullRequest(number: ${pr.number}) { reviewDecision state mergedAt comments(last: 10) { totalCount nodes { author { login } createdAt } } }`
        refs.push({ path: [rAlias, pAlias], pr })
      })
      q += ' }'
    }
    q += '}'
    const res = await gh(['api', 'graphql', '--field', `query=${q}`])
    if (!res.ok) return // enrichment is best-effort; the list still renders without badges
    type Node = { author?: { login?: string } | null; createdAt?: string }
    type PrNode = { reviewDecision?: string; state?: string; mergedAt?: string | null; comments?: { totalCount?: number; nodes?: Node[] } }
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
      const others = (node.comments?.nodes ?? [])
        .filter((n) => n.author?.login && n.author.login !== me)
        .map((n) => ({ author: n.author!.login!, at: Date.parse(n.createdAt ?? '') || 0 }))
        .filter((n) => n.at > 0)
        .sort((a, b) => b.at - a.at)
      const total = node.comments?.totalCount ?? pr.commentsCount ?? 0
      pr.commentsCount = total
      const latest = others[0]
      this.lastInfo.set(pr.url, { latestOtherAt: latest?.at ?? 0, total })
      pr.latestOtherCommentAuthor = latest?.author
      pr.latestOtherCommentAt = latest?.at
      const seen = seenMap[pr.url]
      if (!seen) {
        seenMap[pr.url] = { latestOtherAt: latest?.at ?? 0, total }
        seenDirty = true
        pr.hasNewComments = false
      } else {
        pr.hasNewComments = !!latest && latest.at > seen.latestOtherAt
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
    await gh(['-C', repoDir, 'worktree', 'prune'])
    const existing = await gh(['-C', repoDir, 'worktree', 'list', '--porcelain'])
    const alreadyAdded = existing.ok && existing.out.includes(join(reposDir, `${pr.repo.split('/')[1]}-pr${pr.number}`))
    const worktreeDir = join(reposDir, `${pr.repo.split('/')[1]}-pr${pr.number}`)
    if (!alreadyAdded) {
      const fetch = await gh(['-C', repoDir, 'fetch', 'origin', `pull/${pr.number}/head:${branch}`])
      if (!fetch.ok) throw new Error(`git fetch of PR head failed: ${fetch.err.slice(0, 300)}`)
      const add = await gh(['-C', repoDir, 'worktree', 'add', '--detach', worktreeDir, branch])
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
