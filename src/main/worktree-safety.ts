/**
 * Safety proofs for worktree removal — used by every removal entry point.
 *
 * Owner decision, 2026-10-29 (see plans/009-safe-worktree-removal.md): removal
 * of an existing folder is allowed in-app ONLY after an explicit confirmation
 * bound to a fresh full preview, with an immediate fail-closed recheck before
 * the delete, and an honest warning that external programs can still change
 * files between the check and the deletion — no claim of race-freedom is made
 * anywhere. If active OpenCode sessions cannot be checked reliably, removal is
 * refused. Everything below implements that boundary.
 *
 * Confirmation binding (what the signature actually proves):
 *  - porcelain status alone is NOT a content fingerprint: editing an
 *    already-modified or already-untracked file leaves the status lines
 *    identical, so the signature additionally binds a fingerprint of every
 *    destructible path the removal will take: `git status --porcelain -z
 *    -uall --ignored` lists tracked, untracked and ignored content per file
 *    (measured; -z keeps filenames byte-exact and unquoted), each path is
 *    lstat-ed — never followed through symlinks, link targets are recorded as
 *    strings only, nothing outside the worktree is ever touched — and the
 *    record binds kind, size, mode, inode, mtimeNs and ctimeNs; collapsed
 *    entries (embedded repositories show as `?? dir/`) are recursively scanned
 *    under hard caps (entries, depth, time). Ordinary writes update size or
 *    mtimes, additions/removals change the status set, so the recheck at
 *    execution detects them and aborts.
 *  - Status letters alone do not fingerprint the INDEX: staged contents can change
 *    while porcelain status and on-disk files look unchanged (stage one content,
 *    restore the file, stage another — the index differs, the status letters and
 *    disk metadata may not). So the signature also binds the raw bytes of
 *    `git diff --cached --raw -z`: every staged entry with its blob OID, paths
 *    byte-exact under -z. Any failure of that probe, any unmerged entry, or any
 *    out-of-tree path in it refuses removal. A provably gone folder has no
 *    reachable index (it was already destroyed), so it binds absence instead.
 *  - Limits are hard and fail closed: a tree too large/deep/slow to fingerprint
 *    within the caps is REFUSED, not guessed; any unexpected stat/readdir error
 *    or a state that shifts under the scan itself aborts the proof.
 *  - What the fingerprint does NOT catch, stated honestly: a writer that
 *    rewrites identical-size content while restoring exact mtimes (and the
 *    whole window between the last check and git's unlink). Plain `worktree
 *    remove` still refuses on fresh modified/untracked content; `--force`
 *    bypasses even that. Removal is therefore never race-free, and the UI says
 *    so wherever files can be destroyed.
 *
 * Verified git behaviour behind the design (git 2.x, measured on this machine):
 *  - `worktree remove` (no force) re-checks tracked+untracked at the moment of
 *    destruction and aborts on any hit; it does NOT re-check ignored files —
 *    with only ignored content present it removes the folder and deletes it.
 *    Hence: a preview holding anything at all is destructive and must be
 *    confirmed; the manual path never relies on git for ignored files.
 *  - on a registered folder that is already gone it exits 0 and clears only
 *    that one registration (siblings untouched) — the one action that destroys
 *    no file, so it needs no destructive confirmation, only no confirmation of
 *    drift;
 *  - if anything recreated the path meanwhile, git itself refuses
 *    ("validation failed … .git does not exist"), so a gone-folder cleanup
 *    cannot be turned into a delete-by-recreation;
 *  - a locked worktree cannot be removed at all (folder stays intact), and
 *    `git worktree prune` is repo-global — it sweeps unrelated registrations.
 *
 * Hard rules:
 *  - NO `--force` unless the user confirmed exactly this dirty state; NEVER
 *    `worktree unlock` (a lock-reason string is not ownership proof — an old
 *    receipt does not prove its creator is dead); NEVER broad `prune`.
 *  - Exact registration proof before anything else: canonical (realpath) exact
 *    match against `git worktree list --porcelain -z`; non-main only (main = the
 *    first porcelain entry); never the repo root or an ancestor; never a folder
 *    containing another registered worktree. Any unregistered/orphaned path is
 *    refused with no exceptions — including a revva work row whose folder and
 *    registration are both already gone: revva performs nothing it cannot
 *    point at in git's registration. Names whose bytes do not survive a UTF-8
 *    round trip (Node would decode them with loss) are refused everywhere they
 *    reach a decision — revva never acts on a mangled path; hashed-only raw
 *    bytes keep their exactness.
 *  - Locks block removal unconditionally, in every state.
 *  - Occupancy is proven at the moment of action against the authoritative
 *    OpenCode service and fails closed: every session the service reports
 *    active (revva-indexed or not) is fetched for its canonical
 *    `location.directory`, and the location's PTYs for open terminals. Service
 *    unreachable, any query error, any hit ⇒ occupied, removal refused.
 *  - State inspection (status, content fingerprint, HEAD) has no fallback
 *    values; any inspection failure or over-limit aborts the proof.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir, readlink, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { openCodeService } from './opencode/service'
import type { WorktreeRemovalPreflight } from '@shared/types'

const GIT_TIMEOUT = 20_000
/** A tree with more porcelain output than this is refused, not guessed. */
const STATUS_BUFFER = 32 * 1024 * 1024
/** Fingerprint hard caps — exceeding any of them refuses the removal. */
const FINGERPRINT_MAX_ENTRIES = 200_000
const FINGERPRINT_MAX_DEPTH = 48
const FINGERPRINT_MAX_MS = 30_000
const FINGERPRINT_CONCURRENCY = 32

