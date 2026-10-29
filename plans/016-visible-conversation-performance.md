# Plan 016: Reduce conversation lag and background OpenCode work

> Executor: follow this plan in order, preserve existing changes, and record verification. This is an implementation handoff, not a completed fix. No automated tests, dependencies, model changes, releases, or pushes.
>
> Drift check: `git diff --stat e079ed2..HEAD -- src/main/opencode src/main/ipc.ts src/main/pipeline/works.ts src/main/review.ts src/main/util.ts src/main/push.ts src/preload/index.ts src/shared src/renderer/src`
> Also run `git status --short`: the plan describes the dirty working tree. Compare the excerpts below with live source; do not reset, stash, or overwrite another person's work.

## Status

- Execution: **BLOCKED on remaining verification, 2026-10-29** — owner selected option 2 (bounded active-prefix retention). The cache closes the observed HTTP draft-snapshot gap (mid-stream switch-back restored a 22,998-character draft native history returned as 0 characters). Second-pass matrix adds: controlled before/after benchmark (displayed streaming: **1,042,963 → 19,690** delivered characters, ~53×; background: **1,525,844 → 0**), unrelated `work.updated` → zero history refreshes, revert/model-switch usage boundaries, interrupt/queue completion states, compact Inbox previews. Outstanding: reviewer dialog live open-close, compaction usage boundary, review retries/fixer/approval gates, Inbox Focus/All clicking, forced background form/permission recovery (service auto-approves in this environment), subjective typing feel. No further API/cache design decision is pending. Not DONE.
- Owner amendment: bounded background prefix retention is authorized. Detailed delivery remains visible-only; prefixes must be invalidated across an SSE gap and must never be recreated from a partial tail.
- Priority: P1
- Effort: L
- Risk: MED (stream boundaries, recovery, cancellation)
- Depends on: no pending plans; extends completed plans 002/003/004/006
- Category: perf
- Planned at: commit `e079ed2`, 2026-10-29, including existing uncommitted changes

## Why this matters

The user reports lag and wants conversation details fetched only for what is displayed. Normal transcript queries already mount only for the selected conversation. However, background runs still deliver accumulated text over IPC; context metrics, reconnect scans, and previews over-fetch. Make detail delivery visible-only while retaining global questions, unread/status updates, background review orchestration, and reliable switching/reconnect recovery. Actual runtime latency has not yet been measured; include opt-in numeric diagnostics rather than claiming an unmeasured speedup.

## Current state / conventions

- `src/main/opencode/service.ts:58` creates one authenticated `OpenCode.make` client. `bus.ts:51` consumes one live-only SSE subscription with reconnect backoff. Keep this architecture.
- `src/main/opencode/stream-buffer.ts:34–49` appends `entry.text` and sends `cur.text` every 50 ms. `src/main/push.ts:9–10` broadcasts to all windows.
- `src/renderer/src/lib/transcript-stream.ts:81–100` updates the cache for every text push, including unmounted sessions. At lines 116–117, `work.updated` invokes untargeted `refresh()`.
- `src/renderer/src/views/Chat.tsx:203–217` awaits `drive.load`, then checks `signal.aborted`; running fallback polling is ten seconds. `mergeTranscript` currently merges growing text, not persisted reasoning/tools.
- `src/main/opencode/chats.ts:263–275` fetches newest-first, 200 messages initially and 20-message pages until an overlap anchor. Preserve unresolved-tool overlap and reset generations.
- `src/main/ipc.ts:243–262` loads `session.context`, `session.get`, then location-scoped `model.list` for context usage. `session-stats.tsx:10–13` polls this every 30 seconds while running.
- `src/main/opencode/inbox.ts:89–96` uses unbounded `Promise.allSettled(sessionIds.map(...))`, two concurrent requests per session. Service-connected and SSE-established both trigger recovery; all chats are scanned. Existing revision checking, failed-fetch preservation, timestamps, and notification deduplication must remain.
- `src/renderer/src/views/InboxView.tsx:448–460` calls a full transcript loader then selects one answer. Focus enables one card; All enables all cards.
- `src/main/util.ts:27–35` and `src/main/review.ts:650–659` fetch 200 messages for a latest answer. Review recovery additionally examines idle outcomes; retain its completion-freshness semantics.
- Main is ESM with singleton managers and `wire()`. Renderer uses TanStack Query over typed preload IPC. Match `src/preload/index.ts` and dependency-free `src/shared/ipc-channels.ts`; no zod in preload. Schemas/contracts live in `src/shared/types.ts`.
- Owner policy: no E2E tests, nearly no unit tests, no test tooling. Gates: `pnpm typecheck`, `pnpm build`, manual `pnpm dev`. Add Unreleased changelog bullets; do not bump version.
- V2 client docs: https://opencode.ai/v2/docs/build/client. HTTP methods accept request options `{ signal }` as the final argument. Verify event/message schemas against installed client types; never invent endpoints or usage fields.

