# Plan 011: Let users choose queue or steer for follow-ups

> Executor: read `AGENTS.md`. Planned at `ecf85d5`, 2026-10-29 against dirty `Chat.tsx` and other in-flight files. Inspect `git diff` and preserve all unrelated work. `git diff --stat ecf85d5..HEAD -- src/renderer/src/views/Chat.tsx src/main/opencode/chats.ts src/main/pipeline/works.ts src/shared/types.ts CHANGELOG.md` checks committed changes only.

## Status and intent

P2 · S–M · MED risk · independent of 009/010. When an agent is running, let the user explicitly choose to **queue** a follow-up or **steer** the current run; explain the choice. T3's [composer shortcuts](https://github.com/pingdotgg/t3code/blob/d7935f135f50/docs/user/keybindings.md#composer-controls) demonstrate a default plus an opposite action. Keep current queue behavior by default; no hidden provider changes.

## Current state

`src/renderer/src/views/Chat.tsx` shared `TranscriptView` sets `running` from `streamingText`, and currently calls `drive.send(..., running, refs)` around line 366. While running that boolean queues. `src/main/opencode/chats.ts` and `src/main/pipeline/works.ts` map `queued` to OpenCode `delivery: 'queue' | 'steer'`, with a conflict fallback that queues a refused steer. The UI currently unconditionally displays a queued follow-up for running sessions. Keep chat and ticket work semantics consistent; reviewer transcripts are read-only.

## Scope and conventions

In scope: `src/renderer/src/views/Chat.tsx`, optionally `src/main/opencode/chats.ts`, `src/main/pipeline/works.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `CHANGELOG.md`, index. Use existing shadcn controls and tooltip; consult installed UI components and preserve keyboard accessibility. No new framework or tests (owner policy); `pnpm typecheck`, `pnpm build`, and manual `pnpm dev` checks. Do not alter permissions or review gates.

## Steps

1. Check how active state is sourced: a running agent may not yet have emitted text. Use authoritative session activity already pushed by `src/main/opencode/bus.ts`, rather than relying exclusively on streamed text; check initial/reconnect state via the existing active-session API. Do not conflate queued input with current activity.
2. When running, expose a clear keyboard-accessible choice of Queue (default) and Steer; include explanations. Send the selected mode through `drive.send` for chats and work. An idle message sends normally. Keep existing attachments, references, draft recovery, `/new`, stop, and queued-message cancellation intact.
3. If steer is refused and backend falls back to queue, communicate the actual outcome rather than claiming it steered. If needed, return a typed actual-delivery result through IPC, updating both paths; never retry side effects after an ambiguous error. Ensure work review/ship restrictions remain enforced. Add an `[Unreleased]` changelog bullet.

## Verification and done

`pnpm typecheck`, `pnpm build`, and `git diff --check` exit 0. In `pnpm dev`, manually check idle send, queue and steer in both a chat and a ticket work session; verify a refusal/fallback is clearly reported, queued messages remain cancellable, drafts/attachments survive errors, and the selector works by keyboard. Check before first streamed text, after completion, and reconnect. No automated tests/frameworks. Update index only on completion.

STOP if the SDK cannot distinguish accepted steer from queued fallback, if streaming and authoritative activity conflict without a safe resolution, or if touching review policy is required. Document any model/service limitation rather than reporting an unconfirmed delivery.