export interface RawWorktree {
  path: string
  branch?: string
  detached?: boolean
  locked?: string
  prunable?: boolean
}

/**
 * `git worktree list --porcelain -z` for a repo; main worktree first. Throws on any git error.
 *
 * `-z` matters: without it git quotes paths containing unusual bytes ("worktree
 * "a path"") and callers that trim would corrupt them, silently mis-identifying
 * which worktree is which. Under `-z` every field is one NUL-terminated raw
 * byte string and each worktree record ends with an empty field (double NUL),
 * so paths are taken byte-exact, with or without spaces and quotes. Names that
 * are not valid UTF-8 (which Node could not decode without loss) are REFUSED —
 * revva never acts on a mangled path. Anything the stream shape does not
 * explain (a field before the first `worktree`, a stray record) throws — the
 * listing is the registration proof every removal is checked against, so it is
 * never partially trusted.
 */
export async function listRegisteredWorktrees(repoDir: string): Promise<RawWorktree[]> {
  const stdout = (
    await exec2('git', ['-C', repoDir, 'worktree', 'list', '--porcelain', '-z'], { timeout: GIT_TIMEOUT, maxBuffer: STATUS_BUFFER })
  ).stdout
  const tokens: Buffer[] = []
  let start = 0
  for (;;) {
    const nul = stdout.indexOf(0, start)
    if (nul === -1) break
    tokens.push(stdout.subarray(start, nul))
    start = nul + 1
  }
  if (start < stdout.length) {
    throw new Error('git worktree list ended without a NUL terminator — its output could not be read safely.')
  }
  const out: RawWorktree[] = []
  let cur: RawWorktree | undefined
  for (const tok of tokens) {
    if (tok.length === 0) {
      // Empty field = end of record (double NUL); only meaningful mid-stream.
      cur = undefined
      continue
    }
    const space = tok.indexOf(0x20)
    const key = (space === -1 ? tok : tok.subarray(0, space)).toString('latin1')
    const raw = space === -1 ? Buffer.alloc(0) : tok.subarray(space + 1) // raw bytes — never trimmed or unquoted
    if (key === 'worktree') {
      // The path is compared, realpath-ed and handed to git — refuse unless it
      // survives a UTF-8 round trip; a lossy decode would target a different
      // folder than the one git registered.
      const path = utf8Exact(raw)
      if (path === undefined) {
        throw new Error('git worktree list reported a path with bytes revva cannot handle (not valid UTF-8). Removal is refused while the registration cannot be read exactly.')
      }
      cur = { path }
      out.push(cur)
    } else if (!cur) {
      throw new Error('git worktree list produced a field before any "worktree" path — its output could not be read safely.')
    } else if (key === 'branch') {
      // Branch names reach `git branch -d` verbatim — same round-trip demand.
      const branchRaw = raw.toString('latin1')
      if (branchRaw.startsWith('refs/heads/')) {
        const branch = utf8Exact(raw.subarray('refs/heads/'.length))
        if (branch === undefined) {
          throw new Error('git worktree list reported a branch name with bytes revva cannot handle (not valid UTF-8). Removal is refused while the registration cannot be read exactly.')
        }
        cur.branch = branch
      }
      // Anything without the refs/heads/ prefix is not a branch revva could
      // hand to `branch -d`, so the entry reads as detached.
    } else if (key === 'detached') {
      cur.detached = true
    } else if (key === 'locked') {
      // Display-only in refusal messages — a lossy decode mis-renders text, it
      // never steers an action, so utf8 decode stands.
      const reason = raw.toString('utf8')
      cur.locked = reason || 'locked'
    } else if (key === 'prunable') {
      cur.prunable = true
    }
    // 'HEAD' and 'bare' carry no removal-relevant state; unknown keys are
    // forward-compatible additions by git and safe to ignore per record.
  }
  for (const wt of out) if (!wt.path) throw new Error('git worktree list produced an empty worktree path — its output could not be read safely.')
  return out
}

function exec2(file: string, args: string[], opts: { timeout: number; maxBuffer?: number }): Promise<{ stdout: Buffer }> {
  return new Promise((res, rej) => {
    execFile(file, args, { ...opts, encoding: 'buffer' }, (err, stdout) => (err ? rej(err) : res({ stdout: stdout as unknown as Buffer })))
  })
}

