# Plan 009: Protect worktree contents before removal

> Executor: read this entire plan and `AGENTS.md` first. Planned at `ecf85d5` on 2026-10-29 against a **dirty working tree**. Do not overwrite or stash existing changes; compare the live code and `git diff` with the excerpts below, including uncommitted changes, before editing. If they differ materially, stop and report. `git diff --stat ecf85d5..HEAD -- src/main/pipeline/works.ts src/main/worktrees.ts src/main/ipc.ts src/preload/index.ts src/shared src/renderer/src/App.tsx src/renderer/src/views/WorktreesDialog.tsx CHANGELOG.md` detects committed drift only.

## Status and intent

P1 · M · HIGH risk (deletion) · no dependencies. Revva's abandon flow forces removal, potentially discarding uncommitted or untracked files. Preserving the branch with `git branch -d` does not preserve those files. Make preservation the default and require informed explicit confirmation for any destructive removal. Reference: [Orca path and registration guards](https://github.com/stablyai/orca/blob/38c111697ace/src/main/worktree-removal-safety.ts).

**Owner decision, 2026-10-29:** allow in-app removal after explicit confirmation and an immediate fail-closed recheck of contents and active OpenCode sessions. Warn that external programs can still change files between the check and deletion; do not claim the operation is race-free. This replaces the original requirement for an impossible cross-process guarantee. If active OpenCode sessions cannot be checked or stopped reliably, refuse removal.

## Current state and scope

- `src/main/pipeline/works.ts` `abandon`: cancels reviews, removes session, then `git worktree remove --force` with errors swallowed; marks abandoned even if removal failed.
- `src/main/worktrees.ts` `remove`: compares path strings, accepts `force`, and attempts branch `-d`; `WorktreesDialog.tsx:61` passes `force: true` for every selected worktree.
- `src/renderer/src/App.tsx` `abandon` asks a generic confirmation and invokes `window.revva.work.abandon(workId)`. `src/main/ipc.ts` wires this API; shared types/preload mirror it.
- Follow existing typed IPC and `execFile` patterns. Keep preload zod-free. `AGENTS.md` disallows new test frameworks and E2E tests; only `pnpm typecheck`, `pnpm build` automated, manual flows via `pnpm dev`. Add an `[Unreleased]` changelog bullet; do not bump version.

In scope: `src/main/pipeline/works.ts`, `src/main/worktrees.ts`, a new `src/main/worktree-safety.ts` if useful, `src/main/ipc.ts`, `src/shared/types.ts`, `src/shared/ipc-channels.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/views/WorktreesDialog.tsx`, `CHANGELOG.md`, and this index row. Do not change review gate/ship logic, repository contents, or general settings.

## Steps

1. Add a read-only preflight for each removal path: resolve canonical repository and worktree paths; require an exact registered non-main Git worktree, reject filesystem roots, home, repository or ancestor, nested registered worktrees, missing/unverifiable ownership for abandonment, and locked worktrees unless explicitly supported. Collect `git status --porcelain` tracked and untracked changes **and ignored files**, noting ignored dependencies may be large; show counts and a concise warning, not file contents. Fail closed on Git errors. Use arguments to `execFile`, not a shell. The main process must perform checks, not just renderer.
2. Design typed IPC to return preflight and require a separately explicit user confirmation for dirty/ignored contents; default to non-force removal. At execution revalidate registration, active users and dirty state; if it changed since preflight, refuse and ask user to review again. Preserve existing non-destructive branch deletion. Do not silently prune or swallow errors. Do not remove session or set `ABANDONED` when filesystem removal fails. Protect running sessions/reviews and handle cancellation race conservatively; if safe coordination is unclear, STOP.
3. Update both UI entry points: identify each affected path, show dirty/untracked/ignored warning, preserve cancel as default, and use an unmistakable explicit destructive confirmation only when needed. For bulk removal, show per-worktree results and do not silently force all. Retain app state when cancelled/failing. Add changelog entry.

## Verification and done

Run `pnpm typecheck`, then `pnpm build`; both exit 0. In a **disposable** repository/worktree created specifically for the manual check, use `pnpm dev` to verify: clean removal; tracked edit, untracked file, and ignored file warnings; cancel leaves files/session intact; explicit force removes only the intended checkout; failed removal preserves work state; main, unregistered and nested worktrees are refused; a changed preflight is rejected. Never perform destructive checks on existing user worktrees. Confirm a branch with unmerged commits remains. `git diff --check` exits 0 and no out-of-scope changes are introduced. Update `plans/README.md` only when complete.

STOP if path/ownership proof cannot be established, the main worktree cannot be identified reliably, active OpenCode sessions cannot be checked reliably, or a verification fails twice. External writers cannot be locked out: warn explicitly and recheck immediately before removal as the owner authorized above. Err on preservation rather than improvising cleanup. Review future changes to symlink handling, ignored files, and concurrent sessions against this boundary.
