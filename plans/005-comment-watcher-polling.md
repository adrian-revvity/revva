# Plan 005: Make the Jira comment watcher quiet — 5-minute default, overlap guard, per-work seen-id short-circuit, bounded parallel fetch

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 830a20f..HEAD -- src/main/jira/watch.ts src/shared/types.ts`
> On any diff, re-read the live code and treat mismatches with "Current state" as STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `830a20f`, 2026-10-28

## Why this matters

`watch.ts` polls **every 60 seconds** (docs/ARCHITECTURE.md §2 specifies
"Poll loop (default 5 min)" — the code drifted from the design). Each poll
loops **serially** over every work with `state = 'SHIPPED' OR pr_url IS NOT
NULL` and fetches the **whole issue** via Atlassian MCP (`jiraMcp.comments(key)`
→ `getIssue`) — the ticket set only grows with history, so after a few sprints
every minute contains a burst of sequential remote calls. Worse, per pass it
re-issues one `INSERT OR IGNORE` for **every comment ever seen** on every
ticket, and nothing prevents poll N+1 starting while poll N is still awaiting
the network. This plan restores the documented 5-minute default (user-tunable),
prevents overlap, short-circuits known comments with one SELECT per work
instead of N inserts, and fetches issues with bounded concurrency (3 at a time).

## Current state

- `src/main/jira/watch.ts:19` — `const POLL_MS = 60_000`; used only in `wire()`:
  ```ts
  this.timer = setInterval(() => void this.poll().catch(() => undefined), POLL_MS)
  ```
- `poll()` (`watch.ts:93-126`): guard `if (!jiraMcp.connected) return`; loads
  works (`SELECT id, ticket_key FROM work WHERE state = 'SHIPPED' OR pr_url IS
  NOT NULL`); `const me = await jiraMcp.myAccountId()`; then a `for (const w of
  works)` loop that awaits `jiraMcp.comments(w.ticket_key)` one at a time
  (`catch { continue }` on transient failure), and for each comment runs an
  `INSERT OR IGNORE INTO jira_comment(work_id, ticket_key, comment_id, ...)`
  (PK is `(work_id, comment_id)`), tracking `changed` via `res.changes > 0`;
  finally `if (changed) this.pushPending()`.
- `jiraMcp.comments()` (`src/main/jira/mcp.ts`) = full `getIssue` per call; no
  list-comments tool exists (documented in the file header — do not try to
  "find" a cheaper tool).
- Settings pattern: `settingGet<T>('key')` from `../db`; allowed keys are the
  zod enum `settingsKeySchema` in `src/shared/types.ts` (currently includes
  `'reviewMaxRounds'`, `'jira.connected'`, `'jira.siteUrl'`, …). IPC
  settings get/set validates against it, so a new key must be added there.
- Repo conventions: singleton class with `wire()`; concise comments stating why.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Build | `pnpm build` | exit 0 |
| Manual | `pnpm dev` | Steps 4-5 |

## Scope

**In scope**:
- `src/main/jira/watch.ts` (poll cadence + poll body only — `tackleComments`,
  `onEvent`, `finishRework` untouched)
- `src/shared/types.ts` (add one key to `settingsKeySchema` only)

**Out of scope**:
- `src/main/jira/mcp.ts` (retry/capability mapping is deliberate).
- Any UI.
- Other watchers/subsystems' timers (`bus.ts`, `service.ts` — different jobs).

## Git workflow

- Branch: `advisor/005-comment-watcher-polling`
- Commit style: `perf(jira): 5-min configurable comment poll, overlap guard, seen-id short-circuit`
- Do NOT push.

## Steps

### Step 1: Add the settings key

In `src/shared/types.ts`, add `'jira.commentPollSecs'` to the `settingsKeySchema`
enum array (next to `'jira.siteUrl'`). No other schema changes.

**Verify**: `grep -n "commentPollSecs" src/shared/types.ts` → one match.

### Step 2: Cadence + overlap guard

In `watch.ts`:
- Replace the constant with a default + reader:
  ```ts
  const DEFAULT_POLL_SECS = 300 // docs/ARCHITECTURE.md: "Poll loop (default 5 min)"
  function pollMs(): number {
    const secs = settingGet<number>('jira.commentPollSecs')
    return Math.max(60, secs ?? DEFAULT_POLL_SECS) * 1000
  }
  ```
  (`import { getDb, settingGet } from '../db'` — getDb is already imported.)
- `wire()` uses `setInterval(..., pollMs())`. Note: interval length is read at
  wire time; that's fine — document it with one comment line ("takes effect on
  restart").
- Add `private polling = false` and guard `poll()`:
  ```ts
  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try { /* existing body */ } finally { this.polling = false }
  }
  ```

**Verify**: `pnpm typecheck` exit 0, no errors.

### Step 3: Per-work seen-id short-circuit + bounded parallel fetch

Restructure the per-work loop into a helper, then run helpers with a cap of 3
concurrent:

```ts
private async pollWork(w: { id: string; ticket_key: string }, me: string | undefined): Promise<boolean> {
  let comments: Awaited<ReturnType<typeof jiraMcp.comments>>
  try {
    comments = await jiraMcp.comments(w.ticket_key)
  } catch {
    return false // transient MCP failure — next tick retries
  }
  // One read replaces N INSERT-OR-IGNOREs on the common no-change path.
  const known = new Set(
    (getDb().prepare('SELECT comment_id FROM jira_comment WHERE work_id = ?').all(w.id) as Array<{ comment_id: string }>)
      .map((r) => r.comment_id)
  )
  let changed = false
  for (const c of comments) {
    const id = String(c.id ?? '')
    if (!id || known.has(id)) continue
    const body = extractText(c.body)
    const mine = (!!me && c.author?.accountId === me) || REVVA_MARKERS.some((m) => body.includes(m))
    if (mine) continue
    getDb().prepare(`INSERT OR IGNORE INTO jira_comment(...) VALUES(?,?,?,?,?,?,?)`)
      .run(w.id, w.ticket_key, id, c.author?.displayName ?? 'unknown', body,
           Date.parse(c.created ?? '') || Date.now(), Date.now())
    changed = true
  }
  return changed
}
```
(Keep the exact column list/`INSERT` from the current code — shown elided only
because it is unchanged.) In `poll()`, replace the serial `for` loop with:
```ts
const queue = [...works]
const results: boolean[] = []
async function worker(): Promise<void> {
  for (let w = queue.shift(); w; w = queue.shift()) results.push(await this.pollWork(w, me))
}
await Promise.all([worker(), worker(), worker()]) // 3-way concurrency cap
if (results.some(Boolean)) this.pushPending()
```
Bind `this` correctly (either write `worker` as an arrow closure calling
`this.pollWork`, or capture `const self = this`; pick whichever keeps
typecheck clean — an inline async arrow inside the method is simplest).

**Verify**: `pnpm typecheck` exit 0, no errors. `grep -n "INSERT OR IGNORE" src/main/jira/watch.ts` → still exactly one (moved, not duplicated).

### Step 4: Manual verification

`pnpm dev` with Jira connected and at least one SHIPPED/PR'd work:
1. Watch main-process console: first poll runs at startup; **no second burst
   until ~5 min later** (temporarily set `jira.commentPollSecs` to `60` via
   Settings → not exposed in UI? then verify via
   `sqlite3 ~/Library/Application\ Support/revva/revva.db "INSERT INTO settings(key,value) VALUES('jira.commentPollSecs','60')"`
   before launch, and delete the row afterwards).
2. Add a comment by someone else on a watched ticket (or ask a teammate / use a
   second account; if impossible, confirm at minimum no errors and existing
   comments are **not** re-inserted: row count of `jira_comment` unchanged
   across two polls).

**Verify**: cadence observed; alert still appears for genuinely new comments; `jira_comment` row count stable without new comments.

### Step 5: Build gate

**Verify**: `pnpm build` → exit 0 .

## Test plan

No automated tests (AGENTS.md policy). Step 4 is the verification.

## Done criteria

- [ ] `watch.ts` contains `DEFAULT_POLL_SECS = 300`, `pollMs()`, `private polling` guard, `pollWork()`, and the 3-worker cap
- [ ] `grep -c "INSERT OR IGNORE" src/main/jira/watch.ts` → 1
- [ ] `pnpm typecheck` exit 0, no errors; `pnpm build` exit 0
- [ ] Step 4 cadence + no-churn observation recorded
- [ ] Only `watch.ts` + one line in `types.ts` modified; `plans/README.md` row updated

## STOP conditions

- `settingsKeySchema` no longer exists or settings validation moved elsewhere.
- The current `poll()` differs from the described body (owner changed fetch shape/watermark logic).
- Manual test 2 shows new comments STOP being detected (the short-circuit must never skip unseen ids — if you see this, revert Step 3 locally and report).

## Maintenance notes

- If ticket history grows large, the next step (deferred here) is pruning:
  stop polling works shipped more than ~30 days ago (needs a shipped_at column —
  belongs with plan 001's migration list).
- Reviewers: `changed` must remain true only for newly-INSERTED comments —
  `known.has` skip plus unconditional `changed = true` after insert mirrors the
  old `res.changes > 0` semantics; a race between the SELECT and INSERT is
  harmless (INSERT OR IGNORE still dedupes; worst case a redundant push).