function exec(file: string, args: string[], opts: { timeout: number; maxBuffer?: number }): Promise<{ stdout: string }> {
  return exec2(file, args, opts).then((r) => ({ stdout: r.stdout.toString('utf8') }))
}

function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Decode a raw path/field ONLY when it survives a UTF-8 round trip.
 *
 * Node hands out utf8-decoded strings whose invalid bytes became U+FFFD;
 * re-encoding never reproduces the original bytes, so a mangled path sent to
 * realpath/lstat/join/`branch -d` would act on something other than what git
 * named — the classic way to remove the wrong folder. Callers MUST refuse
 * (undefined) instead of guessing; valid UTF-8 names (including unusual ones)
 * round-trip byte-identically and pass through untouched.
 */
function utf8Exact(buf: Buffer): string | undefined {
  const s = buf.toString('utf8')
  return Buffer.from(s, 'utf8').equals(buf) ? s : undefined
}

/** True only when the path provably does not exist; any other stat error throws. */
async function pathGone(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (err) {
    if (isMissingPathError(err)) return true
    throw new Error(`Cannot inspect ${path}: ${(err as Error).message}`)
  }
}

/**
 * Marker identifying this exact path object (not just its spelling): if the
 * folder is deleted and something recreates it, birth time and inode change,
 * which voids any signature taken over the previous object. Any stat failure
 * other than provable absence throws — no placeholder values.
 */
async function pathMarker(path: string): Promise<string> {
  try {
    const st = await lstat(path)
    return `o${st.ino}b${Math.round(st.birthtimeMs)}${st.isDirectory() ? 'd' : 'f'}`
  } catch (err) {
    if (isMissingPathError(err)) return 'absent'
    throw new Error(`Cannot inspect ${path}: ${(err as Error).message}`)
  }
}

/** Canonical path of something that must exist and be resolvable; anything else throws. */
async function canonicalExisting(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (err) {
    throw new Error(`Cannot resolve ${path} (does it exist?): ${(err as Error).message}`)
  }
}

/** Canonical path; only a provably-absent path falls back to its normalised raw spelling. */
async function canonicalOrAbsent(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (err) {
    if (isMissingPathError(err)) return resolve(path)
    throw new Error(`Cannot resolve ${path}: ${String((err as Error).message)}`)
  }
}

/* ------------------------------------------------------------------ */
/* Content fingerprint                                                  */
/* ------------------------------------------------------------------ */

interface StatusRecord {
  /** XY porcelain codes. */
  codes: string
  /** Raw path bytes exactly as git printed them (byte-exact under -z). */
  pathBuf: Buffer
  /** Decode used only to reach the filesystem with lstat. */
  rel: string
  /** Collapsed directory (`?? emb/` — an embedded repo): scan recursively. */
  collapsed: boolean
  /** Tracked path deleted in either porcelain column — may legitimately be absent on disk. */
  optionalAbsent: boolean
}

/** Parse `git status --porcelain -z -uall --ignored` (raw bytes; rename sources carry an extra record). */
function parseStatusZ(buf: Buffer): StatusRecord[] {
  const tokens: Buffer[] = []
  let start = 0
  for (;;) {
    const nul = buf.indexOf(0, start)
    if (nul === -1) break
    tokens.push(buf.subarray(start, nul))
    start = nul + 1
  }
  const out: StatusRecord[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok.length === 0) continue // trailing NUL
    const codes = tok.subarray(0, 2).toString('latin1')
    // XY is always two porcelain status columns (letters, '?' or '!' — e.g. " M", "??").
    if (!/^[A-Z!?MRTUCD ][A-Z!?MRTUCD ]$/.test(codes) || tok.length < 4) {
      throw new Error('Unrecognisable git status output; removal is refused while its state is unknown.')
    }
    let pathBuf = tok.subarray(3)
    let relBuf = pathBuf
    if (codes[0] === 'R' || codes[0] === 'C' || codes[1] === 'R' || codes[1] === 'C') {
      // Rename/copy: the source path is the next NUL-delimited record. The
      // record hashes BOTH spellings; only the destination reaches the
      // filesystem (the source, if it still exists, is bound separately by
      // its own porcelain entry).
      const src = tokens[++i]
      if (src === undefined) throw new Error('Truncated git status rename record; removal is refused while its state is unknown.')
      pathBuf = Buffer.concat([pathBuf, Buffer.from([0]), src])
    }
    // The decode below reaches the filesystem (join → lstat); refuse names
    // whose bytes Node cannot decode losslessly rather than lstat-ing a
    // replacement-character mangling of a different path.
    const rel = utf8Exact(relBuf)
    if (rel === undefined) {
      throw new Error('git status reported a path with bytes revva cannot handle (not valid UTF-8). Removal is refused while its contents cannot be verified exactly.')
    }
    // Porcelain paths are repo-relative; anything else is not something revva
    // will hand to the filesystem — refuse rather than reason about it.
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error(`git reported an out-of-tree path (${rel}); removal is refused while its state is unknown.`)
    }
    const collapsed = rel.endsWith('/') ? codes === '??' || codes === '!!' : false
    // A tracked entry deleted in either column is legitimately absent on disk.
    out.push({ codes, pathBuf, rel: collapsed ? rel.slice(0, -1) : rel, collapsed, optionalAbsent: codes[0] === 'D' || codes[1] === 'D' })
  }
  return out
}

