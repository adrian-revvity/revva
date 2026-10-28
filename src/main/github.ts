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
import { roleConfigGet, settingGet } from './db'
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

class GitHubManager {
  /** Feature-detect for the UI (tab shows a hint instead of errors when gh is missing). */
  async available(): Promise<boolean> {
    return (await gh(['--version'])).ok
  }

  /** Open PRs I authored, or PRs where my review is requested. */
  async list(scope: 'mine' | 'review' = 'mine'): Promise<PullRequest[]> {
    const args =
      scope === 'mine'
        ? ['search', 'prs', '--author=@me', '--state=open', '--sort=updated', '--order=desc', '--limit', '40']
        : ['search', 'prs', '--review-requested=@me', '--state=open', '--sort=updated', '--order=desc', '--limit', '40']
    const res = await gh([...args, '--json', 'repository,title,url,number,isDraft,updatedAt,state'])
    if (!res.ok) throw new Error(res.err.trim().split('\n')[0] || 'gh search failed — is `gh auth login` done?')
    type Row = {
      repository?: { nameWithOwner?: string }
      title?: string
      url?: string
      number?: number
      isDraft?: boolean
      updatedAt?: string
      state?: string
    }
    const rows = JSON.parse(res.out || '[]') as Row[]
    return rows
      .filter((r) => r.url && r.number)
      .map((r) => ({
        repo: r.repository?.nameWithOwner ?? 'unknown',
        number: r.number!,
        title: r.title ?? '',
        url: r.url!,
        state: r.state ?? 'open',
        isDraft: !!r.isDraft,
        updatedAt: Date.parse(r.updatedAt ?? '') || Date.now()
      }))
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
