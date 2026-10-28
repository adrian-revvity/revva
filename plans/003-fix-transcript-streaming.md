# Plan 003: Make transcript streaming linear — accumulate once in main, coalesce pushes, memoize rows

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 830a20f..HEAD -- src/main/opencode/stream-buffer.ts src/main/opencode/chats.ts src/main/pipeline/works.ts src/main/review.ts src/renderer/src/views/Chat.tsx src/renderer/src/views/WorkCockpit.tsx src/renderer/src/views/ReviewPanel.tsx`
> On any diff, re-read the live code and treat mismatches with "Current state" as STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-in-memory-session-index.md (this plan edits the same `onEvent()` bodies right after that probe refactor)
- **Category**: perf
- **Planned at**: commit `830a20f`, 2026-10-28

## Why this matters

Three compounding problems make long streamed replies degrade quadratically:

1. **Main sends the full accumulated text on every token for chats**
   (`chats.ts:332-338` keeps `streaming` Map and pushes `text: entry.text` —
   the whole message so far). A 4000-token reply ships ~8 MB across IPC.
2. **The renderer re-renders every message row on every token.** `rows.map(...)`
   in `Chat.tsx:209-211` is un-memoized; each completed assistant row re-runs
   `ReactMarkdown` over its full text (`Chat.tsx:432`) on each incoming token.
3. **A `scrollIntoView({ behavior: 'smooth' })` fires per token**
   (`Chat.tsx:138-140`), so smooth-scroll animations constantly restart each
   other — the classic "fighting the scroll" jank on long output.

Meanwhile `work.delta`/`review.delta` push raw **per-token** increments and the
renderer (`WorkCockpit.tsx:52-78`, `ReviewPanel.tsx` `ReviewTranscript`)
re-implements the same buffer/reset-per-message accumulator that main already
has for chats — the same logic three times, with two different semantics.

After this plan: accumulation lives in **one** main-process helper, pushes are
**coalesced to ~50ms**, `chat.delta`/`work.delta`/`review.delta` all carry
**accumulated** text with identical semantics, the streaming row renders **as
plain text** (markdown runs once, when the message completes), completed rows
are memoized, and auto-scroll uses instant scrolling with a user-possibility
check.

## Current state

- `src/main/opencode/chats.ts` — `private streaming = new Map<string, { sessionId: string; text: string }>()`;
  `onEvent` case `session.text.delta` (~line 365; the `chats.ts` file is moving
  fast — locate by symbol, not line number):
  ```ts
  const msgId = String(data.assistantMessageID ?? '')
  const entry = this.streaming.get(msgId) ?? { sessionId, text: '' }
  entry.text += typeof data.delta === 'string' ? data.delta : ''
  this.streaming.set(msgId, entry)
  send({ kind: 'chat.delta', sessionId, messageId: msgId, text: entry.text })
  ```
  Completion cases (`session.execution.succeeded|failed|interrupted`, `session.idle`)
  call `this.touch`, `this.streaming.clear()` (~line 384), and
  `send({ kind: 'chat.idle', sessionId })`.
- `src/main/pipeline/works.ts:310-322` — `session.text.delta` case forwards raw
  `String(data.delta ?? '')` as `work.delta` when `work.state === 'BUILDING'`.
- `src/main/review.ts:249-261` — `session.text.delta` case forwards raw delta as
  `review.delta` for tracked reviewer sessions.
- `src/renderer/src/views/Chat.tsx`:
  - `TranscriptDrive.subscribe(sessionId, onDelta, onDone)` contract: "`onDelta`
    receives the FULL accumulated text" (doc comment lines 46-49). `chatDrive`
    (515-525) forwards `event.text` directly; `WorkCockpit`'s drive and
    `ReviewPanel`'s `ReviewTranscript` drive each hand-roll buffer logic.
  - `TranscriptView` render: `rows.map((m) => <MessageRow key={m.id} message={m} />)` (209-211);
    streaming row built as `{ id: 'streaming', role: 'assistant', text: streamingText ?? '' }` (212-217).
  - `MessageRow` (390-443) renders `ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}` per assistant row; `MD_COMPONENTS` is module-level (343-388).
  - Auto-scroll effect (138-140):
    ```ts
    useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [messages.data, streamingText])
    ```
- `src/shared/types.ts` `pushEventSchema` variants (498-518):
  `chat.delta {sessionId, messageId, text}`, `work.delta {workId, sessionId, messageId, text}`,
  `review.delta {workId, sessionId, messageId, text}`. **The wire shape does not change**
  — only the meaning of `text` for work/review becomes "accumulated", matching chat.
- Renderer consumes deltas nowhere else. `AGENTS.md`: no tests; verification is
  typecheck + build + manual click-through.

Repo conventions: main-process singletons with `wire()`; IPC payloads typed in
`src/shared/types.ts` (zod); Tailwind class strings inline; comments explain
"why" in 1-3 lines (e.g. `chats.ts:150` "SSE is live-only...").

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Build | `pnpm build` | exit 0 |
| Manual | `pnpm dev` | chat + cockpit stream live |

## Scope

**In scope**:
- `src/main/opencode/stream-buffer.ts` (create)
- `src/main/opencode/chats.ts` (replace its `streaming` Map with the helper)
- `src/main/pipeline/works.ts`, `src/main/review.ts` (delta cases only)
- `src/renderer/src/views/Chat.tsx`, `WorkCockpit.tsx`, `ReviewPanel.tsx`
- `src/renderer/src/lib/scroll.ts` (create, optional — see Step 6)

**Out of scope**:
- The `PushEvent` schema (`src/shared/types.ts`) — payload shape is unchanged; do not edit.
- `src/main/opencode/bus.ts` — untouched.
- Transcript loading (`chatManager.messages`), queue/model polls (plan 004),
  the `streaming` `streaming.clear()` semantics on completion.

## Git workflow

- Branch: `advisor/003-streaming`
- Commits: `perf(chat): coalesce streamed deltas in main`, `perf(ui): memoize transcript rows + instant autoscroll`, `refactor(ui): single delta accumulator for all transcript drives`
- Do NOT push.

## Steps

### Step 1: Create `src/main/opencode/stream-buffer.ts`

```ts
/**
 * Accumulates `session.text.delta` fragments per (sessionId, assistantMessageID)
 * and pushes the accumulated text to renderers, coalesced to one IPC per
 * COALESCE_MS per session. Per-token IPC is quadratic in message length and
 * floods the renderer's render loop; 20 Hz is indistinguishable from "live".
 */