interface ScanBudget {
  entries: number
  deadline: number
}

function spend(budget: ScanBudget, label: string): void {
  budget.entries++
  if (budget.entries > FINGERPRINT_MAX_ENTRIES) {
    throw new Error(`The worktree holds more than ${FINGERPRINT_MAX_ENTRIES} destructible paths (${label}) — too large to verify within limits. Remove it yourself in a terminal if you really mean it.`)
  }
  if (Date.now() > budget.deadline) {
    throw new Error(`Fingerprinting this worktree exceeds the ${FINGERPRINT_MAX_MS / 1000}-second verification limit — refused rather than guessed. Remove it yourself in a terminal if you really mean it.`)
  }
}

/**
 * Fingerprint one path WITHOUT ever following a link: lstat only; a symlink's
 * target is recorded as a string and never resolved, read, or scanned. Kind,
 * size, mode, inode and nanosecond times catch ordinary content writes and
 * replacements between preview and execution. `optionalAbsent` paths (deleted
 * or conflicted porcelain entries) may legitimately be missing — both states
 * bind to the signature — while anything else vanishing mid-scan means the
 * worktree is actively changing and aborts the whole proof.
 */
async function fingerprintPath(abs: string, rel: string, optionalAbsent: boolean, budget: ScanBudget): Promise<string> {
  spend(budget, rel)
  let st
  try {
    // bigint stats: nanosecond mtime/ctime precision catches rapid same-size writes.
    st = await lstat(abs, { bigint: true })
  } catch (err) {
    if (isMissingPathError(err)) {
      if (optionalAbsent) return `${rel}\u0001absent`
      throw new Error(`${rel} vanished while its contents were being inspected — the worktree is changing right now. Nothing was verified; retry when writers are quiet.`)
    }
    throw new Error(`Cannot inspect ${rel} (permissions?): ${(err as Error).message}. Removal is refused while any destructible path is unreadable.`)
  }
  const kind = st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'x'
  let extra = ''
  if (st.isSymbolicLink()) {
    // String only — target never followed. Recorded byte-faithfully (hex when
    // not valid UTF-8) so two different raw targets can never share a record.
    const target = await readlink(abs, { encoding: 'buffer' })
    const t = target as unknown as Buffer
    const exact = utf8Exact(t)
    extra = exact !== undefined ? `->${exact}` : `->hex:${t.toString('hex')}`
  }
  return `${rel}\u0001${kind}\u0001${st.size}\u0001${st.mode}\u0001${st.ino}\u0001${st.mtimeNs}\u0001${st.ctimeNs}\u0001${extra}`
}

/** Recursively fingerprint a collapsed directory (embedded repo). Symlinks are recorded, never entered. */
async function scanCollapsedDir(rootAbs: string, relPrefix: string, fps: string[], budget: ScanBudget): Promise<void> {
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > FINGERPRINT_MAX_DEPTH) {
      throw new Error(`${rel} is nested deeper than ${FINGERPRINT_MAX_DEPTH} levels — too deep to verify within limits; removal refused.`)
    }
    let dirents
    try {
      // Buffer filenames: a plain string readdir would hand us lossy utf8
      // decodes of unusual names, and join() below would then lstat a path
      // that is not the entry git/revva means. Names are checked for a
      // byte-exact UTF-8 round trip before ever reaching the filesystem.
      dirents = await readdir(abs, { withFileTypes: true, encoding: 'buffer' })
    } catch (err) {
      throw new Error(`Cannot read directory ${rel}: ${(err as Error).message}. Removal is refused while any destructible path is unreadable.`)
    }
    const named: Array<{ name: string; de: (typeof dirents)[number] }> = []
    for (const de of dirents) {
      const name = utf8Exact(de.name as unknown as Buffer)
      if (name === undefined) {
        throw new Error(`${rel} holds an entry whose name revva cannot handle (not valid UTF-8). Removal is refused while its contents cannot be verified exactly.`)
      }
      named.push({ name, de })
    }
    named.sort((a, b) => (a.name < b.name ? -1 : 1))
    const childFps: string[] = []
    let index = 0
    const next = async (): Promise<void> => {
      while (index < named.length) {
        const { name, de } = named[index++]!
        const childAbs = join(abs, name)
        const childRel = `${rel}/${name}`
        childFps.push(await fingerprintPath(childAbs, childRel, false, budget))
        // DirectoryEntries classify by lstat semantics: a symlink is never entered.
        if (de.isDirectory()) await walk(childAbs, childRel, depth + 1)
      }
    }
    await Promise.all(Array.from({ length: Math.min(FINGERPRINT_CONCURRENCY, Math.max(1, named.length)) }, next))
    // Loop, not spread — a directory may hold more entries than a spread call tolerates.
    for (const fp of childFps) fps.push(fp)
  }
  await walk(rootAbs, relPrefix, 1)
}

