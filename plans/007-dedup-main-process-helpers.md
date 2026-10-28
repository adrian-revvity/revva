# Plan 007: Extract the five copy-pasted helpers shared by main-process modules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 830a20f..HEAD -- src/main/push.ts src/main/util.ts src/main/opencode/chats.ts src/main/pipeline/works.ts src/main/review.ts src/main/jira/watch.ts src/main/scripts.ts src/main/opencode/bus.ts src/main/opencode/service.ts src/main/opencode/inbox.ts`
> On any diff, re-read the live code and treat mismatches with "Current state" as STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001 (same modules touched — land 001 first); land AFTER plans 002/003 if they're picked too (they edit some of the same `onEvent` bodies; sequencing avoids conflicts — this plan is mechanical once they settle)
- **Category**: tech-debt
- **Planned at**: commit `830a20f`, 2026-10-28

## Why this matters

Five pieces of logic exist twice-plus in `src/main/`, each already drifting:
the ADF→text tree walker differs between its two copies in how it joins
(`'\n'` vs `' '`), the 409-conflict detector exists once as a named function
and once inline, the images→data-URI mapping is character-identical in two
files, "last assistant message → concat text parts" is duplicated, and the
`for (const win of BrowserWindow.getAllWindows()) win.webContents.send(...)`
loop is hand-rolled **13+ times across 8 files**. Every future change to any
of these (e.g. new event routing, new image handling) must be remembered in N
places — the classic divergence tax. This plan extracts them into two tiny
modules (`src/main/push.ts`, `src/main/util.ts`) and converts all call sites.

## Current state

Exact duplication pairs/triples (locate by symbol — these files move often):

1. **Push loop** — `for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.eventPush, X)`:
   `chats.ts` module-level `send()` (~line 145), `inbox.ts push()`,
   `works.ts emit()` + inline in its delta case, `review.ts` inline delta case +
   `push()`, `scripts.ts push()`, `watch.ts send()` + inline delta case +
   `pushPending()` caller, `bus.ts pushActivity/pushInbox/pushModel` (3×),
   `service.ts setStatus()`. Two files (`chats.ts`, `watch.ts`) already have the
   exact free function `function send(event: PushEvent)` — make that the shared one.
2. **ADF walker** — `works.ts:433-452` `extractDescription` (extracts
   `raw.fields.description`, joins `'\n'`) vs `watch.ts:229-242` `extractText`
   (takes the node directly, joins `' '` + `.trim()`). Same `walk` body.
3. **Last-assistant concat** — `review.ts settle()` (~285-290) and `watch.ts
   finishRework()` (~200-206): identical `message.list({ order:'asc', limit:200 })`
   → `[...data].reverse().find(m => m.type==='assistant')` → concat `p.type==='text'` parts.
4. **409 conflict detect** — `chats.ts:19-24 isConflict()` vs `works.ts:392`
   inline: `(err as {status?})?.status === 409 || /409|conflict|busy|already running/i.test(msg)`
   (chats also `msg.includes('409')`).
5. **Images→files mapping** — `chats.ts:297-299` and `works.ts:373-375`,
   byte-identical:
   ```ts
   const files = images.map((img) => {
     const base64 = img.data.startsWith('data:') ? img.data.slice(img.data.indexOf(',') + 1) : img.data
     return { uri: `data:${img.mime};base64,${base64}`, name: img.name }
   })
   ```

Repo conventions: main process ESM, no `require()`; two-line "why" comments;
module-level free functions are normal here (`chats.ts send`, `watch.ts send`).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Build | `pnpm build` | exit 0 |
| Manual | `pnpm dev` | Step 6 |

## Scope

**In scope**:
- `src/main/push.ts` (create), `src/main/util.ts` (create)
- Call-site conversion in: `src/main/opencode/chats.ts`, `src/main/opencode/bus.ts`,
  `src/main/opencode/service.ts`, `src/main/opencode/inbox.ts`,
  `src/main/pipeline/works.ts`, `src/main/review.ts`, `src/main/scripts.ts`,
  `src/main/jira/watch.ts`

**Out of scope**:
- `src/main/worktrees.ts`, `src/main/ipc.ts`, `src/main/github.ts` — owner's
  in-flight area; if `worktrees.ts` has its own send loop, leave it (it can be
  converted by a later pass; do not touch).
- Any behavior change: this is a pure extract-function refactor. The ONE
  allowed behavior decision is Step 2's join choice — flagged there.
- Renderer (`src/renderer/**`).

## Git workflow

- Branch: `advisor/007-dedup-main`
- Commit style: `refactor(main): shared push helper + adf/message/conflict/image utils`
- Do NOT push.

## Steps

### Step 1: `src/main/push.ts`

```ts
/**
 * Single place that fans an event out to all renderer windows. Preload
 * subscribes every window to IPC.eventPush; keeping the loop here means
 * window-management policy (e.g. filtering hidden windows) changes once.
 */
import { BrowserWindow } from 'electron'
import { IPC, type PushEvent } from '@shared/types'

export function pushToWindows(event: PushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.eventPush, event)
}
```

Replace all hand-rolled loops with `pushToWindows(event)` calls. Notes:
- `bus.ts` currently builds `update` per event type then loops 3× — same conversion.
- `scripts.ts push()` takes a union of two PushEvent member types — it satisfies
  `PushEvent`; widen its parameter to `PushEvent` and delegate.
- Delete `chats.ts`/`watch.ts` local `send()` functions; import instead.
- `service.ts setStatus()` pushes inline — convert too.

