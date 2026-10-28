/**
 * Worktree cleanup: lists every linked worktree of the known repositories
 * (revva-created or not — anything `git worktree list` can see, plus what the
 * OpenCode service manages) and removes them. Branches are only ever deleted
 * with `branch -d`, never `-D`: unmerged work is kept and the user is told.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'
import { openCodeService } from './opencode/service'
import { getDb, settingGet } from './db'
import type { WorktreeInfo } from '@shared/types'

const exec = promisify(execFile)

/** States whose worktree must not be touched from this dialog. */
const LIVE_STATES = new Set(['READY', 'BUILDING', 'REVIEW', 'FIXING', 'WAITING_HUMAN', 'REWORK'])

interface WorkRow {
  worktree_dir: string
  repo_dir: string
  state: string
  ticket_key: string
}

interface RawWorktree {
  path: string
  branch?: string
  detached?: boolean
  locked?: string
  prunable?: boolean
}

async function listGitWorktrees(repoDir: string): Promise<RawWorktree[]> {
  const { stdout } = await exec('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], { timeout: 15_000 })
  const out: RawWorktree[] = []
  let cur: RawWorktree | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length).trim() }
      out.push(cur)
    } else if (!cur) continue
    else if (line.startsWith('branch refs/heads/')) cur.branch = line.slice('branch refs/heads/'.length)
    else if (line === 'detached') cur.detached = true
    else if (line.startsWith('locked')) cur.locked = line.slice('locked'.length).trim() || 'locked'
    else if (line.startsWith('prunable')) cur.prunable = true
  }
  return out
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
    const works = getDb().prepare('SELECT worktree_dir, repo_dir, state, ticket_key FROM work').all() as WorkRow[]
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
        for (const wt of await listGitWorktrees(repoDir)) {
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
    return out.sort((a, b) => a.directory.localeCompare(b.directory))
  }

  /**
   * Remove one worktree (forced) and try to delete its branch — `-d` only.
   * Returns a note when the branch was kept or could not be deleted.
   */
  async remove(repoDir: string, directory: string, force: boolean): Promise<string | undefined> {
    if (directory === repoDir) throw new Error('Refusing to remove the main checkout.')
    const work = getDb().prepare('SELECT * FROM work WHERE worktree_dir = ?').get(directory) as WorkRow | undefined
    if (work && LIVE_STATES.has(work.state)) {
      throw new Error(`${work.ticket_key} is still ${work.state} — abandon the work instead of force-removing its worktree.`)
    }
    const branch = await this.currentBranch(repoDir, directory)

    try {
      await exec('git', ['-C', repoDir, 'worktree', 'remove', ...(force ? ['--force'] : []), directory], { timeout: 60_000 })
    } catch (err) {
      // Directory already gone (crash, manual rm) — git just needs the bookkeeping pruned.
      if (/does not exist|not a working directory|destination path/i.test((err as Error).message)) {
        await exec('git', ['-C', repoDir, 'worktree', 'prune']).catch(() => undefined)
      } else {
        throw new Error(`git worktree remove failed: ${String((err as Error).message.split('\n')[0])}`)
      }
    }

    if (!branch || branch === 'HEAD') return undefined
    try {
      await exec('git', ['-C', repoDir, 'branch', '-d', branch])
      return `Removed worktree and branch ${branch}.`
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      const reason = (String(e.stderr || e.message || 'not fully merged').trim().split('\n')[0] ?? 'unknown').slice(0, 160)
      return `Worktree removed; branch ${branch} kept (git refused: ${reason}).`
    }
  }

  private async currentBranch(repoDir: string, directory: string): Promise<string | undefined> {
    try {
      const { stdout } = await exec('git', ['-C', directory, 'branch', '--show-current'], { timeout: 10_000 })
      const name = stdout.trim()
      return name || undefined
    } catch {
      // Worktree dir already gone; fall back to the porcelain registration.
      try {
        const found = (await listGitWorktrees(repoDir)).find((w) => w.path === directory)
        return found?.branch
      } catch {
        return undefined
      }
    }
  }
}

export const worktreeManager = new WorktreeManager()