/**
 * Fingerprint every destructible path of the worktree: tracked-dirty, staged,
 * untracked, ignored (per file, `-uall` prevents directory collapsing except
 * embedded repos, which are scanned recursively). Returns opaque sorted
 * records for the signature. Fails closed on every anomaly or over-limit.
 */
async function fingerprintDestructibleContent(target: string): Promise<{ records: Buffer[]; fingerprints: string[]; trackedDirty: number; untracked: number; ignored: number }> {
  let stdout: Buffer
  try {
    stdout = (await exec2('git', ['-C', target, 'status', '--porcelain', '-z', '-uall', '--ignored'], { timeout: 60_000, maxBuffer: STATUS_BUFFER })).stdout
  } catch (err) {
    throw new Error(`Cannot inspect the worktree's contents (${String((err as Error).message).split('\n')[0]}). Removal is refused while its state is unknown.`)
  }
  const statusRecords = parseStatusZ(stdout)
  const budget: ScanBudget = { entries: 0, deadline: Date.now() + FINGERPRINT_MAX_MS }
  const fingerprints: string[] = []
  const pending = statusRecords
  let index = 0
  const next = async (): Promise<void> => {
    while (index < pending.length) {
      const rec = pending[index++]!
      if (rec.collapsed) {
        fingerprints.push(await fingerprintPath(join(target, rec.rel), rec.rel, false, budget))
        await scanCollapsedDir(join(target, rec.rel), rec.rel, fingerprints, budget)
      } else {
        fingerprints.push(await fingerprintPath(join(target, rec.rel), rec.rel, rec.optionalAbsent, budget))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(FINGERPRINT_CONCURRENCY, Math.max(1, pending.length)) }, next))

  const records = statusRecords.map((r) => Buffer.concat([Buffer.from(r.codes, 'latin1'), Buffer.from(' '), r.pathBuf]))
  let trackedDirty = 0
  let untracked = 0
  let ignored = 0
  for (const r of statusRecords) {
    if (r.codes === '??') untracked++
    else if (r.codes === '!!') ignored++
    else trackedDirty++
  }
  return { records, fingerprints, trackedDirty, untracked, ignored }
}

/**
 * Authoritative fingerprint of the worktree's Git INDEX (staged contents).
 *
 * Porcelain status + on-disk metadata do NOT fingerprint the index: after
 * `git add v1` + restoring the file to committed content the status letters and
 * every lstat stay unchanged while a later `git add v2` changes what removal
 * destroys (a plain `worktree remove` consults the index). `diff --cached
 * --raw -z` prints exactly the entries whose staged blob differs from HEAD —
 * each with old/new modes, old/new blob OIDs and the raw path — so staged
 * content changes always move these bytes even when nothing else does.
 * `--no-abbrev` forces full 40-hex OIDs: abbreviated OIDs share 7-char
 * prefixes more often than random chance (real histories are clustered), and a
 * collision inside a fixed-width field would silently mask a staged-content
 * change. The empty-index case prints nothing and is bound as provably-empty
 * (the probe succeeded), never as a placeholder.
 *
 * Unmerged entries (U rows) and any out-of-tree path abort the proof; so does
 * any failure to run the probe. A provably-gone folder has no reachable index —
 * its contents were already destroyed outside revva — so it binds absence.
 */
