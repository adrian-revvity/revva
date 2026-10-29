/**
 * Branch inventory and branch switching for conversations, straight from git —
 * no directory navigation, no guessing.
 *
 * The listing is read-only (`rev-parse` probes, `for-each-ref`, the registration
 * listing) and answers the two questions a picker actually needs: which branches
 * exist (local first, remote-only ones marked because choosing one starts a local
 * tracking branch) and which of them git will refuse to check out here because
 * another worktree of the same repository already holds it.
 *
 * The switch is deliberately the narrowest thing that can change a checkout:
 * `git checkout <name>` for an existing local branch, `git checkout --track
 * <remote>/<name>` for a remote one. Never `-f`, never `-B`, never a path the
 * caller did not prove first — the folder is resolved and re-proven to be a
 * registered worktree of its own repository before git is asked, and the branch
 * name must match an existing ref exactly, so nothing the listing did not offer
 * can reach git. Modified tracked content is refused before git runs: an agent may
 * be mid-edit and git's own carry-the-changes behaviour would mix that work onto
 * another branch. A failed switch leaves the tree exactly as it was.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { listRegisteredWorktrees } from './worktree-safety'
import type { RepoBranch, RepoBranchList } from '@shared/types'

const exec = promisify(execFile)

/** `git` run inside `cwd` as a separate argument pair (never an interpolated command line). */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

interface RefRow {
  ref: string
  committedAt?: number
}

/** Refs under one namespace (or one exact ref), each with its committer time. */
async function refRows(cwd: string, pattern: string): Promise<RefRow[]> {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname)%09%(committerdate:iso8601-strict)', pattern]).catch(() => '')
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref = '', time] = line.split('\t')
      const at = time ? Date.parse(time) : NaN
      return { ref, committedAt: Number.isFinite(at) ? at : undefined }
    })
}

