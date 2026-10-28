# Plan 002: Cache session→owner lookups so no SQLite query runs per streaming token

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 830a20f..HEAD -- src/main/opencode/session-index.ts src/main/opencode/chats.ts src/main/opencode/inbox.ts src/main/pipeline/works.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-centralize-sqlite-schema-versioned-migrations.md (touches the same files' `ensureSchema` sites — land 001 first)
- **Category**: perf
- **Planned at**: commit `830a20f`, 2026-10-28

## Why this matters

Every `session.text.delta` event from the OpenCode SSE stream (potentially
tens per second per running session) triggers **synchronous SQLite queries on
the main process event loop**: `works.ts` runs `workBySession()` (a `SELECT *`),
`chats.ts` runs `isChat()`, and `inbox.ts` runs `isKnown()` (two queries).
better-sqlite3 is fast but synchronous, and these per-token lookups compete
with the same loop that must forward the deltas to the renderer. A tiny
in-memory registry of "which sessions does revva own, and as what" removes all
of them, and gives chats/works/inbox one source of truth instead of three
db-probe variants.

## Current state

- `src/main/pipeline/works.ts:298-300` —
  ```ts
  private workBySession(sessionId: string): WorkRow | undefined {
    return getDb().prepare('SELECT * FROM work WHERE session_id = ?').get(sessionId) as WorkRow | undefined
  }
  ```
  called from `onEvent()` (every event incl. deltas, line 306), `followUp()`, `interrupt()`.
- `src/main/opencode/chats.ts:322-324` —
  ```ts
  private isChat(sessionId: string): boolean {
    return getDb().prepare('SELECT 1 FROM chat WHERE session_id = ?').get(sessionId) !== undefined
  }
  ```
  called from `onEvent()` (line 342 region) on every event.
- `src/main/opencode/inbox.ts:187-193` — `isKnown()` = two `SELECT 1` queries
  (chat, work), called on `form.created` / `permission.asked` events.
- Sessions enter/leave these tables at known points only:
  - chat insert: `chats.ts create()` (`INSERT INTO chat`), `reconcile()` (`INSERT OR IGNORE`);
    delete: `chats.ts remove()` (`DELETE FROM chat`).
  - work insert: `works.ts start()` (`INSERT INTO work`); `session_id` set right
    after (`UPDATE work SET session_id`); worktree/rework change it in
    `jira/watch.ts tackleComments()` and `finishRework()` (`UPDATE work SET session_id`).
  - Review/fixer sessions are **not** in `chat`/`work` by session id directly —
    review.ts tracks them in its own `this.sessions` map; do not change that here.

Repo conventions: classes exported as singletons (`export const chatManager = new ChatManager()`);
main process ESM; concise "why" comments.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Build | `pnpm build` | exit 0 |
| Manual run | `pnpm dev` | chat streaming + ticket cockpit still show live output |

## Scope

**In scope**:
- `src/main/opencode/session-index.ts` (create)
- `src/main/opencode/chats.ts`, `src/main/opencode/inbox.ts`, `src/main/pipeline/works.ts`
- `src/main/jira/watch.ts` (only the two `UPDATE work SET session_id` sites, to notify the index)

**Out of scope**:
- `src/main/review.ts` and its `sessions` Map (already in-memory, correct as-is).
- `src/main/db/` schema — no table changes.
- The delta payload semantics (plan 003 handles those).

## Git workflow

- Branch: `advisor/002-session-index`
- Commit style: `perf(opencode): in-memory session index replaces per-event sqlite probes`
- Do NOT push.

## Steps

### Step 1: Create `src/main/opencode/session-index.ts`

A tiny registry keyed by sessionId with `kind: 'chat' | 'work'`:

```ts
/**
 * In-memory index: sessionId → what revva owns it as. SSE deltas arrive far
 * faster than any SQLite probe should; entries are registered at the same
 * places that write the sqlite rows and rebuilt from sqlite on boot.
 */
type SessionKind = 'chat' | 'work'

class SessionIndex {
  private kinds = new Map<string, SessionKind>()

  register(sessionId: string, kind: SessionKind): void { this.kinds.set(sessionId, kind) }
  forget(sessionId: string): void { this.kinds.delete(sessionId) }
  kindOf(sessionId: string): SessionKind | undefined { return this.kinds.get(sessionId) }

  /** Rebuild from sqlite (boot / safety net). Work rows key on session_id. */
  rebuild(): void { /* SELECT session_id FROM chat; SELECT session_id FROM work WHERE session_id IS NOT NULL */ }
}

export const sessionIndex = new SessionIndex()
```

`rebuild()` imports `getDb` lazily inside the method or at top (top is fine —
`db/index.ts` has no import cycle with `opencode/`). Call `sessionIndex.rebuild()`
from `src/main/index.ts` inside the `app.whenReady()` block **after** the
existing `*.wire()` calls (one added line; `index.ts` is in scope for this
single line).

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 2: Register/forget at every write site

- `chats.ts create()` after the `INSERT INTO chat`: `sessionIndex.register(session.id, 'chat')`.
- `chats.ts reconcile()` after each successful insert: same (guard on the row actually
  being inserted — `changes > 0` on the run result, or unconditionally is fine since
  register is idempotent).
- `chats.ts remove()`: `sessionIndex.forget(sessionId)`.
- `works.ts start()` after `UPDATE work SET session_id = ?`: `sessionIndex.register(session.id, 'work')`.
- `works.ts abandon()`: `sessionIndex.forget(work.session_id)` (when set).
- `jira/watch.ts tackleComments()` after its `UPDATE work SET session_id = ?`:
  `sessionIndex.register(session.id, 'work')`.

**Verify**: `grep -n "sessionIndex\." src/main/opencode/chats.ts src/main/pipeline/works.ts src/main/jira/watch.ts` → ≥7 call sites. `pnpm typecheck` clean.

### Step 3: Replace the per-event probes

- `works.ts onEvent()`: replace `this.workBySession(sessionId)` at the top of
  `onEvent` with a fast miss: `if (sessionIndex.kindOf(sessionId) !== 'work') return`,
  then **keep** the `workBySession()` query for the row itself (state checks need
  the row) — the win is that non-work sessions (chats, reviewer sessions) now
  return without touching SQLite. In `followUp()`/`interrupt()` keep the query
  (not hot paths).
- `chats.ts onEvent()`: replace `if (!this.isChat(sessionId)) return` with
  `if (sessionIndex.kindOf(sessionId) !== 'chat') return`; delete `isChat()`.
- `inbox.ts isKnown()`: reimplement as
  `return sessionIndex.kindOf(sessionID) !== undefined` (keep the method name);
  delete the two queries.

**Verify**: `grep -n "isChat" src/main/opencode/chats.ts` → no matches.
`pnpm typecheck` → exit 0, no errors.

### Step 4: Manual smoke test

`pnpm dev`. Open a chat, send a prompt → deltas stream into the transcript.
Start no ticket work needed. Then: quit, restart `pnpm dev` (exercises
`rebuild()`), reopen the same chat, send another prompt → still streams.

**Verify**: both passes work; console shows no errors mentioning sessionIndex.

## Test plan

No automated tests (repo policy — AGENTS.md "YOLO"). The manual smoke test in
Step 4, including the restart path, is the audit trail.

## Done criteria

- [ ] `grep -n "isChat" src/main/opencode/chats.ts` → no matches
- [ ] `grep -c "sessionIndex\." src/main -r` (summed) ≥ 8 including `index.ts`
- [ ] `pnpm typecheck` exit 0, no errors; `pnpm build` exit 0
- [ ] Step 4 manual smoke passes pre- and post-restart
- [ ] Only in-scope files modified; `plans/README.md` row updated

## STOP conditions

- Any listed write site doesn't exist where described (drift).
- `sessionIndex.rebuild()` on boot reveals that a session id can be **both** a
  chat and a work session (the Map would thrash kinds) — report; the design
  assumes exclusivity (chat rows and work rows never share a session id).
- Streaming breaks or a sidebar activity dot stops updating in the smoke test.

## Maintenance notes

- New session-creating features (e.g. github.ts review chats go through
  `chatManager.create()`, so they're covered) must call `sessionIndex.register`
  wherever they insert into `chat`/`work` outside those managers.
- If sessions ever gain a third kind, extend the union; nothing else changes.