async function fingerprintIndex(target: string): Promise<Buffer> {
  let stdout: Buffer
  try {
    stdout = (await exec2('git', ['-C', target, 'diff', '--cached', '--raw', '-z', '--no-abbrev'], { timeout: 60_000, maxBuffer: STATUS_BUFFER })).stdout
  } catch (err) {
    throw new Error(`Cannot inspect the worktree's staged contents (${String((err as Error).message).split('\n')[0]}). Removal is refused while its state is unknown.`)
  }
  const records: Buffer[] = []
  let start = 0
  for (;;) {
    const nul = stdout.indexOf(0, start)
    if (nul === -1) break
    const rec = stdout.subarray(start, nul)
    start = nul + 1
    if (rec.length === 0) continue // trailing NUL
    // ":<mode> <mode> <oid> <oid> <XY>\0<path>" — with -z the path never lives
    // inside the colon record, so a record without its path is truncated output.
    if (rec[0] !== 0x3a) {
      throw new Error('Unrecognisable git index output; removal is refused while its state is unknown.')
    }
    const head = rec.toString('latin1')
    // Status is the last space-separated token: "M", "A", "D", "R100"…, or "U" when unmerged.
    const status = head.slice(head.lastIndexOf(' ') + 1)
    if (status.includes('U')) {
      throw new Error('The worktree has unmerged index entries; revva will not remove a worktree whose merge state it cannot read. Nothing was removed.')
    }
    const readPath = (): Buffer => {
      const end = stdout.indexOf(0, start)
      if (end === -1) throw new Error('Truncated git index output; removal is refused while its state is unknown.')
      const p = stdout.subarray(start, end)
      start = end + 1
      return p
    }
    // R/C records carry the source path, then the destination path.
    const isRc = status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C'
    const a = readPath()
    const b = isRc ? readPath() : undefined
    for (const p of b === undefined ? [a] : [a, b]) {
      // Paths here are hashed raw (nothing reaches the filesystem), but a
      // name revva cannot name back exactly still refuses: the proof would
      // describe a path no tool in this stack can address.
      if (utf8Exact(p) === undefined) {
        throw new Error('git reported an index path with bytes revva cannot handle (not valid UTF-8). Removal is refused while its staged contents cannot be verified exactly.')
      }
      const rel = p.toString('utf8')
      if (rel.startsWith('/') || rel.split('/').includes('..')) {
        throw new Error(`git reported an out-of-tree index path (${rel}); removal is refused while its state is unknown.`)
      }
    }
    records.push(b === undefined ? Buffer.concat([rec, Buffer.from([0]), a]) : Buffer.concat([rec, Buffer.from([0]), a, Buffer.from([0]), b]))
  }
  if (start < stdout.length) {
    throw new Error('Truncated git index output; removal is refused while its state is unknown.')
  }
  records.sort(Buffer.compare)
  const h = createHash('sha256')
  h.update(String(records.length)).update('\u0000')
  for (const rec of records) h.update(rec).update('\u0000')
  return h.digest()
}

/**
 * Read-only preview of one removal: full proof, or a thrown refusal — never a change.
 *
 * A throw means the path must not be touched at all (unprovable or forbidden:
 * main checkout, unregistered — no exceptions, nested, locked, over-limit or
 * unreadable state). A return describes reality and what execution would do:
 *  - `missing` folder ⇒ at most one stale registration is cleared — inert, no
 *    confirmation required beyond the signature;
 *  - existing folder ⇒ `requiresConfirmation` is true whenever anything could
 *    be destroyed (tracked, untracked, ignored, detached HEAD); the signature
 *    binds the content fingerprint, so execution only proceeds on the exact
 *    contents that were confirmed, and deletes with `--force` only because the
 *    user confirmed those exact destructive counts.
 */
