# Plan 006: Parallelize `inbox.resync()`, keep real timestamps and owner labels through re-sync

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 830a20f..HEAD -- src/main/opencode/inbox.ts`
> On any diff, re-read the live code and treat mismatches with "Current state" as STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plan 002 lightly touches the same file in `isKnown()`; if both are pending, land 002 first)
- **Category**: perf
- **Planned at**: commit `830a20f`, 2026-10-28

## Why this matters

`resync()` runs on service connect and on **every SSE reconnect** — exactly
when the user is most likely to be waiting on the inbox. It loops over all
known sessions and awaits **two sequential HTTP round-trips per session**
(`session.form.list` then `permission.list`). With 10 sessions at ~50ms each,
that's ~1 second of serial latency that parallelizes to ~100ms. Two secondary
bugs ride along: resync stamps `createdAt: Date.now()` (pending items visually
"jump" to now after every reconnect, breaking the oldest-first sort meaning)
and never sets `owner`, so after a reconnect the inbox cards lose their
"PROJ-123 / chat title" label until the next event.

## Current state

- `src/main/opencode/inbox.ts` `resync()` (lines 60-100): for each
  `sessionID of this.knownSessions()`, `await` `api.session.form.list(...)`
  then `await` `api.permission.list(...)`, building `fresh` map entries with
  `createdAt: Date.now()` and **no `owner` field**. Both calls wrapped in
  `try/catch { /* session gone */ }`. Ends with `this.pending = fresh; this.push()`.
- Live-event path (`onEvent`, lines 133-185) sets `owner: this.ownerLabel(...)`
  — the display field exists on `PendingItem` (`src/shared/types.ts`,
  `pendingItemSchema`; confirm the exact optional field names there).
- `ownerLabel()` (lines 125-131): chat title, else ticket key, else sessionId.
  `directoryOf()` is already memoized via `directoryCache`.
- Convention for settled concurrency in this repo: `review.ts` fan-out uses
  `await Promise.allSettled(live.map(async ({...}) => {...}))`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Build | `pnpm build` | exit 0 |
| Manual | `pnpm dev` | Step 4 |

## Scope

**In scope**: `src/main/opencode/inbox.ts` (only `resync()` and, if needed, a
small private helper).

**Out of scope**:
- `onEvent()` event semantics, `audit()`, notifications.
- `knownSessions()` SQL (correct as-is).
- Adding a `createdAt`-from-server field to `PendingItem` — the OpenCode
  `FormInfo` shape (verified: `{id, sessionID, title, metadata?, fields}`)
  carries **no timestamp**, so honest fix = preserve the previously-known
  `createdAt` across resyncs rather than fabricating one.

## Git workflow

- Branch: `advisor/006-inbox-resync`
- Commit style: `perf(inbox): parallel resync, preserve createdAt and owner across reconnects`
- Do NOT push.

## Steps

### Step 1: Preserve prior createdAt + set owner during resync

Rewrite `resync()` so that, per session, the two list calls run
concurrently and results merge into `fresh` with:
- `createdAt`: previous value from `this.pending.get(key)?.createdAt` when the
  key already existed, else `Date.now()` (newly discovered item).
- `owner: this.ownerLabel(sessionID)` added to both form and permission
  entries (matches what `onEvent` sets).

Shape (match repo style — `allSettled` like `review.ts`):

```ts
async resync(): Promise<void> {
  if (!openCodeService.connected) return
  const sessionIds = this.knownSessions()
  const fresh = new Map<string, PendingItem>()
  await Promise.allSettled(
    sessionIds.map(async (sessionID) => {
      const dir = this.directoryOf(sessionID)
      const owner = this.ownerLabel(sessionID)
      const [forms, perms] = await Promise.allSettled([
        openCodeService.api.session.form.list({ sessionID }),
        openCodeService.api.session.permission_list_shaped_call(...) // see note
      ])
      ...
    })
  )
  this.pending = fresh
  this.push()
}
```

**Note**: write the two awaits exactly as the current code calls them
(`api.session.form.list({ sessionID })` and `api.permission.list({ sessionID})`);
the sketch line above is a placeholder for "the same two calls, concurrently".
Map results with the existing entry builders; a rejected promise for either
call = that session is gone/unreadable → skip it (mirrors today's catch).
Map writes target the shared `fresh` Map — safe because JS is single-threaded
between awaits.

**Verify**: `pnpm typecheck` exit 0, no errors.

### Step 2: Confirm no cross-reconnect stampede

`resync()` is triggered by `openCodeService.onStatus(connected)` and
`eventBus 'stream:reconnect'`. Add a simple in-flight guard mirroring plan
005's pattern (single `private resyncing` boolean + re-run-once-if-requested
is overkill; boolean skip-with-log is fine — two reconnects within one resync
window are indistinguishable to the user since the final `this.pending =
fresh` is authoritative at completion).

**Verify**: `grep -n "resyncing" src/main/opencode/inbox.ts` → ≥2 matches.

### Step 3: Manual verification

`pnpm dev`, open a chat, and while a prompt is running kill the OpenCode
service (`pkill -f 'opencode serve'`), let Revva reconnect (it restarts the
service), have the agent raise a question (or approve a permission first so a
pending item exists before the drop — simplest: start a prompt whose answer
you delay). Confirm:
- Inbox item survives the reconnect and **keeps its original ordering** (its
  "waiting" position doesn't reset to newest).
- The card shows its owner label (chat title), not a bare session id,
  immediately after resync (before any new event).
- Inbox answers still work after the reconnect.

**Verify**: all three observed; main console clean.

### Step 4: Build gate

**Verify**: `pnpm build` → exit 0 .

## Test plan

No automated tests (AGENTS.md). Step 3 manual pass is the audit trail.

## Done criteria

- [ ] `resync()` body has zero sequential `await`s per session (concurrency via `Promise.all`)
- [ ] Both resync entry builders set `owner` and preserve `createdAt` for existing keys
- [ ] `grep -n "resyncing" src/main/opencode/inbox.ts` → matches
- [ ] `pnpm typecheck` exit 0, no errors; `pnpm build` exit 0
- [ ] Only `inbox.ts` modified; `plans/README.md` row updated

## STOP conditions

- The live SDK's `permission.list` signature differs from `{ sessionID }` as called today (check `chats`/`inbox` current code, not this plan).
- A pending item **disappears** after reconnect in Step 3 (means partial-failure
  semantics changed — report; do not paper over with extra retries).
- `PendingItem` lacks an `owner` field (plan premise wrong) — report.

## Maintenance notes

- If the OpenCode API later returns real `createdAt` on forms/permissions,
  prefer it over the preserve-previous fallback and drop that fallback.
- Reviewer check: the merge into `fresh` must never drop a session that threw —
  rejection of **both** calls for a session = session gone = correct to drop it,
  which matches today's behavior.
