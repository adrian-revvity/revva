# Plan 004: Replace idle IPC polling with the push events that already exist

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 830a20f..HEAD -- src/renderer/src/App.tsx src/renderer/src/views/Chat.tsx src/renderer/src/views/Setup.tsx src/renderer/src/views/ScriptsView.tsx src/main/opencode/bus.ts src/main/opencode/service.ts`
> On any diff, re-read the live code and treat mismatches with "Current state" as STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `830a20f`, 2026-10-28

## Why this matters

Four renderer queries poll on fixed intervals — `service-status` every 10s
(App) and 5s (Setup), `session.active()` every 5s (App, forever, in every
window), `session-model` every 10s and `session-queue` every 15s **per open
transcript** — even when the app window is idle in the background. Each poll is
an IPC invoke plus, for `session.active()`, an HTTP round-trip to the OpenCode
service. All of this data is **already pushed** from main: `service.ts`
`setStatus()` pushes `service`, the SSE bus pushes `session.activity`,
`session.model`, and `session.queue` for every session, and the renderer
already subscribes to all four (`App.tsx` events handler, `Chat.tsx` events
handler). The intervals only add load and latency-in-the-worst-case, not
correctness. Removing them (keeping initial fetch + TanStack's default
focus-refetch) eliminates essentially all steady-state background work.

## Current state

Renderer polls (`grep -rn refetchInterval src/renderer/src` at plan time):
- `src/renderer/src/App.tsx:63` — `['service-status']` `refetchInterval: 10_000`
- `src/renderer/src/App.tsx:71` — `['session-activity']` `refetchInterval: 5000`, `enabled: status.data?.state === 'connected'`
- `src/renderer/src/views/Chat.tsx:125` — messages query `refetchInterval: (q) => (q.state.status === 'error' ? 5000 : false)` ← **keep this one** (error recovery)
- `src/renderer/src/views/Chat.tsx:130` — `['session-model', sessionId]` `refetchInterval: 10_000`
- `src/renderer/src/views/Chat.tsx:138` — `['session-queue', sessionId]` `refetchInterval: 15_000`
- `src/renderer/src/views/Setup.tsx:35` — `['service-status']` `refetchInterval: 5000`
- `src/renderer/src/views/ScriptsView.tsx:30` — `['script-status']` `refetchInterval: 10_000`

Why pushes are sufficient (verified at plan time):
- `service` — `src/main/opencode/service.ts` `setStatus()` pushes on every state
  change, and its 15s health probe only re-enters `setStatus()` on actual
  transitions (`ensure()` always sets `connecting` then `connected`, so recovery pushes).
- `session.activity` — `src/main/opencode/bus.ts` `pushActivity()` forwards
  start/succeeded/failed/interrupted + busy/idle/retry status for **all**
  sessions. `App.tsx`'s existing handler merges pushes into the
  `['session-activity']` cache and only invalidates the full query when no
  cache exists yet (`if (!qc.getQueryData(...)) invalidate`) — so removing the
  interval keeps cold-start correctness.
- `session.model` / `session.queue` — `bus.ts` `pushModel()`/`pushInbox()`
  forward `session.model.selected` / `session.inbox.*` for all sessions (TUI
  and other clients included). `Chat.tsx` already has an events effect that
  invalidates `['session-queue', id]` and `['session-model', id]` on those pushes.
- `script.status` — `src/main/scripts.ts` `pushStatus()` fires on run start,
  finish, and remove; `ScriptsView.tsx` already replaces `['script-status']`
  from the push.
- TanStack Query v5 defaults `refetchOnWindowFocus: true` (see
  `src/renderer/src/main.tsx` — the QueryClient sets only `retry: 1`), so a
  focused window still re-syncs everything stale after sleep/blur.

Repo conventions: renderer = TanStack Query over `window.revva.*` IPC; events
via `window.revva.events.on(...)` — see `useInbox()` in
`src/renderer/src/views/InboxView.tsx:39-49` for the canonical push-fed query.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Build | `pnpm build` | exit 0 |
| Manual | `pnpm dev` | click-through in Steps |

## Scope

**In scope**:
- `src/renderer/src/App.tsx`, `src/renderer/src/views/Chat.tsx`,
  `src/renderer/src/views/Setup.tsx`, `src/renderer/src/views/ScriptsView.tsx`

**Out of scope**:
- Main process — no push-side changes; the events described above already exist.
- The `['chat-messages']` error-retry `refetchInterval` (`Chat.tsx:125`) — leave it.
- `WorkCockpit.tsx`'s focus/visibility refetch effect — that's a correctness belt, keep it.

## Git workflow

- Branch: `advisor/004-drop-idle-polling`
- Commit style: `perf(renderer): push-fed status/activity/queue, drop idle polling`
- Do NOT push.

## Steps

### Step 1: App.tsx

- `['service-status']`: change `refetchInterval: 10_000` → `refetchInterval: 60_000`
  (slow heartbeat as a safety net; pushes drive reality).
- `['session-activity']`: **delete** the `refetchInterval: 5000` line. The query
  still fires once when `enabled` flips to connected, and the existing push
  handler maintains it.

**Verify**: `grep -n refetchInterval src/renderer/src/App.tsx` → exactly one
match (`60_000`).

### Step 2: Chat.tsx

- `['session-model', sessionId]`: delete `refetchInterval: 10_000`.
- `['session-queue', sessionId]`: delete `refetchInterval: 15_000`.
- Update the existing comment above the events effect (currently "Inbox/queue
  and model selection change from outside this window too (TUI, other
  clients).") to note pushes from main are the update channel (bus forwards
  all sessions' events, so other clients are covered).
- Leave the error-retry interval on the messages query untouched.

**Verify**: `grep -n refetchInterval src/renderer/src/views/Chat.tsx` → one match (the error-branch one).

### Step 3: Setup.tsx and ScriptsView.tsx

- `Setup.tsx:35`: delete `refetchInterval: 5000` from the service-status query.
- `ScriptsView.tsx:30`: delete `refetchInterval: 10_000` from `['script-status']`.

**Verify**: `grep -rn refetchInterval src/renderer/src/` → matches **only** the
messages error-retry line and the App.tsx `60_000` heartbeat.

### Step 4: Manual verification (this is the real gate)

`pnpm dev`:
1. Kill the OpenCode service out from under Revva (`pkill -f 'opencode serve'`),
   wait ≤ ~30s: the sidebar footer must flip to an error/reconnecting state
   **without** waiting a minute (health probe pushes), then Restart it and see
   the state recover promptly.
2. Open a chat, send a prompt: sidebar chat row shows "Thinking…" while running
   and clears on completion (session.activity push). Interrupt mid-run — state clears.
3. From a **second** OpenCode client (TUI) or a second Revva chat, queue a
   message while one is running — the `#1 queued` strip appears when the
   `session.inbox.*` push lands (give it a beat; if you cannot drive a second
   client, verify queue add/remove inside Revva still updates the strip via its
   existing push handlers).