export async function preflightWorktreeRemoval(repoDirRaw: string, directoryRaw: string): Promise<WorktreeRemovalPreflight> {
  const repoInput = repoDirRaw.trim()
  const dirInput = directoryRaw.trim()
  if (!repoInput || !dirInput) throw new Error('Worktree removal needs both a repository and a worktree path.')
  if (dirInput === '~') throw new Error('Refusing to remove "~".')
  if (!isAbsolute(dirInput)) throw new Error(`Worktree path must be absolute, got: ${dirInput}`)

  // Canonicalise the repository first — every later comparison is on resolved paths.
  const repoRoot = await canonicalExisting(repoInput)
  let registered: RawWorktree[]
  try {
    registered = await listRegisteredWorktrees(repoInput)
  } catch (err) {
    throw new Error(`Cannot list worktrees of ${repoRoot}: ${(err as Error).message}`)
  }
  if (registered.length === 0) throw new Error(`${repoRoot} is not a git repository with worktrees.`)

  // Canonicalise the target (a registered-but-gone folder is allowed: cleanup case).
  let target: string
  try {
    target = await realpath(dirInput)
  } catch (err) {
    if (!isMissingPathError(err)) throw new Error(`Cannot resolve ${dirInput}: ${(err as Error).message}`)
    target = resolve(dirInput)
  }

  // --- protected paths (raw and canonical spellings both) ---
  if (target === parse(target).root || resolve(dirInput) === parse(resolve(dirInput)).root) {
    throw new Error(`Refusing to remove the filesystem root: ${dirInput}`)
  }
  const home = await canonicalExisting(homedir())
  if (target === home || resolve(dirInput) === home) {
    throw new Error(`Refusing to remove the home directory: ${dirInput}`)
  }
  // `worktree list` always lists the main checkout first.
  const mainPath = await canonicalOrAbsent(registered[0]!.path)
  if (target === mainPath || target === repoRoot || repoRoot.startsWith(target + sep)) {
    throw new Error(`Refusing to remove ${dirInput}: it is the main checkout or a parent of the repository.`)
  }

  // --- exact registration proof: unregistered ⇒ refuse, no exceptions ---
  const canon: Array<RawWorktree & { canonical: string }> = []
  for (const wt of registered) canon.push({ ...wt, canonical: await canonicalOrAbsent(wt.path) })
  const entry = canon.find((w) => w.canonical === target)
  if (!entry) {
    throw new Error(
      `Refusing to remove ${dirInput}: it is not a registered linked worktree of ${repoRoot}. Revva never acts on paths git has no registration for — if the folder is gone as well there is nothing here for revva to clear, and the work row is left as it is.`
    )
  }
  // Removal would also eat any registered worktree nested inside the target.
  const nested = canon.find((w) => w.canonical !== target && w.canonical.startsWith(target + sep))
  if (nested) throw new Error(`Refusing to remove ${dirInput}: it contains another registered worktree (${nested.path}).`)
  // A lock is a human act to undo; a receipt that looks like revva's own proves
  // nothing (the creator may be alive, or long dead — syntax is not ownership).
  if (entry.locked) {
    throw new Error(`Refusing to remove ${dirInput}: it is locked (${entry.locked}). Unlock it deliberately in a terminal first — revva never unlocks worktrees.`)
  }

  const missing = await pathGone(target)
  const marker = await pathMarker(target)
  let trackedDirty = 0
  let untracked = 0
  let ignored = 0
  let head = ''
  let statusRecords: Buffer[] = []
  let fingerprints: string[] = []
  let indexHash: string
  const confirmationReasons: string[] = []

  if (!missing) {
    // Destructible inventory + per-path content fingerprint in one pass. Any
    // failure, anomaly or over-limit aborts the proof (no fallback values).
    const scan = await fingerprintDestructibleContent(target)
    statusRecords = scan.records
    fingerprints = scan.fingerprints
    trackedDirty = scan.trackedDirty
    untracked = scan.untracked
    ignored = scan.ignored
    head = await exec('git', ['-C', target, 'rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: GIT_TIMEOUT })
      .then((r) => r.stdout.trim())
      .catch(() => {
        throw new Error(`Cannot determine HEAD of ${dirInput}. Removal is refused while its commits are unknown.`)
      })
    // The INDEX too: staged contents can move while every status letter and
    // on-disk file above stays byte-identical (stage v1, restore, stage v2).
    indexHash = (await fingerprintIndex(target)).toString('hex')

    if (trackedDirty > 0) confirmationReasons.push(`${trackedDirty} uncommitted tracked change${trackedDirty === 1 ? '' : 's'} will be destroyed`)
    if (untracked > 0) confirmationReasons.push(`${untracked} untracked file${untracked === 1 ? '' : 's'} will be destroyed`)
    if (ignored > 0)
      confirmationReasons.push(
        `${ignored} ignored path${ignored === 1 ? '' : 's'} (dependencies, build output — can be irreplaceable) will be destroyed; git checks none of it on removal`
      )
    if (!entry.branch && head) confirmationReasons.push('detached HEAD — its commits are on no branch and revva cannot prove they live elsewhere')
  } else {
    // Provably-gone folder: its index (like its files) was already destroyed
    // outside revva and is unreachable — absence is the bound state here.
    indexHash = 'absent'
  }

  return {
    repoDir: repoRoot,
    directory: target,
    branch: entry.branch,
    detached: !entry.branch,
    missing,
    trackedDirty,
    untracked,
    ignored,
    requiresConfirmation: confirmationReasons.length > 0,
    confirmationReasons,
    signature: signRemovalState(target, entry.branch ?? null, head, marker, statusRecords, fingerprints, indexHash)
  }
}

/**
 * Binds a confirmation to the exact destructible picture the user was shown:
 * canonical path, branch, HEAD, the path object marker (absence or the exact
 * folder — recreation by anyone voids it), the Git index fingerprint (staged
 * blob OIDs — staged contents can change while every status letter and disk
 * record below stays identical), every raw porcelain status record (tracked,
 * staged, untracked, ignored — rename sources included), and the per-path
 * content fingerprint (kind, size, mode, inode, mtimeNs, ctimeNs, symlink
 * target string; embedded-repo directories scanned recursively). Any drift —
 * staged content, edited file content (size/mtime), new or vanished paths,
 * link swaps, folder recreation — changes the signature and voids the
 * confirmation. No placeholder fallbacks exist: anything unreadable or
 * over-limit throws first. Known limit, stated not hidden: an exact-mtime,
 * exact-size rewrite passes the fingerprint; plain `worktree remove` still
 * refuses modified/untracked content at deletion time — which `--force`
 * (confirmed only) skips.
 */
function signRemovalState(
  target: string,
  branch: string | null,
  head: string,
  marker: string,
  statusRecords: Buffer[],
  fingerprints: string[],
  indexHash: string
): string {
  const h = createHash('sha256')
  h.update('revva-worktree-removal-v6\u0000')
  h.update(target).update('\u0000')
  h.update(branch ?? 'detached').update('\u0000')
  h.update(head).update('\u0000')
  h.update(marker).update('\u0000')
  h.update(indexHash).update('\u0000')
  for (const rec of [...statusRecords].sort(Buffer.compare)) h.update(rec).update('\u0000')
  h.update('\u0001')
  for (const fp of [...fingerprints].sort()) h.update(fp).update('\u0000')
  return h.digest('hex')
}

/** The confirmed state no longer matches reality. */
export function staleConfirmationError(): Error {
  return new Error('The worktree is not in the state you confirmed (contents or state changed since the preview). Nothing was removed — review it again.')
}

export interface OccupancyProof {
  free: boolean
  reason: string
}

/**
 * Fail-closed active-agent proof for one canonical directory, against the
 * authoritative OpenCode service: every session the service reports active —
 * revva-indexed or not (builds, reviewers, foreign chats) — is fetched for its
 * canonical `location.directory`; the location's PTYs are enumerated for open
 * terminals. Service unreachable, any query failure, any hit ⇒ not free.
 * Inactivity that cannot be established is not assumed absent.
 */
export async function probeActiveAgentsInside(canonicalDirectory: string): Promise<OccupancyProof> {
  try {
    const api = openCodeService.api
    const active = await api.session.active()
    for (const sessionId of Object.keys(active)) {
      const session = await api.session.get({ sessionID: sessionId })
      const locationDir: unknown = session.location?.directory
      if (typeof locationDir !== 'string' || !locationDir) {
        return { free: false, reason: `active session ${sessionId} has no resolvable working directory` }
      }
      const canonical = await canonicalOrAbsent(locationDir)
      if (canonical === canonicalDirectory || canonical.startsWith(canonicalDirectory + sep)) {
        return { free: false, reason: `agent session ${sessionId} is running inside it — interrupt or move it out first` }
      }
    }
    // Interactive terminals are writers too. PTY listing is location-scoped by
    // design; a location the service does not know hosts no service PTYs.
    const res = await api.pty.list({ location: { directory: canonicalDirectory } })
    for (const pty of res.data) {
      if (pty.status !== 'running') continue
      if (typeof pty.cwd !== 'string' || !pty.cwd) {
        return { free: false, reason: 'a running terminal has no resolvable working directory' }
      }
      const canonical = await canonicalOrAbsent(pty.cwd)
      if (canonical === canonicalDirectory || canonical.startsWith(canonicalDirectory + sep)) {
        return { free: false, reason: 'a terminal is open inside it — close it first' }
      }
    }
    return { free: true, reason: '' }
  } catch (err) {
    return {
      free: false,
      reason: `active agents cannot be ruled out — the OpenCode service could not be consulted (${String((err as Error).message ?? err).split('\n')[0]})`
    }
  }
}

/** Throws unless absence of active agents inside the canonical directory is proven. */
export async function requireAbsenceOfAgents(canonicalDirectory: string): Promise<void> {
  const proof = await probeActiveAgentsInside(canonicalDirectory)
  if (!proof.free) throw new Error(`Nothing was removed: ${proof.reason}.`)
}

/**
 * Performs the confirmed removal of exactly one path. `force` must only be true
 * when the user confirmed that exact dirty state (content fingerprint
 * revalidated by the caller immediately before). On a provably-gone folder git
 * clears only that one registration and destroys nothing. Every git outcome is
 * classified — nothing is swallowed: an unrecognised failure is rethrown.
 */
export async function performRemoval(repoRoot: string, target: string, force: boolean): Promise<void> {
  try {
    await exec('git', ['-C', repoRoot, 'worktree', 'remove', ...(force ? ['--force'] : []), target], { timeout: 60_000 })
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    const message = String(e.stderr || e.message || 'git failed')
    const first = message.trim().split('\n').find((l) => l.includes('fatal:')) ?? message.trim().split('\n')[0]
    if (/locked/i.test(message)) {
      throw new Error(`git refused — the worktree was locked since the preview (${first}). Unlock it yourself first; revva never unlocks. Nothing was removed.`)
    }
    if (/validation failed|not a working (tree|directory)/i.test(message)) {
      throw new Error(
        `The folder at ${target} is not what git registered (it was recreated or changed after the preview). Nothing was removed — review the worktree again.`
      )
    }
    if (/does not exist|destination path/i.test(message)) {
      // Vanished between preview and execution: nothing on disk was destroyed;
      // the registration needs one inert cleanup pass on the next attempt.
      throw new Error(`The folder at ${target} disappeared mid-removal (nothing was destroyed by it). Run the cleanup once more to clear the registration.`)
    }
    if (/contains modified or untracked files/i.test(message)) {
      // Only ever reached without --force: the fingerprint matched moments ago,
      // so this content arrived between the recheck and git's own deletion-time
      // check — an external writer. Refuse; never escalate to force here.
      throw new Error(
        'git refused: the worktree picked up modified or untracked files between the check and the deletion (an external program wrote inside it — this is the race revva warns about). Nothing was removed. Review the worktree again if you want to delete that content too.'
      )
    }
    throw new Error(`Could not remove the worktree: ${first}`)
  }
}
