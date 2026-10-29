/**
 * Worktree cleanup: lists every linked worktree of the known repositories
 * (revva-created or not — anything `git worktree list` can see, plus what the
 * OpenCode service manages). Removal goes through the confirmation gate in
 * worktree-safety.ts: the user first sees exactly what removal destroys
 * (tracked / untracked / ignored counts, never contents), confirms per
 * worktree whenever anything is destroyed, and immediately before acting
 * revva re-proves registration, contents, path identity and agent absence —
 * any drift or uncheckable state aborts with nothing touched. Deletion is
 * never race-free (an external program can write inside after the re-check);
 * revva narrows the window and lets git's own deletion-time check refuse fresh
 * modifications, and the UI says so. `--force` reaches git only for content
 * the user explicitly confirmed destroying. Branches are only ever deleted
 * with `branch -d`, never `-D`: unmerged work is kept and the user is told.
 * The dialog's cleanup button instead hands the whole set to one agent chat
 * (cleanupChat): it checks each worktree for work that would be lost and
 * removes only the provably-empty ones itself, with plain `git worktree
 * remove` — never `--force`, so git's own guard still protects anything the
 * agent misjudges.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { openCodeService } from './opencode/service'
import { chatManager } from './opencode/chats'
import { getDb, settingGet } from './db'
import { listRepoBranches, mainRepoOf } from './branches'
import {
  listRegisteredWorktrees,
  performRemoval,
  preflightWorktreeRemoval,
  requireAbsenceOfAgents,
  staleConfirmationError
} from './worktree-safety'
import type { RepoBranchList, TaskSessionResult, WorktreeInfo, WorktreeRemovalPreflight } from '@shared/types'

const exec = promisify(execFile)

/** States whose worktree must not be touched from this dialog. */
const LIVE_STATES = new Set(['READY', 'BUILDING', 'REVIEW', 'FIXING', 'WAITING_HUMAN', 'REWORK'])

interface WorkRow {
  worktree_dir: string
  repo_dir: string
  branch?: string
  state: string
  ticket_key: string
}

/** Where revva places new worktrees for a repo (same rule as the create path). */
function revvaRootFor(repoDir: string): string {
  return settingGet<string>('worktreeRoot') || join(repoDir, '..', `${basename(repoDir)}-worktrees`)
}

class WorktreeManager {
  private repoDirs(): string[] {
    const dirs = new Set<string>()
    for (const w of getDb().prepare('SELECT path FROM workspace').all() as Array<{ path: string }>) dirs.add(w.path)
    for (const w of getDb().prepare('SELECT DISTINCT repo_dir FROM work').all() as Array<{ repo_dir: string }>) dirs.add(w.repo_dir)
    // A workspace may be a plain container folder and work rows may point at
    // deleted test repos; only real checkouts have a .git entry, and querying
    // anything else makes git fail noisily on every listing.
    return [...dirs].filter((dir) => existsSync(join(dir, '.git')))
  }

