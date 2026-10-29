# Plan 012: Add human diff comments to ticket work

> Executor: read `AGENTS.md`, `docs/PIPELINE.md`, and this plan. Planned at `ecf85d5`, 2026-10-29, with uncommitted changes in work, review and UI files. Inspect `git diff`, preserve in-flight changes, and stop on material drift. `git diff --stat ecf85d5..HEAD -- src/main src/preload src/shared src/renderer/src/views CHANGELOG.md` checks only committed drift.

## Status and intent

P2 · L · HIGH risk · **after 010**. Human reviewers should inspect ticket work and submit file/line comments to the agent, without bypassing existing review or ship gates. Orca and T3 show line-based annotation; Revva's prior design notes describe a simple comment format in `docs/ORCA-NOTES.md:31–35`. Start with a limited, safe ticket-work feature—not a full IDE or GitHub review replacement.

## Current state

`src/renderer/src/views/WorkCockpit.tsx` renders `ReviewPanel`, `ShipPanel`, `CommentsStrip`, and a shared transcript. `src/main/review.ts` runs parallel reviewers, then a fixer, and existing `src/main/pipeline/works.ts` `followUp` rejects sends during REVIEW/FIXING or shipping. `src/main/ship.ts` enforces ship gates. No user-facing worktree diff or diff-comment persistence exists. The current branch's existing uncommitted edits must remain intact.

## Scope

In scope: new focused files under `src/main/` and `src/renderer/src/views/` for diff/comments, `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/ipc-channels.ts`, `src/shared/types.ts`, `src/renderer/src/views/WorkCockpit.tsx`, `src/main/pipeline/works.ts` only if needed to preserve follow-up semantics, schema code in `src/main/db/` consistent with the current migration pattern, `CHANGELOG.md`, plan index. Do not change `src/main/review.ts` or `src/main/ship.ts` to auto-approve or bypass gates. Use shadcn components and existing theme; no E2E/unit test infrastructure per AGENTS.md.

## Steps

1. Define a read-only work diff against the **recorded actual base**, including committed branch changes and explicitly identified uncommitted changes. Reuse Revva's base-lineage logic (`src/main/ship.ts`) rather than assuming main. Handle filenames safely (NUL-separated Git output), binary files, renames, large diffs, and missing bases; report unsupported cases rather than guessing line numbers. Read only the worktree selected by work ID. Bound response size and avoid rendering HTML from repository text.
2. Add a cockpit diff panel with selectable changed lines and a keyboard-accessible comment editor. Persist drafts per work ID with relative path, old/new side, line range, and the reviewed base/head or content identity. Preserve drafts across refresh/restart. Mark a draft stale if its referenced change no longer matches; never silently move it to unrelated code. Do not persist the entire diff or secrets.
3. Provide an explicit **Send feedback** action that previews the exact comments and sends them as a normal work follow-up only when existing follow-up rules permit. Include file, side, range, reviewed revision, and verbatim comment as untrusted human feedback. The model must not execute comment text as an instruction from Revva itself. Clear/mark submitted drafts only after authoritative send acceptance; no automatic push or Jira write. Do not inject drafts silently into reviewer results or claim they went to an already-running fixer.
4. Add an `[Unreleased]` bullet. Keep the existing transcript, human review, AUTO behavior and ship guards unchanged.

## Verification and done

`pnpm typecheck`, then `pnpm build`, and `git diff --check` all exit 0. In `pnpm dev` using a disposable repo, manually inspect a committed change, draft multi-line comments, restart and recover drafts, submit feedback, verify the agent sees correct file/range, and confirm the pipeline re-enters review. Check staged/unstaged changes, renamed and binary files, missing base, a changed diff making a draft stale, long paths, keyboard navigation, rejected send and review-in-progress behavior. Verify no unsolicited push or Jira comment. Record unsupported cases; update index when complete.

STOP if a correct and secure base/diff cannot be resolved, identity of changed lines cannot be checked after edits, sending feedback would bypass active-review guards, or the scope requires replacing the review/ship state machine. Future diff renderers must preserve comment anchoring and stale detection.
