# Plan 010: Bind review completion to the correct execution

> Executor: read `AGENTS.md` and this plan. Planned at `ecf85d5`, 2026-10-29; relevant files had uncommitted changes. Compare both committed and working-tree changes, preserve them, and stop on material drift. `git diff --stat ecf85d5..HEAD -- src/main/review.ts src/main/pipeline/works.ts src/shared/types.ts CHANGELOG.md` does not detect uncommitted drift.

## Status and intent

P1 · M · HIGH risk · independent of 009 · category correctness. Review success can lead to a PR push. Revva must not count a completion or verdict from an earlier run as approval of the current run. This is an investigation-backed hardening opportunity, not a demonstrated production incident. Existing missing/invalid verdicts already fail closed; preserve that.

## Current state

`src/main/review.ts` creates each reviewer session, sets a tracking entry, then calls `api.session.prompt(...)` (around lines 216–235). Its `onEvent` calls `settle` on any `session.execution.succeeded` for a tracked session (around 280–310). `settle` reads messages in ascending order, limit 200, and finds the last assistant message; fixer success is treated as approved (around 313–336). `src/main/pipeline/works.ts:340` likewise advances a BUILDING session on an execution-succeeded event. Review state also verifies the worktree HEAD before approval. Preserve these existing checks.

## Scope and prerequisites

Inspect the installed `@opencode/client` event/prompt types and running-service OpenAPI, and OpenCode V2 API documentation, for durable execution/prompt correlation and reconnect semantics. Do not guess that timestamps or session ID uniquely identify a turn. In scope: `src/main/review.ts`, `src/main/pipeline/works.ts`, `src/shared/types.ts` only if needed, `CHANGELOG.md`, plan status. No provider-specific code, automatic approval changes, new test framework, or E2E tests. `pnpm typecheck` and `pnpm build` are the automated gates; `pnpm dev` and disposable manual flows are required.

## Steps

1. Document the actual event and message fields available on this project's installed client/service, including what a prompt returns, how an assistant message associates with a user input, ordering, pagination, and whether an execution identifier is present. Trace reviewer, fixer, and resumed build flows. If there is no reliable way to correlate, stop and report an API gap rather than inventing one.
2. Track the accepted prompt/run identity before accepting its completion. Handle an event arriving before prompt acceptance without falsely settling or losing a legitimate completion. On completion retrieve the response for that exact prompt/run, excluding old results; paginate or use an authoritative endpoint rather than assuming the oldest 200 contain the answer. Missing or ambiguous identity/verdict must block approval visibly. Make duplicate events idempotent. Apply the same principle to resumed builds and fixer success where the API supports it.
3. Consider reconnect/restart: reconcile from authoritative OpenCode session data, or mark an uncorrelatable active review blocked for human retry. Do not infer success from an idle state. Keep existing HEAD/clean-tree approval guards. Record a changelog bullet.

## Verification and done

`pnpm typecheck`, then `pnpm build`, then `git diff --check` all exit 0. Using `pnpm dev` and a disposable repository, manually run a review with a valid verdict; interrupted and missing-verdict reviewers block approval; a resumed session with an old approval cannot approve a later run; duplicate or delayed completion cannot settle a newer run; a reviewer finishing immediately is not missed; restart/reconnect does not silently approve; fixer success starts the intended next round. Verify no ship action occurs from ambiguous outcomes. Log exact API evidence and results in the handoff. Update index only after success.

STOP if the API cannot provide an authoritative correlation, if recovery would require rewriting unrelated session infrastructure, or if any check fails twice. Never approximate identity from wall-clock time alone. Future SDK upgrades must revalidate event ordering and identity semantics.