import { BrowserWindow } from 'electron'
import { IPC, type PushEvent } from '@shared/types'
import { eventBus, type RawEvent } from './bus'

const COALESCE_MS = 50

/** chat.delta / work.delta / review.delta share this body shape. */
type DeltaKind = 'chat.delta' | 'work.delta' | 'review.delta'

export interface DeltaSource {
  kind: DeltaKind
  sessionId: string
  messageId: string
  text: string
  /** Extra discriminating fields (workId for work/review channels). */
  extra?: Record<string, unknown>
}

class StreamBuffer {
  private accum = new Map<string, { text: string; timer: NodeJS.Timeout | undefined; source: DeltaSource }>()

  /** Feed one raw delta. `sessionId` must exist in the source. */
  push(source: DeltaSource): void {
    const key = `${source.sessionId}:${source.messageId}`
    const entry = this.accum.get(key) ?? { text: '', timer: undefined, source }
    entry.text += source.text
    entry.source = source // refresh extra fields
    this.accum.set(key, entry)
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      const cur = this.accum.get(key)
      if (!cur) return
      this.send(cur.source, cur.text)
    }, COALESCE_MS)
  }

  /** Flush any pending text for a session and stop tracking it (completion). */
  flush(sessionId: string): void {
    for (const [key, entry] of this.accum) {
      if (!key.startsWith(`${sessionId}:`)) continue
      if (entry.timer) clearTimeout(entry.timer)
      this.send(entry.source, entry.text)
      this.accum.delete(key)
    }
  }

  private send(source: DeltaSource, text: string): void {
    const event = { kind: source.kind, sessionId: source.sessionId, messageId: source.messageId, text, ...source.extra } as PushEvent
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.eventPush, event)
  }
}