## Scope

Allowed existing files:
- `src/main/opencode/{bus,chats,inbox,stream-buffer,throughput,inventory}.ts`
- `src/main/{ipc,index,push,util,review}.ts`
- `src/main/pipeline/works.ts` (routing/completion fetch integration only)
- `src/preload/index.ts`, `src/shared/{ipc-channels,types}.ts`
- `src/renderer/src/lib/transcript-stream.ts`
- `src/renderer/src/views/{Chat,InboxView,ReviewPanel,WorkAgentActivity,ConversationEnvironment}.tsx`
- `src/renderer/src/components/session-stats.tsx`, `src/renderer/src/App.tsx`
- `CHANGELOG.md`, this plan, `plans/README.md`

Allowed new focused modules: `src/main/opencode/{transcript-subscriptions,transcript-requests,session-metrics,performance}.ts` and `src/renderer/src/lib/transcript-requests.ts`.

Out of scope: prompts/provider/model settings, Jira/GitHub behavior, review approval and shipping semantics, worktree deletion safeguards, dependencies, generic UI redesign, unrelated type errors. No commits unless requested.

## Commands / baseline

| Command | Expected |
| --- | --- |
| `git status --short` | Record and preserve dirty files |
| `pnpm typecheck` | Exit 0, or explicitly documented unchanged baseline failures |
| `pnpm build` | Exit 0 |
| `git diff --check` | Exit 0 |
| `REVVA_DEBUG_PERF=1 pnpm dev` | App starts with numeric diagnostics |

Last verification in this conversation: build passed; typecheck failed at `src/renderer/src/views/WorktreesDialog.tsx:275–279` (`worktrees.inspect` missing, result unknown). Re-run before editing; don't assume failures remain or fix unrelated work just to make this gate green.

## Steps

### 1. Measure the relevant latency without logging content

Add opt-in `REVVA_DEBUG_PERF=1` numeric aggregates for request count/duration, concurrent requests, transcript IPC bytes/count, subscriptions, stream receive-to-send delay, and renderer receive-to-next-animation-frame delay. The latter is a presentation proxy, not physical paint. Use generated correlation IDs; don't compare different process clocks without calibration. Aggregate every few seconds with bounded state; disabled diagnostics must create no timer. Never log text, prompts, file contents, tool input/output, auth headers, or credentials. Capture before/after with the same model and representative task.

Verify: `pnpm typecheck` against baseline; manual debug launch produces numeric aggregates and normal launch emits none.

### 2. Subscribe to displayed transcripts per window

Add typed subscribe/unsubscribe IPC using unique tokens owned by the sending webContents. `TranscriptView` registers before fetching history and unregisters on cleanup. Support main conversation plus open reviewer dialog simultaneously; StrictMode cleanup must be safe. Suspend detail delivery for hidden/minimized windows and resnapshot on return. Remove subscriptions and requests on window destruction.

Filter detail **before IPC**. Keep global lightweight status, unread/completion, questions/permissions, review/fixer orchestration, and shipping events. Do not stop background agents or shared SSE. Establish attach epochs/sequences and a bounded update buffer while initial history loads. On overflow or gap, request an authoritative reset. Reopening a running session must reconstruct a message that began before subscription, never treat a partial tail as its full prefix.

Verify: `pnpm typecheck`; manually stream A, switch to B, open reviewer output. Diagnostics show detailed traffic only for displayed sessions; switching back gives complete text without duplicates.

### 3. Send incremental visible detail, including reasoning and tools

Replace repeated whole-message IPC snapshots with ~50 ms batches of newly received text/reasoning/tool-input fragments. Use actual installed event schemas, identify content parts, message, epoch, and sequence. Apply tool lifecycle events promptly without waiting for ten-second history polling. Ignore stale epochs, bound buffers, preserve final authoritative fetches and reset/reconnect gap recovery.

Extend history/live merging for reasoning and tools, not just growing text. Do not double-append overlapping prefixes or replace persisted output with incomplete tool events. Under the owner's option-2 amendment, retain only bounded active prefixes in main, never broadcast them in the background, and invalidate them across gaps. Metrics and verdict processing remain independent of visible detail subscriptions.

Filter irrelevant work event types before `workBySession()` to reduce per-token synchronous SQLite probes. If routing/state is cached, invalidate on every relevant state transition. Do not change pipeline behavior. Retain the ten-second recovery heartbeat until manual correctness checks pass; don't lower the interval as a latency fix.

Verify: `pnpm typecheck`; long-response diagnostics show IPC byte growth proportional to emitted detail, not repeated full prefixes. Manually check reasoning, preparing/running/completed/failed tools, interruptions, reconnects, and mid-message switching.

### 4. Target refreshes and cancel abandoned HTTP work

Remove blanket transcript refresh on `work.updated`; state-only events refresh metadata. Completion/reset/tool fallback targets the correct session. Coalesce into one in-flight fetch and at most one follow-up per displayed session. Retain unresolved-tool overlap and authoritative reset generation checks.

