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
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { openCodeService } from './opencode/service'
import { getDb, settingGet } from './db'
import {
  listRegisteredWorktrees,
  performRemoval,
  preflightWorktreeRemoval,
  requireAbsenceOfAgents,
  staleConfirmationError
} from './worktree-safety'
import type { WorktreeInfo, WorktreeRemovalPreflight } from '@shared/types'

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
    return [...dirs]
  }

  /** All linked worktrees across known repos, marked with revva ownership/busy state. */
  async list(): Promise<WorktreeInfo[]> {
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
      // Git first: its porcelain data is richer than the service listing.
      try {
        for (const wt of await listRegisteredWorktrees(repoDir)) {
          if (wt.path === repoDir) continue // the main checkout is never a cleanup target
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
            busy: work ? LIVE_STATES.has(work.state) : undefined
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
            if (!wt.directory || wt.directory === repoDir) continue
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