export const streamBuffer = new StreamBuffer()
```

Notes for the executor: `PushEvent` is a zod discriminated union; the three
delta variants are `{kind, sessionId, messageId, text}` and
`{kind, workId, sessionId, messageId, text}`. TypeScript will not accept the
spread cast above without help — the idiomatic fix in this repo is a
`satisfies`/explicit per-kind construction; write a small switch that builds
the right literal per `source.kind` if a cast is required. Keep casts minimal
and local.

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 2: Route chats through the shared buffer

In `chats.ts`: delete the `streaming` Map and the `session.text.delta` body.
Replace the case with:
```ts
case 'session.text.delta': {
  streamBuffer.push({
    kind: 'chat.delta',
    sessionId,
    messageId: String(data.assistantMessageID ?? ''),
    text: typeof data.delta === 'string' ? data.delta : ''
  })
  break
}
```
In the completion cases (the four-type group that today does
`this.touch + this.streaming.clear() + send chat.idle`), call
`streamBuffer.flush(sessionId)` **before** sending `chat.idle` (keeps ordering:
last text, then idle).

**Verify**: `grep -n "streaming" src/main/opencode/chats.ts` → no matches for the old
Map; `streamBuffer` imported. `pnpm typecheck` clean.

### Step 3: Route works and reviews through the shared buffer

`works.ts` `session.text.delta` case: keep the state check (`work.state !== 'BUILDING'` →
return), then replace the `BrowserWindow` loop with:
```ts
streamBuffer.push({
  kind: 'work.delta',
  sessionId,
  messageId: String(data.assistantMessageID ?? ''),
  text: String(data.delta ?? ''),
  extra: { workId: work.id }
})
```
`review.ts` `session.text.delta` case: same with `kind: 'review.delta'` and
`extra: { workId: tracked.workId }`.

Additionally, both completion paths must flush: in `works.ts` the
`session.execution.succeeded|failed|interrupted` cases call
`streamBuffer.flush(sessionId)` first; in `review.ts`, `settle()` calls
`streamBuffer.flush(sessionId)` right after deleting the tracked session. Do
not change any other behavior of those cases.

**Verify**: `grep -rn "webContents.send(IPC.eventPush" src/main/pipeline/works.ts src/main/review.ts` →
zero matches inside delta handling (state-change `emit()`/`push()` loops remain).
`pnpm typecheck` clean.

### Step 4: Simplify the two hand-rolled renderer drives

`chat.delta` semantics are unchanged (already accumulated) — `chatDrive`
(`Chat.tsx:515-525`) stays as-is. The other two drives must now forward
`event.text` directly instead of buffering:

- `WorkCockpit.tsx` `drive` useMemo (52-78): drop the closure `buffer`/
  `currentMessage` variables; the delta branch becomes
  `if (event.kind === 'work.delta' && event.workId === work.id) onDelta(event.text)`.
  Keep the `work.updated` completion branch exactly as it is.
- `ReviewPanel.tsx` `ReviewTranscript` drive: same — delta branch forwards
  `event.text`; the `review.updated` → look-up fresh row → `onDone()` logic
  remains unchanged.

**Verify**: `grep -n "buffer += \|currentMessage" src/renderer/src/views/WorkCockpit.tsx src/renderer/src/views/ReviewPanel.tsx` → no matches.

### Step 5: Memoize rows and stop re-parsing markdown per token

In `Chat.tsx`:
1. Wrap `MessageRow` in `memo`: `export const MessageRow = memo(function MessageRow({ message, streaming }: {...}) { ... })`.
   `ChatMessage` objects from react-query cache are stable by id across renders
   of the same data, so memo will hold. Import `memo` from `react`.
2. Streaming row renders as **plain text** — inside `MessageRow`, when
   `streaming` is true, render the assistant body as a whitespace-pre line
   instead of `ReactMarkdown`:
   ```tsx
   {streaming ? (
     <p className="whitespace-pre-wrap">{message.text}</p>
   ) : (
     <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{message.text}</ReactMarkdown>
   )}
   ```
   (Keep the existing `streaming && <span className="animate-pulse">▍</span>`
   cursor after the body. When the message completes, the `chat.idle`
   invalidate → refetch swaps in the persisted row and markdown renders once.)
3. Queued/tool rows are untouched.

**Verify**: `grep -n "memo" src/renderer/src/views/Chat.tsx` → present;
`pnpm typecheck` clean.

### Step 6: Auto-scroll without per-token smooth animations

Replace the effect at `Chat.tsx:138-140` with an instant scroll that does not
fight user scrolling. Only scroll when the user is already at the bottom
("stick to bottom" pattern):
```tsx
const scrollInfo = useRef({ stick: true })
// On delta/data updates:
useEffect(() => {
  if (scrollInfo.current.stick) bottomRef.current?.scrollIntoView({ block: 'end' })
}, [messages.data, streamingText])
```
To compute `stick`, the transcript's scroll container must be observed.
`ScrollArea` is a shadcn radix component — the scrollable viewport is its
child with `[data-slot=scroll-area-viewport]`; add one effect that attaches a
`scroll` listener to that node (query it from a `ref` on the wrapper div around
`<ScrollArea>`), setting
`stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80`. Detach on
unmount. If attaching the listener proves fiddly, the minimal acceptable
version is `scrollIntoView({ block: 'end' })` (instant, no `behavior`) on
every update — do that instead of inventing new UI.

**Verify**: `grep -n "behavior: 'smooth'" src/renderer/src/views/Chat.tsx` → no matches.

### Step 7: Manual verification (the real gate)

`pnpm dev`:
1. New chat → prompt "write a 300 line poem about monitors" (or any long-output
   prompt). Watch: text streams ~20 fps, no growing lag as the reply
   lengthens, no scroll fighting when you scroll up mid-stream (stick version)
   or at least no animation stutter (instant version).
2. Open a ticket cockpit with an active/recent work (`Jira` tab → a work, or
   `works` sidebar) → transcript streams identically and completion shows the
   finished message with markdown formatting (headings/lists render).
3. Open a review transcript chip during a review (or a past one) → completed
   rows render markdown; nothing regressed.
4. Interrupt mid-stream (stop button) → partial text remains visible after the
   post-idle refetch (flush before idle guarantees this).

**Verify**: all four behaviors observed; main-process console clean.

## Test plan

Repo policy: no automated tests (AGENTS.md). Step 7 is the verification.

## Done criteria

- [ ] `grep -rn "streaming = new Map" src/main/opencode/chats.ts` → no matches; `stream-buffer.ts` exists
- [ ] `grep -rn "buffer +=" src/renderer/src/views/` → no matches
- [ ] `grep -n "behavior: 'smooth'" src/renderer/src/views/Chat.tsx` → no matches
- [ ] `MessageRow` is `memo`-wrapped; streaming path renders `<p className="whitespace-pre-wrap">` (or equivalent) not `ReactMarkdown`
- [ ] `pnpm typecheck` exit 0, no errors; `pnpm build` exit 0
- [ ] Step 7 manual pass observed (state which variant of Step 6 was implemented)
- [ ] Only in-scope files modified; `plans/README.md` row updated

## STOP conditions

- Live code in any Current-state location differs from the excerpts.
- Work/review sessions turn out to **reuse one session id across messages in a
  round** in a way that mixes per-message accumulators (keying is
  sessionId:messageId, so it should not — if you see a real collision, report).
- The completion ordering (flush → idle) causes visible text loss in manual test 4.
- `PushEvent` typing forces a cast outside `stream-buffer.ts` (means the payload
  shape drifted — report instead of widening types).

## Maintenance notes

- Any new streaming surface (e.g. a fourth delta channel) adds a `DeltaKind` +
  one push call — it does not re-implement buffering.
- Reviewers: confirm `text` in all three delta channels is **accumulated** and
  the renderer never concatenates; a future "raw delta" optimization must
  change all three drives at once.
- Deferred: virtualized long transcripts (react-virtuoso) if sessions exceed
  ~500 rendered rows — not needed at current scale.