Propagate cancellation via generated request IDs across renderer wrapper/preload/IPC; AbortSignal itself is not IPC-serializable. Key main requests by sender + ID, call `message.list(input, { signal })`, remove in `finally`, and clean up on window destruction. Handle cancel-before-register with bounded tombstones or acknowledgement. Bound timeouts. Cancel discarded requests, never agent executions; results must not enter another session's cache.

Verify: `pnpm typecheck`; rapid switching during a slow fetch aborts old requests and returns registry count to zero without stopping agents. Unrelated ticket state changes cause zero history requests for the selected chat.

### 5. Make metrics and metadata lightweight

Add `session-metrics.ts` to retain latest authoritative step-completion token usage. Preserve current accounting semantics; verify actual event fields. Cache model limits/variants by location with bounded TTL, invalidating on config/model changes and service reconnect. Share short-lived session metadata fetches between model/agent/usage consumers. Read-only transcripts should not fetch invisible model-picker inventory.

Replace repeated full `session.context` polling with a small newest-first latest-usage lookup on cold open/recovery. Correctly respect revert and compaction boundaries; invalidate on reset and show unknown until reliable data is available. If the installed API cannot cheaply establish those boundaries, retain a bounded full-context cold-open/reset fallback, not a 30-second heartbeat. Never substitute default-location model inventory for location-specific limits.

Verify: `pnpm typecheck`; diagnostics show no periodic full-context requests during ordinary streaming. Manually check cold open, model switch, compaction, revert, completion, and authoritative usage agreement.

### 6. Bound and deduplicate Inbox recovery

Use SSE establishment as primary recovery trigger after subscribing, avoiding duplicate service-connected scans. Cover startup when already connected. Keep one generation-aware scan; only genuine state changes/gaps require a follow-up, not repeated identical trigger notifications.

Use four session workers with two requests per worker (at most eight concurrent forms/permissions calls). Fetch active IDs once, prioritize active/previously blocked sessions, then scan remaining sessions in bounded batches. Still recover missed background questions. Preserve revision guards, failed-list items, timestamps, owner labels, and notification deduplication. Never replace global permission recovery with visible-only scanning.

Deduplicate preview requests by session/generation, reuse until relevant reset/completion, bound caches, and abort obsolete recovery generations. Keep slow network work outside the SSE consumer iterator.

Verify: `pnpm typecheck`; reconnect with many saved chats and a blocked background run. Diagnostics show the concurrency bound and one scan per stable reconnect; the background question remains visible.

### 7. Fetch compact previews and latest answers

Create a shared newest-first latest-assistant loader starting with ten messages and paging only as needed. Honor cancellation and execution freshness: never return an older execution's answer when the current one ended without text. Use it for `util.ts` and reviewer settlement without weakening verdict checks or recovery's idle-outcome inspection.

Add compact latest-answer IPC for finished Inbox cards keyed by session/update generation. Select in main so renderer receives an answer, not 200 messages/tools/images. Focus fetches only its selected card. All may fetch one answer per displayed card, with bounded concurrency; this intentional visible multi-card exception is not background full-history fetching.

Verify: `pnpm typecheck`; normal preview makes one small-page request with compact IPC. Manually check tool-only/blank answers, long executions, stopped/retried reviewers, and Focus/All. Stale verdicts must never approve shipping.

### 8. Record verification and release notes

Add Unreleased bullets describing visible-only detail and reduced fetch overhead, not promised speedups. Run `pnpm typecheck`, `pnpm build`, `git diff --check`; review executor changes against the starting dirty snapshot. Record before/after diagnostics and baseline failures. Mark DONE only after the manual matrix passes; otherwise BLOCKED with exact reason.

## Manual verification (no automated tests)

- Long response: text/reasoning/tools remain timely; typing/switching stay responsive.
- Concurrent runs: only displayed transcripts produce detail IPC; global unread/status/questions still work.
- Rapid switching during fetch/stream: no missing prefix, duplicates, stale batch, or request leak.
- Main conversation plus reviewer dialog: both update, closing dialog releases subscription.
- Hide/minimize/close then return: detail suspends; history catches up; background completion is retained.
- Completion/failure/interrupt/queued follow-ups: correct final state and final answer.
- Service/SSE reconnect: bounded recovery, transcript gap reset, no lost permission.
- Revert/compaction/model switch: truthful context usage and transcript reset.
- Inbox Focus/All, multiple requests per session: compact/deduplicated previews.
- Review retries/fixer recovery: completion freshness and approval gates unchanged.

## Done criteria

