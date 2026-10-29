# Plan 015: Session guardrails via opencode.json in created worktrees

> Executor: read `AGENTS.md`. Planned at `2eb91c0`, 2026-10-29 from `docs/ORCA-NOTES.md` backlog item 13. Preserve unrelated in-flight changes; check `git diff` first.

## Status and intent

P2 · S–M · MED risk · independent. Ticket-build agents run unattended inside worktrees. Orca drops a project `opencode.json` into each worktree to deny reading `.env` files, ask before touching `external_directory`, and set `doom_loop: "ask"` — so an agent cannot silently exfiltrate secrets or spin. Revva writes nothing today: `createWorktree` (`src/main/pipeline/works.ts`) leaves the checkout exactly as git made it.

## Current state

`works.ts createWorktree` has two paths: the OpenCode service `worktree.create` API (preferred) and the two-phase `git worktree add` fallback. A guardrails file must land in **both**. The exact config keys (`permission` ruleset shape, `doom_loop`, external-directory naming) belong to the OpenCode **server** config format, not the client typings — they are NOT in `@opencode/client`; verify against the running service's documented config (and the user's own `~/.config/opencode/opencode.json` precedence) before writing anything. Revva must not invent keys, and must not override a worktree/user config that already exists — merge-or-skip, never clobber.

## Scope and conventions

In scope: `src/main/pipeline/works.ts` (write step after each successful create path), a small `src/main/opencode/guardrails.ts` (pure: build the JSON object + merge rules), possibly `src/main/db/index.ts` for one `settingGet` toggle (`pipeline.guardrails`, default on), `CHANGELOG.md`. Nothing in the renderer. No tests; gates `pnpm typecheck`, `pnpm build`, manual `pnpm dev`.

## Steps

1. Investigate first: confirm on the user's installed service which config file(s) an agent session inside a directory reads (worktree-level `opencode.json` vs project root), the exact schema for deny/ask permission rules (read of `.env*`, ask on paths outside the worktree, `doom_loop`), and how global/user/project configs merge. Record evidence in the handoff. STOP if the schema cannot be established from the running service or its docs.
2. `guardrails.ts`: pure function producing the object `{ permission: { read: { "*.env": "deny", "*.env.*": "deny", … }, … doom loop as documented } }` plus a merge helper: if the worktree already has an `opencode.json` (adopted branch may carry one), leave the file completely untouched — do not merge into a file someone else authored; skip with a log line.
3. `createWorktree`: after a successful create on **both** paths (service API and git fallback), write `opencode.json` only when absent and the setting is enabled. File creation is best-effort: a failure logs a warning but does not fail the work creation (the work itself is still safe to run) — never throw from this step, never overwrite.
4. Add the `pipeline.guardrails` toggle near the other pipeline settings in Setup (`src/renderer/src/views/Setup.tsx` may need one Switch row — allowed, existing component); document in the FeaturesDialog text if that list mentions worktrees. Changelog bullet.

## Verification and done

`pnpm typecheck`, `pnpm build`, `git diff --check` exit 0. In `pnpm dev` with a disposable repo: start work → worktree contains the guardrails file with verified keys; a session inside refuses a `.env` read (ask the agent to cat it — it must be denied/asked, observed in the transcript, not assumed); a worktree whose branch already carries an `opencode.json` is left byte-identical; toggle off ⇒ no file written. Update `plans/README.md` when complete.

STOP if the config schema cannot be verified against the installed service (inventing keys silently disables the guard), if writing the file changes user-visible behavior of adopted branches carrying their own config, or if the service API create path rejects files placed before its own bookkeeping — document findings rather than guessing.
