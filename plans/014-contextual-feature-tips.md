# Plan 014: Contextual feature tips instead of tours

> Executor: read `AGENTS.md`. Planned at `2eb91c0`, 2026-10-29 from `docs/ORCA-NOTES.md` backlog item 12. Preserve unrelated in-flight changes; check `git diff` first.

## Status and intent

P3 · S · LOW risk · independent. Orca's pattern: no first-run tour; a small tip appears **only** next to a feature the user has never used, once, and never again (dismiss or interact ⇒ recorded). Revva today has only the static `FeaturesDialog` (a feature list in Setup) — no in-context discovery.

## Current state

`src/renderer/src/views/FeaturesDialog.tsx` renders the feature list (kept — it is reference material, not a tour). Interaction state lives in main via `settingGet`/`settingSet` (`src/main/db/index.ts`), already exposed for other features (e.g. `model.favorites`). Views of interest: WorktreesDialog (cleanup), BoardView (start work), InboxView, GitHubView, ScriptsView.

## Scope and conventions

In scope: a tiny `src/renderer/src/lib/feature-tips.ts` (pure helpers), a `TipBubble` composed from the existing shadcn `popover`/`tooltip` + `Button` in `src/renderer/src/components/` is allowed only if popover composition proves clumsy — prefer composing inline in each host view; `src/main/ipc.ts` + `src/shared/ipc-channels.ts` + `src/preload/index.ts` for one generic `settings.get`/`settings.set` pair **only if** a generic settings IPC does not already exist; host views listed above; `CHANGELOG.md`. No new dependencies, no tests.

## Steps

1. Define a fixed tip registry in `feature-tips.ts`: `{ id, host }` — e.g. `worktree-cleanup`, `start-work`, `inbox-answer`, `pr-merge`, `scripts-run`. Keep titles/bodies ≤ ~120 chars, plain, no hype.
2. Persistence: one setting key `tips.dismissed` (string array). A tip shows when its id is not in the array **and** the feature has zero recorded uses (reuse existing signals where they exist — e.g. works count 0 before `start-work`, no PRs seen before `pr-merge`; do not build new usage tracking beyond trivial counters).
3. Surface: a discreet inline bubble/`Sparkles` affordance in the host view's header area, never a modal, never over content; dismiss (×) adds the id to `tips.dismissed`; using the feature dismisses too. `seenIds` writes are fire-and-forget with the existing setting IPC pattern; renderer must not crash if main is busy.
4. Respect density: at most one tip visible per view at a time; tips vanish immediately when dismissed app-wide via a single `tips.disabled` setting surfaced in Setup next to the features list. Add an `[Unreleased]` changelog bullet.

## Verification and done

`pnpm typecheck`, `pnpm build`, `git diff --check` exit 0. In `pnpm dev`: with an empty-ish state the tip appears once per host, dismiss persists across restart, interacting with the feature also dismisses it, and `tips.disabled` removes everything at once. Update `plans/README.md` when complete.

STOP if persisted-setting plumbing would require schema changes beyond a setting row, or if any host view's in-flight diff (chat/inbox churn) makes a safe minimal edit impossible — record the conflict instead of forcing it.