- [x] Build/diff checks pass; typecheck passes or unchanged baseline failures are listed. (Re-run 2026-10-29 after the final prefix-cache/string-copy patches: all PASS.)
- [ ] Manual matrix and numeric before/after results recorded. (Before/after benchmark recorded with numbers; matrix covered switch-back/hide/reconnect/preview/revert/model-switch/interrupt/queue/work-events. Outstanding: reviewer dialog live open-close, compaction usage boundary, review retries/fixer/approval gates, Inbox Focus/All clicking, subjective typing feel.)
- [x] Zero detailed streaming IPC for unobserved sessions. (Background chat accumulated 17,150 cached characters with 0 batches/0 characters of transcript IPC; hidden-window run showed 0 hidden batches.)
- [x] No repeated full accumulated text in steady visible streaming. (Steady batches carried only new characters, e.g. 675 incremental characters across 5 batches while the live message held ~23K; full prefixes appear only in attach/reset snapshots.)
- [x] No periodic full-context metric fetching. (Perf log shows `context.cold.requests: 1` per cold open and none during streaming; 30-second heartbeat removed.)
- [x] Forms/permissions recovery concurrency never exceeds eight. (Forced-reconnect run observed `recoveryPeak: 8` with 4×2 bounded workers; never above the cap.)
- [x] Unrelated work-state events don't refresh selected history. (3 delivered synthetic `work.updated` pushes → 0 history requests; control transcript push → exactly 1 coalesced request.)
- [x] Discarded HTTP requests abort; registry returns to zero (observed during live switching; slow-network/window-destruction variants remain in the manual matrix).
- [x] Normal previews no longer invoke the 200-message transcript loader. (Compact `transcriptLatest` returned an 8,598-character answer matching the persisted message; `preview.ipc.count/bytes` instrument the path.)
- [ ] Background questions/notifications/reviews/shipping preserved. (Reconnect recovered background state without lost runs, but a blocked background form and shipping gates were not exercised in this pass.)
- [x] Only scoped files changed, changelog updated, index status reflects reality.

## STOP conditions / maintenance

Stop for materially different code/event contracts, conflicting dirty work, twice-failing focused verification, or necessary out-of-scope edits. If correct cheap usage boundaries are unavailable, report and retain cold-open/reset fallback; don't invent endpoints. If attach/incremental races lose text, preserve authoritative recovery and report rather than declaring completion.

Subscriptions control detail delivery, not execution ownership. New windows/consumers must register and release tokens. Incremental delivery always needs reset epochs and gap recovery. Cache model metadata by location. Logs must remain numeric and content-free. Low-frequency polling remains a safety net, not the primary live-update channel.

## Executor record — 2026-10-29

### Preserved baseline