4. Scripts tab: run a script → live output + status update with no interval
   running (`script.status` push).

**Verify**: all four pass. Note in the report that push latency replaced polling latency.

## Test plan

Repo policy: no automated tests (AGENTS.md). Step 4 manual pass is the audit trail.

## Done criteria

- [ ] `grep -rn refetchInterval src/renderer/src/` → only the two intentional matches
- [ ] `pnpm typecheck` exit 0, no errors; `pnpm build` exit 0
- [ ] Step 4 manual pass recorded
- [ ] Only the four in-scope files modified; `plans/README.md` row updated

## STOP conditions

- Any of the claimed push sites (`pushActivity`, `pushModel`, `pushInbox`,
  `setStatus` push, `pushStatus`) is missing or has changed semantics.
- Manual test 1 shows the UI **not** recovering state after service restart (push
  gap) — means the health probe does not re-push as described; report instead of
  re-adding a fast poll.
- A new poll site exists in the tree that this plan didn't list (owner added one
  concurrently) — report; do not silently change files outside scope.

## Maintenance notes

- If a future query caches state that main does NOT push, it must keep its own
  interval — this plan removes only provably push-covered ones.
- Reviewers: the App.tsx `['session-activity']` cold path depends on the
  `getQueryData` guard in the existing handler — unchanged here, but keep it in
  mind when refactoring that handler.