**Verify**: `grep -rn "getAllWindows()" src/main/opencode src/main/pipeline src/main/review.ts src/main/scripts.ts src/main/jira/watch.ts` →
only `inbox.ts focusWindow()` (uses `[0]`, different purpose) and
`ipc.ts`/`index.ts` (out of scope). `grep -rc "pushToWindows" src/main` ≥ 9 files.
`pnpm typecheck` exit 0, no errors.

### Step 2: `src/main/util.ts` — adf text extraction

```ts
/** Depth-first collect of ADF/markdown-ish `{text, content}` nodes into plain text. */
export function collectAdfText(node: unknown): string[] {
  const texts: string[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return void n.forEach(walk)
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      if (typeof o.text === 'string') texts.push(o.text)
      if (o.content) walk(o.content)
    }
  }
  walk(node)
  return texts
}
```

- `watch.ts extractText(body)` becomes
  `typeof body === 'string' ? body : collectAdfText(body).join(' ').trim()`
  (keeps its current `' '` join — comments read as prose).
- `works.ts extractDescription(raw)`: keep the `raw.fields.description`
  prelude + string fast-path; replace the walker with
  `collectAdfText(d).join('\n')` (keeps `'\n'` — descriptions are structured).
  Documented divergence in the joins is **intentional**; the shared part is the walk.

**Verify**: `grep -rn "const walk = (n: unknown)" src/main` → only in `util.ts`.

### Step 3: `util.ts` — last assistant text + conflict + prompt files

**STOP check first**: `util.ts` must not import chats/works/review/watch, and
`service.ts` must not import `util.ts` (it doesn't today — verify). If that
cycle holds, put `fetchLastAssistantText` in its own
`src/main/opencode/messages.ts` instead of `util.ts`; the other three helpers
stay in `util.ts` either way (they need no service import).

Add to `util.ts` (bodies = verbatim from the cited sites):

```ts
/** Concatenated text parts of a session's last assistant message ('' when none).
 *  Lives here (or messages.ts) so review + rework share one implementation. */
export async function fetchLastAssistantText(sessionID: string): Promise<string> {
  const res = await openCodeService.api.message.list({ sessionID, order: 'asc', limit: 200 })
  const last = [...res.data].reverse().find((m) => m.type === 'assistant')
  let text = ''
  for (const part of (last as { content?: unknown[] })?.content ?? []) {
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string') text += p.text
  }
  return text
}

/** The SDK error for "session busy" / conflicts carries status 409. */
export function isConflict(err: unknown): boolean { /* verbatim from chats.ts (locate by name) */ }

/** Prompt images → OpenCode `files` payloads (data URIs). */
export function promptImageFiles(images: PromptImage[]): { uri: string; name?: string }[] {
  return images.map((img) => {
    const base64 = img.data.startsWith('data:') ? img.data.slice(img.data.indexOf(',') + 1) : img.data
    return { uri: `data:${img.mime};base64,${base64}`, name: img.name }
  })
}
```
`PromptImage` comes from `@shared/types`.

Then: `review.ts settle()` try-block and `watch.ts finishRework()` message-load
blocks become `text = await fetchLastAssistantText(sessionId)`; keep each
caller's subsequent parsing (`parseVerdict`, `REVVA-REPLY` split) where it is.
Delete `chats.ts isConflict` (import instead); in `works.ts followUp()` replace
the inline conflict check with `isConflict(err)`. Replace both images-map
blocks with `const files = promptImageFiles(images)`.

**Verify**: `grep -rn "reverse().find" src/main` → zero; `grep -rn "isConflict" src/main` →
util.ts + 2 import-sites only; `grep -rn "indexOf(',')" src/main` → zero.

### Step 4: Import hygiene + typecheck

Remove now-unused imports (`BrowserWindow` where fully replaced, etc.).

**Verify**: `pnpm typecheck` → exit 0, no errors; `pnpm build` → exit 0 (or baseline-only).

### Step 5: Grep gates

**Verify**:
- `grep -rn "webContents.send(IPC.eventPush" src/main` → only `src/main/push.ts`
- `grep -rn "delivery: 'queue'" src/main` → exactly 2 call sites (chats, works), both using imported `isConflict`

### Step 6: Manual smoke (`pnpm dev`)

Chat sends/streaming works (push path), a script run streams output
(`script.output` via pushToWindows), inbox answer still clears a pending card.
No main-process console errors.

## Test plan

No automated tests (AGENTS.md). Step 6 manual pass + grep gates are the audit trail.

## Done criteria

- [ ] All Step 1/3/5 grep gates return exactly the described residue
- [ ] `pnpm typecheck` exit 0, no errors; `pnpm build` exit 0
- [ ] Diff is line-moved logic, zero semantic edits (the one exception: joins in Step 2, each preserved per-caller)
- [ ] `worktrees.ts`/`ipc.ts`/`github.ts` untouched (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- Any "Current state" duplication pair has ALREADY been unified by the owner (grep finds only one copy) → skip that item, note it, continue with the rest.
- Converting a push site requires changing what is pushed (payload shape drift) → report, skip site.
- Import cycle blocks Step 3's placement (after the prescribed alternative) → report.

## Maintenance notes

- Future main-process pushes: import `pushToWindows`; never hand-roll the loop.
- `worktrees.ts` (owner's new file) likely wants the same conversions — one
  follow-up commit after it stabilizes, not part of this plan.