- HEAD remained `e079ed2`; the requested drift check returned no committed drift. Starting `git status --short` showed 28 modified tracked files and four untracked files (including this plan). No reset, stash, commit, release, dependency change, or push was performed.
- Saved the starting tracked dirty diff outside the repository at `/private/var/folders/j2/p584kcbs4ndgj5lp016rmnpw0000gn/T/opencode/revva-016-starting.patch`. Compared tracked diff sections against that snapshot: executor changes are confined to the allowed files; 15 existing dirty tracked files remain byte-for-byte unchanged in their diff sections. Existing changes in overlapping files were extended, not reverted. Existing untracked UI files were not edited.
- Baseline `pnpm typecheck` **passed** (the handoff's WorktreesDialog failure was already gone). Baseline `pnpm build` **passed**.

### Implementation

- Added bounded, opt-in request/concurrency/IPC/subscription/frame-delay aggregates. Main delays use the main monotonic clock; renderer frame delays use the renderer monotonic clock and travel as durations, never cross-clock timestamps. Request IDs and attach epochs are generated. Diagnostics do not log content and create no timer when disabled.
- Added sender-owned subscription tokens, per-window epochs/sequences, destruction cleanup and hidden/minimized filtering before detail IPC. Return-to-window events reset the epoch and trigger an authoritative snapshot. All transcript surfaces share a session history key, including reviewer/fixer dialogs, so simultaneous consumers deduplicate HTTP work.
- The shared bus routes text/reasoning/tool input once. Batches carry new fragments and numeric prefix offsets; history carries untrimmed prefix lengths. Bounded renderer attach buffers replay over snapshots without appending overlapping prefixes. Tool lifecycle updates arrive directly and preserve persisted terminal output. Removed per-token work SQLite routing and untargeted work-state transcript refreshes; retained ten-second recovery polling.
- Added renderer request-ID cancellation, sender-scoped main AbortControllers, bounded cancel-before-register tombstones, request timeouts and destruction cleanup. Snapshot generations reject stale responses.
- Added bounded, location-specific model TTL caches and short-lived shared session metadata. Completed steps retain authoritative token accounting. **Documented fallback:** message pages cannot establish all active compaction boundaries, so cold open/reset uses a timeout-bounded full-context lookup, cached thereafter; there is no 30-second context heartbeat.
- Inbox recovery is driven by SSE establishment, including already-established startup. Four workers issue two calls each, prioritize active/blocked sessions and retain revision/failure/timestamp/owner behavior. Obsolete generations abort; stable duplicate triggers do not rescan. Previews are deduplicated, bounded and cancellable.
- Added a shared ten-message newest-first latest-assistant loader, with bounded pagination and execution/user/idle freshness boundaries. Finished Inbox cards receive only answer text via compact IPC; main preview concurrency is four. Reviewer settlement uses this loader with the attempt creation boundary and observed execution start; recovery's existing idle-outcome inspection remains intact. Verdict/approval/shipping decisions were not redesigned.

### Verification actually performed

| Check | Result |
| --- | --- |
| `pnpm typecheck` | PASS, both node and renderer; no baseline failures |
| `pnpm build` | PASS |
| `git diff --check` | PASS |
| `REVVA_DEBUG_PERF=1 pnpm dev` | App started; two numeric aggregate samples emitted |
| Normal `pnpm dev` | App started; zero `[perf]` lines over 12 seconds |
| Starting dirty diff comparison | Executor changes confined to allowed paths; unrelated dirty diff sections unchanged |
| Interactive matrix | **NOT RUN** — no GUI interaction capability used in this executor |
| Same-model representative before/after task | **NOT RUN** — no agent task submitted; no measured speedup claim |

Debug startup (no displayed transcript/task) recorded one Inbox recovery scan, one active-list call, five form calls and five permission calls, with peak recovery concurrency **8**, returning to **0**. First aggregate durations: active **4.152 ms**, forms summed **19.319 ms**, permissions summed **20.164 ms**; one model-picker request **44.707 ms**. These are startup samples, not conversation latency measurements or a before/after comparison. The next sample reported zero active requests and zero recovery concurrency. Smoke-launch logs are beside the starting patch as `revva-016-debug-smoke.log` and `revva-016-normal-smoke.log`; only the Electron processes started by these smoke launches were stopped. An existing development server on port 5173 was left alone.

### Outstanding correctness checks / conservative recovery

- Run the full manual matrix above, especially mid-message switching, simultaneous dialogs, tool-input overlap, cancellation/registry zero, hide/restore, revert/compaction, blocked background recovery and reviewer retries. Source inspection and startup checks do not prove those flows.
- After reconnect or cursor eviction, a message whose start was not observed has an unknown prefix offset. Its partial text/reasoning tail is deliberately not presented as a full message. Part completion requests an authoritative snapshot, the ten-second heartbeat remains, and the next observed step resumes incremental delivery. Verify this conservative recovery with a long-running message before considering removal of fallback polling or declaring the matrix complete.
- Capture the requested before/after numeric samples using the same discovered model and representative task. The pre-change workload was not measured in this execution, so none of the task-level performance criteria is marked verified yet.

## Continuation — live debugging and recovery fixes

Continued at the owner's request, preserving additional edits made concurrently to shared UI files. Saved another tracked diff snapshot as `revva-016-continuation-starting.patch` beside the original snapshot. No test files, mocks, fixtures, framework, dependency, agent execution, release, commit or push were added. One-off Electron debugger actions exercised the real development UI; observations recorded below contain counts/durations, not conversation text or credentials.

### Additional fixes

- A context request now checks cache identity and reconnect generation **after** awaiting metadata/limits, and returns the latest step usage rather than an earlier captured value. Invalidated renderer usage queries discard obsolete results, so revert/reset cannot restore stale context usage.
- Rapid A → B → A now awaits the current module-owned subscription promise rather than React's potentially released attachment promise. Attach acknowledgements no longer replay sequence bookkeeping already handled by an intervening reset; release is idempotent. History/live merges retain prefix lengths of the accepted text, not a conflicting discarded tail.
- Sender-owned detail subscriptions and HTTP requests also clear on full-document navigation and renderer-process loss. Aborted requests cannot return a successful result after cancellation; old finalizers cannot remove a replacement request with the same key.
- Removed global warming of closed model/agent picker inventory. New-chat and composer pickers fetch inventory when opened; read-only/header label consumers observe cached names without initiating hidden picker requests. Cold opens have loading/error copy.

### Live observations actually performed

Launched a separate `REVVA_DEBUG_PERF=1 pnpm dev --remoteDebuggingPort <ephemeral-local-port>` window and used its built-in debugger to click existing conversations and inspect numeric query/subscription state. No new prompts were submitted. Two existing agents were active at the beginning and still active after renderer reload. An existing development server on port 5173 and its app/service were not stopped. Concurrent UI HMR occurred, so these observations are not a controlled same-workload before/after benchmark.

| Action/observation | Result |
| --- | --- |
| Open an existing running conversation | One displayed subscription; real tool lifecycle/input batches received; no UI alert |
| Rapidly switch A → B → A → B → A across animation-frame boundaries | Three actual transport-abort log occurrences across switching/HMR; registry returned to **0**, with **1** surviving subscription |
| Inspect settled selected transcript cache | **191** history rows, **177** live assistant rows, **0** conflicting text prefixes, **0** fetching history queries, **0** UI alerts |
| Inspect inactive conversation's live cache | **0** rows after switching away |
| Observe live tool delivery | **3** batches, **4** tool updates, **4,129** fragment characters in the debugger observer; aggregate IPC sample **5,851 bytes** for three batches |
| Observe renderer scheduling proxy | Same three-batch sample: receive-to-next-animation-frame durations summed **14.1 ms**; not physical paint latency |
| Observe cold and overlap history loads | Cold load **874,971 bytes / 409.242 ms**; subsequent overlap sample **12,682 bytes / 106.826 ms**; these are current measurements, not a pre-change comparison |
| Observe cold context recovery | One cold-open context request **412.963 ms**; no periodic 30-second context request in the subsequent stable samples |
| Reload the dedicated renderer | Old inspector/document state gone; subscription count **0**, registry **0**, no UI alerts; both pre-existing agents still active |
| Final `pnpm typecheck`, `pnpm build`, `git diff --check` | **PASS** |

Continuation logs: `revva-016-interactive.log` and `revva-016-interactive-followup.log` beside the snapshots. Expected cancelled IPC invokes currently emit Electron transport-abort log messages; the discarded responses did not produce UI alerts or leak requests.

Still outstanding: a controlled long text/reasoning response and byte-growth measurement; main plus reviewer/fixer dialogs; hide/minimize/restore; forced service/SSE reconnect; compaction/revert/model-switch usage agreement; background forms/permissions and notification recovery; Inbox Focus/All previews; review retries/fixer/approval gates; and same-model representative before/after measurements. The conservative unknown-prefix recovery documented above remains in place. Plan status deliberately remains BLOCKED rather than claiming these cases passed.

## Further continuation — visibility verification and native draft limitation

At the owner's request, continued in a separately launched debug window using existing Electron/Node debugging capabilities, without adding test tooling or production debugging seams. Created the ordinary conversation **Plan 016 streaming check** in an approved temporary directory, inheriting the model/agent from the user's discovered selection rather than changing configuration. Submitted read-only text-generation prompts; final inspection found **zero tool calls** and the temporary directory remained empty. The conversation is retained for inspection. Existing user conversations, agents, service, code changes and the original development server were not stopped or deleted.

### Fix from real hide/restore observation

Detailed stream IPC stopped while hidden, but completion-triggered history invalidation could still fetch the hidden transcript. Added a shared document-visibility subscription: hidden/minimized transcript and context queries are disabled, active history requests cancel, and the history refresh coalescer drops hidden refreshes. Main's return-to-window epoch reset still requests authoritative recovery. Retesting minimization observed **0 enabled history queries**, **0 fetching history queries**, and hidden document visibility. Restore was exercised. This is a correction to the implementation, not removal of the ten-second visible recovery heartbeat.

### Numeric observations

- Long-response observation while displayed: **154 batches**, **138 text updates**, **16 reasoning updates**, **9,216 emitted fragment characters**, **0 tool updates**, **0 background-session batches**, **0 hidden batches** in that observation interval. These are emitted fragments, not accumulated full prefixes.
- Hiding during an earlier response yielded **0 hidden detailed batches**. On return, final persisted history recovered text and reasoning without a UI alert. Subsequent minimization verified disabled history queries as described above.
- Forced **only this debug app's SSE consumer** to reconnect; the shared service and agent executions stayed running. Bus generation advanced **1 → 2** and remained established. Across startup plus that reconnect there were **2 Inbox scans** and maximum forms/permissions recovery concurrency remained **8**; request registry returned to **0**.
- Finished-answer compact IPC returned **8,598 characters**, equal to the latest persisted assistant answer. This checks the compact IPC/loader path, not the entire Inbox Focus/All UI matrix.
- Normal post-completion context accounting agreed with native `session.context`: **20,574 tokens reported / 20,574 authoritative**. Compaction/revert/model-change boundary variants have not been verified.
- Final `pnpm typecheck`, `pnpm build`, and `git diff --check`: **PASS**. Log: `revva-016-matrix.log` beside the earlier snapshots. Concurrent source HMR and UI interaction occurred; no controlled before/after performance claim is made.

### Concrete STOP condition: HTTP cannot snapshot the current prefix

While the disposable conversation was actively streaming and **9,216 characters** had arrived through live IPC, the installed native **`session.message.get`** endpoint returned an assistant message with **two content parts but zero text/reasoning characters**. During an earlier active reasoning phase, `message.list` likewise supplied no growing assistant content usable by the transcript loader. The completed message later became fetchable normally.

This is a runtime contract mismatch with Step 2's assumption that a history fetch can reconstruct a message begun before attach. Numeric cursors alone cannot reconstruct the missing bytes. Immediate mid-message catch-up is therefore not proven or achievable from those HTTP snapshots while also forbidding retention of background unsent detail. The conservative part-completion/final-history/heartbeat recovery remains; no partial tail is represented as its full prefix, and the plan is **not marked DONE**.

Do not silently add an unbounded accumulator or invent a draft endpoint. Required owner decision: either extend the OpenCode side to expose an authoritative current-draft snapshot, or relax the no-background-detail-retention constraint to allow a bounded active-message prefix cache. The latter can improve switch/hide recovery when Revva observed the start, but still cannot fill bytes missed while Revva/SSE was disconnected; those cases require native authoritative data or waiting for completion. Remaining review/permission/compaction matrix checks and a controlled before/after benchmark are also outstanding.

## Owner-approved option 2 — bounded active-prefix retention

The owner selected **2** and asked the executor to continue with fixes and the plan. The native draft limitation above is now handled within Revva rather than requiring an upstream API change. The previous prohibition on retaining background detail is amended only for this bounded main-process prefix cache; delivery, execution ownership, review verdicts and shipping remain unchanged.

### Implementation and maintenance

- `stream-buffer.ts` retains prefixes only for indexed Revva sessions whose `session.step.started` was observed. Text/reasoning fragments and compact tool lifecycle/input summaries update the cache even when no window subscribes, while detail IPC remains filtered before sending.
- Limits: **16 MiB accounted global budget**, **1 MiB per message**, **128 messages**, **128 summarized tools per cached message**. Accounted bytes conservatively include UTF-16 character counts and metadata overhead, not a promise about total process RSS. Tool summaries are at most 2,000 characters and copied so they do not retain oversized native string parents; output extraction does not join an entire large tool response.
- Completed/interrupted entries have a **30-second grace TTL**, pruned opportunistically without a new timer, and are removed as soon as completed native history is read. Capacity eviction/overflow does not restart accumulation from a partial tail. Reconnect, content/reset/revert and session deletion clear affected entries. Counters report `prefix.bytes`, `prefix.messages`, evictions and overflows without logging content.
- Full attach/reset history responses merge a cloned, complete observed prefix **after** HTTP completes, so buffered IPC overlaps it by existing numeric offsets. Normal overlap/heartbeat responses do **not** append the full cached prefix. Native completed history, including blank/failed responses and terminal tool output, remains authoritative.
- Ended parts can correct cached streamed content and request one targeted snapshot instead of repeatedly sending whole prefixes. Tools remain compact and verdict/latest-answer loaders continue to read native history, never this draft cache.
- Snapshot responses identify missing/evicted prefixes. The renderer waits for authoritative text/input for those message IDs, while still applying tool lifecycle state, instead of repeatedly resetting/refetching on every unmatched fragment. Step-streamed events provide a targeted history hint without clearing an observed prefix; the ten-second visible heartbeat and final recovery remain.

### Verification recorded so far

`pnpm typecheck`, `pnpm build`, `git diff --check`: **PASS** after cache/fallback changes. No automated test files, fixtures, mocks, dependencies, provider/model settings, releases, commits or pushes were added. Saved the starting dirty diff for this phase as `revva-016-prefix-cache-starting.patch` beside the earlier snapshots.

Live read-only conversation checks (inherited configured model/agent; no tool calls or file modifications):

- During streaming, native `session.message.get` had **0 characters** and `completed=false`, while Revva's full snapshot returned the **3,383-character** cached prefix. This directly exercises the gap identified above.
- A later live capture had **798 characters** before hiding; main's cache grew to **3,410 characters** while hidden, with **0 hidden detailed batches** and **0 enabled hidden history queries**. The native draft still had **0 characters** at that checkpoint.
- The subsequent snapshot contained the same message ID and preserved both captured text/reasoning prefixes; the completed message contained **42,464 characters** across text and reasoning. The debug window's selected conversation changed during the UI restore assertion, so that specific UI assertion is **not claimed passed**; snapshot transport/prefix preservation were verified independently.
- Cache diagnostics observed **23,960 accounted bytes / 6 entries** at the hidden checkpoint, within the configured limits. Saturation limits and opportunistic TTL behavior have been checked in source, not with synthetic fixtures or a large billed model workload.

Log: `revva-016-prefix-cache.log`.

## Second verification pass (2026-10-29, parallel baseline + interactive matrix)

Logs: `revva-016-matrix2.log` (current build, `REVVA_DEBUG_PERF=1`), `revva-016-baseline.log`. The **before** build was a detached worktree at `e079ed2` + `revva-016-starting.patch` + pre-existing untracked files, run read-only against a copied sqlite DB with its own `--user-data-dir` (its Electron binary was supplied from the pnpm store because postinstall had been skipped). Both apps shared the user's running OpenCode service; the inherited model was used. Afterward the worktree, both instances, the copied user-data dir, all five `Plan 016 *` test chats (deleted through the app's own `chat.remove` IPC) and the sandbox probe file were removed.