  /**
   * All linked worktrees across known repos, marked with revva ownership/busy state.
   * The main checkouts are left out by default: cleanup must never offer them. The
   * conversation's worktree picker asks for them, because a conversation can live there.
   */
  async list(options?: { includeMainCheckouts?: boolean }): Promise<WorktreeInfo[]> {
    const includeMain = options?.includeMainCheckouts ?? false
    const works = getDb().prepare('SELECT worktree_dir, repo_dir, branch, state, ticket_key FROM work').all() as WorkRow[]
    const byDir = new Map(works.map((w) => [w.worktree_dir, w]))
    const rootSetting = settingGet<string>('worktreeRoot') || undefined
    const out: WorktreeInfo[] = []
    const seen = new Set<string>()
    const add = (info: WorktreeInfo): void => {
      const key = `${info.repoDir}\u0000${info.directory}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(info)
    }
    // OpenCode-managed worktrees per project (best-effort; the git listing covers everything).
    const ocProjects = new Map<string, string>()
    try {
      for (const p of await openCodeService.api.project.list({})) {
        if (p.canonical) ocProjects.set(p.canonical, p.id)
      }
    } catch {
      /* service down — git listing still runs */
    }

    for (const repoDir of this.repoDirs()) {
      const revvaRoot = rootSetting || join(repoDir, '..', `${basename(repoDir)}-worktrees`)
      // The main checkout is the shared git dir's owner, not necessarily the queried
      // path: a workspace can itself be a linked worktree, and then git lists the real
      // main checkout among its entries. Cleanup must never offer that one.
      const mainCheckout = await mainRepoOf(repoDir).catch(() => repoDir)
      // Git first: its porcelain data is richer than the service listing.
      try {
        for (const wt of await listRegisteredWorktrees(repoDir)) {
          const isMain = wt.path === mainCheckout
          // The main checkout is never a cleanup target; the conversation picker asks for it.
          if (isMain && !includeMain) continue
          const work = byDir.get(wt.path)
          add({
            repoDir,
            directory: wt.path,
            branch: wt.branch,
            detached: wt.detached,
            locked: wt.locked,
            prunable: wt.prunable,
            inWorktreeRoot: wt.path.startsWith(revvaRoot),
            revva: Boolean(work),
            ticketKey: work?.ticket_key,
            busy: work ? LIVE_STATES.has(work.state) : undefined,
            mainCheckout: isMain || undefined
          })
        }
      } catch (err) {
        console.warn(`[worktrees] list failed for ${repoDir}:`, (err as Error).message)
      }

      // Service-managed entries git hasn't seen yet (rare; same-directory entries are deduped).
      const projectId = ocProjects.get(repoDir)
      if (projectId) {
        try {
          const list = await openCodeService.api.worktree.list({ projectID: projectId })
          for (const wt of list) {
            if (!wt.directory || wt.directory === mainCheckout) continue
            // OpenCode's registry is append-only: rows for worktrees removed outside
            // OpenCode (git worktree remove, rm -rf) linger forever and would show as
            // ghosts here. Git's listing already covers every real registration, prunable
            // ones included, so a service row whose folder is gone is never actionable —
            // drop it instead of surfacing an entry preflight must refuse.
            try {
              await lstat(join(wt.directory, '.git'))
            } catch {
              continue
            }
            const work = byDir.get(wt.directory)
            add({
              repoDir,
              directory: wt.directory,
              inWorktreeRoot: wt.directory.startsWith(revvaRoot),
              revva: Boolean(work),
              ticketKey: work?.ticket_key,
              busy: work ? LIVE_STATES.has(work.state) : undefined
            })
          }
        } catch {
          /* service down or project unknown — git listing already ran */
        }
      }
    }
    // Revva work rows whose folder is gone and no longer registered: the git and
    // service listings cannot show them, but they still clutter the picture —
    // surface them as stale entries. Exact registration is required for any
    // action, so preflight/remove refuse these honestly (nothing to clear);
    // they only disappear when the work row itself goes away.
    for (const w of works) {
      if (seen.has(`${w.repo_dir}\u0000${w.worktree_dir}`)) continue
      const work = byDir.get(w.worktree_dir)
      if (!work || LIVE_STATES.has(work.state)) continue
      let gone = false
      try {
        await lstat(join(w.worktree_dir, '.git'))
      } catch (err) {
        gone = (err as NodeJS.ErrnoException)?.code === 'ENOENT' || (err as NodeJS.ErrnoException)?.code === 'ENOTDIR'
      }
      if (!gone) continue
      add({
        repoDir: w.repo_dir,
        directory: w.worktree_dir,
        branch: work.branch,
        prunable: true,
        inWorktreeRoot: w.worktree_dir.startsWith(revvaRootFor(w.repo_dir)),
        revva: true,
        ticketKey: work.ticket_key,
        busy: false
      })
    }
    return out.sort((a, b) => a.directory.localeCompare(b.directory))
  }

  /** Branches of the repository owning `directory`, for the conversation’s branch picker. */
  branches(directory: string): Promise<RepoBranchList> {
    return listRepoBranches(directory)
  }

  /**
   * Read-only removal preview for one path (the dialog's first step). Exact
   * registration against `git worktree list` is required — an unregistered
   * path is always refused, including a revva work row whose folder and
   * registration are both already gone.
   */
  preflight(repoDir: string, directory: string): Promise<WorktreeRemovalPreflight> {
    return preflightWorktreeRemoval(repoDir, directory)
  }

  /**
   * "Clean up worktrees": one chat primed to audit *and clean* every linked
   * worktree revva can see. The agent checks each candidate for work that
   * would be lost — uncommitted, untracked, unpushed or unmerged — and removes
   * only what provably holds nothing, then reports what it kept and why. It
   * works with plain `git worktree remove` (never `--force`, never `branch -D`),
   * so git's own guard is the backstop if the check misses something; locked
   * worktrees and revva work in a live state are off-limits and listed as such.
   * The chat runs in a main checkout (which always exists) and reaches each
   * worktree through `git -C`, so stale registrations are cleanable too.
   */
  async cleanupChat(): Promise<TaskSessionResult> {
    const worktrees = await this.list()
    if (worktrees.length === 0) throw new Error('Nothing to clean: no linked worktrees in your known repositories.')

    // The richest repo's main checkout hosts the chat: repo instructions apply
    // there and it exists on disk, while worktree folders may already be gone.
    const counts = new Map<string, number>()
    for (const w of worktrees) counts.set(w.repoDir, (counts.get(w.repoDir) ?? 0) + 1)
    const directory = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]

    const offLimits = worktrees.filter((w) => w.busy || w.locked)
    const candidates = worktrees.filter((w) => !w.busy && !w.locked)
    const listing = (list: WorktreeInfo[]): string =>
      list
        .map((w) => {
          const flags = [
            w.branch ? `branch ${w.branch}` : w.detached ? 'detached HEAD' : 'branch unknown',
            w.prunable ? 'folder already gone (stale registration)' : null,
            w.locked ? `locked (${w.locked})` : null,
            w.ticketKey ? `revva work ${w.ticketKey}${w.busy ? ' — live, in progress' : ''}` : null
          ]
            .filter(Boolean)
            .join(', ')
          return `- ${w.directory} — in ${w.repoDir}${flags ? ` (${flags})` : ''}`
        })
        .join('\n')

    const generalSelection = settingGet<{ agentID?: string; model?: { providerID: string; id: string } } | undefined>('chat.lastSelection')
    const chat = await chatManager.create({
      directory,
      title: `Clean up worktrees (${worktrees.length})`.slice(0, 80),
      agentID: generalSelection?.agentID,
      model: generalSelection?.model
    })
    const text = [
      `Clean up the git worktrees Revva found across your repositories. Remove the ones that hold nothing and report the rest — the user asked for a full cleanup, so do the removals yourself rather than only planning them.`,
      `Candidates (check each before deleting):\n${listing(candidates)}`,
      offLimits.length
        ? `Off-limits — never touch these, they belong to work in progress or are locked:\n${listing(offLimits)}`
        : 'No worktree is locked or tied to live revva work.',
      'For every candidate, first prove nothing would be lost: `git -C <worktree> status --porcelain -uall --ignored`, `git -C <worktree> diff --stat` and `git -C <worktree> diff --cached --stat`; the branch it carries (`git -C <worktree> branch --show-current`), whether that branch is pushed and equal to its remote, and whether its commits are already contained elsewhere (`git -C <repo> branch --contains <sha>`, `git -C <repo> log origin/<base>..<branch> --oneline`, `gh pr list --head <branch> --state all`). A folder whose `.git` file is gone is a stale registration: `git -C <repo> worktree prune` clears it and destroys nothing.',
      'Remove only what the check proves safe, with plain `git worktree remove <path>` — never `--force`, so git itself refuses while modified or untracked files exist. Afterwards delete its branch only with `git branch -d` (never `-D`): if git refuses because the branch is not fully merged, leave the branch and say so. Anything with uncommitted, untracked (beyond pure build output or dependencies like node_modules), unpushed or unmerged work stays exactly as it is — report what it holds and what would save it (commit and push on <branch>, merge, or an explicit discard by the user), and ask before removing such a worktree.',
      'Never push, force-push, merge, rebase, stash, commit, rewrite history, change files, or touch a main checkout, another repository, or a worktree that is not in the list above. Work in one worktree at a time and re-run its status check immediately before deleting it.',
      'Finish with a short report: removed (path, branch, branch kept or deleted), kept and why (file counts and commit counts, not diffs), and anything needing the user\'s decision.'
    ].join('\n\n')
    await openCodeService.api.session.prompt({ sessionID: chat.sessionId, text }).catch((err) => {
      throw new Error(`Chat created, but the cleanup prompt failed: ${(err as Error).message}`)
    })
    return { sessionId: chat.sessionId, title: chat.title, directory: chat.directory }
  }

  /**
   * Perform one confirmed removal: re-proves everything immediately (path
   * proofs, exact registration, content + index fingerprint, signature, path
   * identity, agent absence) and deletes with `git worktree remove` — plain
   * when the confirmed state had no modified/untracked content (git re-checks
   * those itself at deletion time; ignored content is destroyed even by plain
   * remove, hence the confirmation gate covers it too), `--force` only when
   * the user explicitly confirmed destroying modified/untracked content. The
   * whole proof runs a second time immediately before the delete because the
   * occupancy probe waits on network I/O; this narrows the race window — it
   * does not close it, and nothing here claims to. A provably-gone folder is
   * the no-file-destruction case: the same command only clears its stale
   * registration, no extra confirmation needed. Then the branch is deleted
   * with `-d` only: unmerged work is kept and the user is told. Every refusal
   * throws before anything is touched; a failed removal never deletes the
   * branch. Returns a note when the branch was kept or could not be deleted.
   */
  async remove(repoDir: string, directory: string, confirmedSignature: string, confirmed: boolean): Promise<string | undefined> {
    const work = getDb().prepare('SELECT * FROM work WHERE worktree_dir = ?').get(directory) as WorkRow | undefined
    if (work && LIVE_STATES.has(work.state)) {
      throw new Error(`${work.ticket_key} is still ${work.state} — abandon the work instead of force-removing its worktree.`)
    }
    // Revalidate now: protected paths, exact registration, content + index
    // fingerprint, identity — any drift since the confirmation voids the
    // signature. Or a refusal.
    const fresh: WorktreeRemovalPreflight = await preflightWorktreeRemoval(repoDir, directory)
    if (fresh.signature !== confirmedSignature) throw staleConfirmationError()
    if (fresh.requiresConfirmation && !confirmed) {
      // A signature match guarantees these are the very counts the user was shown.
      throw new Error(
        `Explicit confirmation required — the worktree holds content that would go: ${fresh.confirmationReasons.join('; ')}. Nothing was removed — confirm this exact worktree first.`
      )
    }
    // Even a registration-only cleanup waits for proven absence of agents. Fails closed.
    // This is a snapshot: a session can start right after it returns — hence
    // the honest race warning in the UI; occupancy cannot be proven at unlink.
    await requireAbsenceOfAgents(fresh.directory)
    // The occupancy probe awaited network I/O — re-prove the exact confirmed
    // state once more immediately before the delete (narrows, not closes, the
    // window; git's own deletion-time check remains the outer guard).
    const final = await preflightWorktreeRemoval(repoDir, directory)
    if (final.signature !== confirmedSignature) throw staleConfirmationError()
    // Synchronous last word, directly before the git subprocess starts (no
    // await between here and performRemoval): revva's own work rows can move
    // into a live state while the async probes above were running — a work
    // that started building during them must not lose its worktree now.
    const liveNow = getDb().prepare('SELECT state, ticket_key FROM work WHERE worktree_dir = ?').get(directory) as WorkRow | undefined
    if (liveNow && LIVE_STATES.has(liveNow.state)) {
      throw new Error(`${liveNow.ticket_key} became ${liveNow.state} while this removal was being verified — nothing was removed. Abandon the work instead of force-removing its worktree.`)
    }

    // `--force` exactly when the confirmed state held modified/untracked content
    // git would otherwise guard at deletion time. The content-bound signature
    // guarantees the user ticked over these very contents — including edits to
    // already-dirty or already-untracked files and staged blob changes, which
    // status lines alone miss.
    const force = !final.missing && final.trackedDirty + final.untracked > 0
    await performRemoval(final.repoDir, final.directory, force)

    const branch = final.branch ?? work?.branch
    if (!branch) return final.missing ? 'Cleared the stale worktree registration (detached HEAD — no branch to delete).' : 'Worktree removed (detached HEAD — no branch to delete).'
    try {
      await exec('git', ['-C', final.repoDir, 'branch', '-d', branch], { timeout: 30_000 })
      return final.missing
        ? `Cleared the stale worktree registration and deleted branch ${branch}.`
        : `Removed the worktree and deleted branch ${branch}.`
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      const reason = (String(e.stderr || e.message || 'not fully merged').trim().split('\n')[0] ?? 'unknown').slice(0, 160)
      return `${final.missing ? 'Registration cleared' : 'Worktree removed'}; branch ${branch} kept (git refused: ${reason}).`
    }
  }
}

export const worktreeManager = new WorktreeManager()