/** `refs/remotes/origin/feat/x` → `feat/x`; `HEAD` and malformed refs name no branch. */
function remoteBranchOf(ref: string): string | undefined {
  if (!ref.startsWith('refs/remotes/')) return undefined
  const rest = ref.slice('refs/remotes/'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return undefined
  const name = rest.slice(slash + 1)
  return name === 'HEAD' ? undefined : name
}

/** `refs/remotes/origin/feat/x` → `origin`. */
function remoteNameOf(ref: string): string {
  return ref.slice('refs/remotes/'.length).split('/')[0] ?? ''
}

/** Canonical top level of the checkout containing `directory`; throws when there is none. */
export async function checkoutTopLevel(directory: string): Promise<string> {
  const top = (await git(directory, ['rev-parse', '--show-toplevel'])).trim()
  if (!top) throw new Error(`${directory} is not inside a git checkout.`)
  return realpath(top)
}

/**
 * The main checkout of the repository owning `worktreeTop` — the path Revva stores as
 * `repo_dir` elsewhere, so worktree listings and this listing name the same repository
 * the same way. `--git-common-dir` names the shared git *directory*, so its parent is
 * the checkout; a linked worktree's own `.git` file points there.
 */
export async function mainRepoOf(worktreeTop: string): Promise<string> {
  const common = (await git(worktreeTop, ['rev-parse', '--git-common-dir'])).trim()
  if (!common) throw new Error(`${worktreeTop} does not report a git repository.`)
  // A relative answer is relative to the directory git ran in (same rule conversationContext uses).
  return realpath(dirname(isAbsolute(common) ? common : resolve(worktreeTop, common)))
}

/** Branches of the repository owning `directory`, current first, with each branch's worktree occupancy. */
export async function listRepoBranches(directory: string): Promise<RepoBranchList> {
  const top = await checkoutTopLevel(directory)
  const repoDir = await mainRepoOf(top)
  const current = (await git(top, ['branch', '--show-current'])).trim()

  const branches: RepoBranch[] = []
  const locals = new Set<string>()
  for (const row of await refRows(top, 'refs/heads')) {
    const name = row.ref.slice('refs/heads/'.length)
    locals.add(name)
    branches.push({ name, current: name === current, remoteOnly: false, lastCommitAt: row.committedAt })
  }
  // One row per branch name even when several remotes carry it: the picker's value is
  // the branch name, and a name on two remotes is something checkoutBranch refuses —
  // showing it twice with one meaning each would offer a choice that cannot be made.
  const remoteOnly = new Map<string, { remotes: string[]; lastCommitAt?: number }>()
  for (const row of await refRows(top, 'refs/remotes')) {
    const name = remoteBranchOf(row.ref)
    if (!name || locals.has(name)) continue // a local branch of that name is the one git would use
    const seen = remoteOnly.get(name) ?? { remotes: [] }
    seen.remotes.push(remoteNameOf(row.ref))
    if (row.committedAt !== undefined && (seen.lastCommitAt === undefined || row.committedAt > seen.lastCommitAt)) seen.lastCommitAt = row.committedAt
    remoteOnly.set(name, seen)
  }
  for (const [name, seen] of remoteOnly) {
    const unique = [...new Set(seen.remotes)]
    branches.push({
      name,
      current: false,
      remoteOnly: true,
      remote: unique.length === 1 ? unique[0] : undefined,
      remotes: unique.length > 1 ? unique : undefined,
      lastCommitAt: seen.lastCommitAt
    })
  }

  // Git allows one checkout per branch, so record which worktree already holds it.
  const holders = new Map<string, string>()
  for (const wt of await listRegisteredWorktrees(repoDir)) {
    if (wt.branch && wt.path !== top) holders.set(wt.branch, wt.path)
  }
  for (const b of branches) b.checkedOutIn = holders.get(b.name)

  const rank = (b: RepoBranch): number => (b.current ? 0 : b.checkedOutIn ? 2 : b.remoteOnly ? 3 : 1)
  branches.sort((a, b) => rank(a) - rank(b) || (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0) || a.name.localeCompare(b.name))
  return { repoDir, current: current || undefined, mainCheckout: top === repoDir, branches }
}

/**
 * Check `branch` out inside `directory`. Every refusal names the reason and
 * states that nothing changed; the only writes are git's own checkout.
 */
export async function checkoutBranch(directory: string, branch: string): Promise<string> {
  const root = await checkoutTopLevel(await realpath(directory))
  const repoDir = await mainRepoOf(root)
  const registered = await listRegisteredWorktrees(repoDir)
  if (!registered.some((wt) => wt.path === root)) {
    throw new Error(`${root} is not a registered worktree of ${repoDir} — nothing was changed.`)
  }

  const current = (await git(root, ['branch', '--show-current'])).trim()
  if (current === branch) return `Already on ${branch} — nothing changed.`
  const holder = registered.find((wt) => wt.branch === branch && wt.path !== root)
  if (holder) {
    throw new Error(`Branch ${branch} is checked out in ${holder.path}. Git allows one checkout per branch — pick that worktree instead. Nothing was changed.`)
  }

  // Exactly one ref may carry this name, or git would resolve a branch the listing
  // never offered. No ref at all means there is nothing to check out or start from.
  const matches = [
    ...(await refRows(root, `refs/heads/${branch}`)),
    ...(await refRows(root, 'refs/remotes'))
  ].filter((row) => row.ref === `refs/heads/${branch}` || remoteBranchOf(row.ref) === branch)
  const local = matches.some((row) => row.ref === `refs/heads/${branch}`)
  const remotes = [...new Set(matches.filter((row) => row.ref !== `refs/heads/${branch}`).map((row) => remoteNameOf(row.ref)))]
  if (!local && remotes.length === 0) {
    throw new Error(`No branch named ${branch} in ${repoDir}, locally or on a remote. Nothing was changed.`)
  }
  if (!local && remotes.length > 1) {
    throw new Error(`${branch} exists on ${remotes.length} remotes (${remotes.join(', ')}). Revva will not guess which one — nothing was changed.`)
  }

  // Tracked modifications would ride along onto the other branch. Untracked files are
  // left to git: a switch cannot lose them, and git itself refuses when the target
  // branch carries a file of the same path.
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) {
    throw new Error(`This checkout has uncommitted changes. Commit or stash them before switching to ${branch} — nothing was changed.`)
  }

  try {
    if (local) {
      await git(root, ['checkout', branch])
      return `Checked out ${branch}${current ? ` (was on ${current})` : ' (was on detached HEAD)'}.`
    }
    const remote = remotes[0]!
    await git(root, ['checkout', '--track', `${remote}/${branch}`])
    return `Started ${branch} tracking ${remote}/${branch}${current ? ` (was on ${current})` : ' (was on detached HEAD)'}.`
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    const reason = (String(e.stderr || e.message || 'git refused').trim().split('\n')[0] ?? 'git refused').slice(0, 300)
    throw new Error(`Git refused to switch to ${branch}: ${reason}. Nothing was changed.`)
  }
}