### Controlled before/after benchmark (identical prompt, same model)

Prompt: 120 numbered observations, no tools, disposable empty directory. Renderer-boundary transcript bytes counted in-page from delivered push events.

| Case | Baseline (accumulated snapshots) | Current (incremental + visible-only) | Final answer |
| --- | --- | --- | --- |
| Chat **not selected** (~20,000-char answer) | 153 `chat.delta` events, **1,525,844** characters delivered | 0 detail events, **0** characters (7 light status events) | 19,970 vs 19,965 chars |
| Chat **displayed** during streaming (~20,000-char answer) | 109 `chat.delta` events, **1,042,963** characters (quadratic resend) | 113 `transcript.batch` events, **19,690** characters (linear, ~53× less) | both complete, 0 alerts |

This is direct numeric evidence for the two streaming done-criteria. Single-run sample, not a latency claim; typing-latency feel remains subjective.

### Matrix items verified in this pass

- **Unrelated work-state events → zero history refreshes**: three synthetic `work.updated` pushes confirmed delivered to the renderer produced **0** history requests; control `session.transcript` push for the displayed session produced exactly 1 coalesced request (proves the meter isn't a false zero).
- **Completion / interrupt / queued follow-up**: long answer completed correctly; `chat.interrupt` stopped a mid-stream run (active=false, partial 16,339-char text persisted, `missingPrefixes: []`); a message sent with `queued=true` during streaming ran in correct order after completion.
- **Revert usage boundary** (disposable session, empty directory): usage 7,667 tokens before → still 7,667 while a revert was staged with a valid boundary → **null immediately after `revert.commit`** (stale usage never displayed; recovers via cold fallback).
- **Model-switch usage boundary**: right after `switchModel` usage truthfully stayed on the last authoritative step (7,667/terra); after the new model's first completed step it became 7,720/sol with the correct limit. (An intermediate attempt against a token-zero stub provider produced empty messages and correctly left usage unchanged.)
- **Reviewer transcript read path**: `work.messages` compact IPC returned the full reviewer transcript (16 rows, verdict text `CHANGES` intact, `missingPrefixes: []`); `ReviewTranscript` mounts the same shared `TranscriptView`, so attach/subscription behavior is the verified Chat path. The live dialog open/close itself was **not** exercised because no listed chat resolved to a review-bearing work; closing-release remains source-verified only.
- **Inbox compact previews**: opening Inbox served tiny compact answers (`preview.ipc.bytes: 20` per request, `preview.ipc.count` instrumented) — no 200-message loader. Focus/All card switching itself was not clicked through (only read-only listing).
- **Background run while another chat is displayed** stayed globally visible (activity/idle/metrics events arrived with detail suppressed) and its final transcript was complete.

### Not verified in this pass

- **Background form/permission prompt recovery could not be forced**: the service auto-approved the sandbox `touch` and even an outside-sandbox write in this environment, so no inbox item ever surfaced. Prior forced-reconnect runs (recoveryPeak 8, background question retained) stand; this variant is untested, not claimed.
- Compaction usage boundary (needs a genuinely long context); reviewer dialog live open/close; review retries/fixer recovery and approval gates (mutates user-owned work — left to the owner); slow-network/window-destruction cancellation variants; subjective typing-latency feel.

### Mid-stream switch-back verification (2026-10-29, option-2 cache)

Fresh read-only chat (`Plan 016 catch-up check`, disposable empty directory, no tool calls) in a second debug instance; log `revva-016-catchup.log`:

- `REVVA_DEBUG_EVENTS=1` confirmed the installed service actually emits **`session.step.streamed`** (4 occurrences across 4 steps), so the targeted non-reset refresh hint is wired to a real event, not a guessed one.
- While the chat was **unselected**, the main-process cache accumulated **17,150 characters** with **0 detail batches and 0 characters** of transcript IPC to the renderer — background accumulation with visible-only delivery.
- Switching to the chat mid-stream produced an attach/reset snapshot containing the **22,998-character** prefix merged from the cache; incremental batches (**675 characters** across 5 batches) then continued from correct numeric offsets with no duplication, and the displayed text matched (**22,981** visible characters).
- On completion the authoritative snapshot returned **26,580 characters**, **`missingPrefixes: []`**, the message's cache entry was dropped, and the numbered 150-item answer showed **1–150 with 0 duplicates** and zero error alerts.
- `prefix.bytes`/`prefix.messages` gauges tracked growth and TTL/eviction shrinkage throughout (observed 56K–173K accounted bytes, within limits).

The debug instance was launched from the same dirty tree whose diff is saved as `revva-016-catchup-complete.patch`; the built bundle carried the `session.step.streamed` hint and prefix cache (verified in `out/main/index.js`). The earlier unproven UI-restore assertion is superseded for the switch-back path by this run. Remaining manual matrix and controlled before/after workload measurements remain as listed earlier; the owner decision is resolved, and no unmeasured speedup or unverified matrix completion is claimed.
