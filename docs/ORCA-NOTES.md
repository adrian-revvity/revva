# Notes from studying stablyai/orca

Orca (https://github.com/stablyai/orca) is a much larger Electron app with the same skeleton
as revva: git worktrees per task, CLI agent sessions (incl. OpenCode), GitHub + Jira, review
flows. Deep-dived 2026-10-28 (cloned, five parallel read passes). This is what we take, what
we take later, and what we deliberately leave.

## Steal now (executing as a batch — 2026-10-28)

1. **Crash-safe worktree create with ownership receipts.** They create via
   `git worktree add --detach --no-checkout --lock --reason revva-create:<pid>:<uuid>`
   and treat the lock reason as the *only* proof of ownership — a path alone never
   authorizes deletion. Crashed creates are identifiable and safe to reap.
   → `works.ts createWorktree`: locked two-phase add, then `branch -f` + checkout.
2. **Never lose commits on abandon.** Their rule: delete branches with `git branch -d`
   (never `-D`); if git refuses because unmerged, keep the branch and surface
   "branch preserved: revva/CLN-x". → `works.ts abandon()`.
3. **Branch lineage in git config.** They write `git config branch.<name>.base <ref>` at
   creation so lineage survives outside the app DB. → set in create; `ship.baseFor` falls
   back to it.
4. **Lazy fetch + timeout-bounded git.** They fetch only when the base ref isn't local;
   every network git call has a timeout. → `createWorktree` did an unconditional
   `fetch --all`; now fetched only when the base ref can't be resolved locally.
5. **Collision policy: adopt, don't fail.** Same-ticket rerun: an existing branch is
   adopted (`worktree add <dir> <branch>`) instead of erroring; if the *directory* is
   taken, bump a suffix until free. → `createWorktree`.
6. **Cockpit refresh on disk change.** They revalidate diff/status when git's state
   signature changes, not only on push events. → `WorkCockpit` refetches the work's
   branch status when the window regains focus / a work event lands.

## Steal next (backlog, in value order)

7. **Annotate-the-diff loop.** Tiny `DiffComment {filePath, startLine?, lineNumber, body}`
   persisted per work, formatted block sent verbatim to the agent:
   `File: …\nLines: 12-18\nUser comment: "…"` — human joins the fixer fan-in.
8. **Turn-done verdicts.** A "done" only counts if newer than the prompt send; stale or
   resume-only events are rejected; a reviewer that never posted a verdict counts as
   failure, not approval. Extra guard on top of `session.execution.*`.
9. **Attention-ranked inbox.** 5-class ranking: needs-you > finished-unseen > working >
   stale > idle, with time decay. Pitfall to avoid: NaN/Infinity timestamps pin rows
   to the top forever.
10. **OS notifications with suppression.** Per-source mute → category toggle →
    window-focused suppression; in-app sound fallback when macOS permission undecided.
11. **Command palette (Cmd+K)** over chats/works/tickets/PRs. Their matcher is a quality
    ladder (exact > word-prefix > boundary-substring > typo), not fuzzy scoring.
12. **Contextual feature tips** instead of first-run tours: only for features with zero
    recorded interaction; `seenIds` in persisted state.
13. **Session guardrails via opencode.json in worktrees**: deny `.env` reads, ask on
    `external_directory`, `doom_loop: "ask"` (their own config does this).

## Skip

- **Mobile companion + cloud relay** — a whole second product.
- **Multi-provider orchestration** (30+ CLIs), account switcher, rate-limit probes —
  revva is OpenCode-only by design.
- **PTY/terminal stack** — revva drives the OpenCode HTTP API; no terminals exist.
- **Their RPC envelope + codegen** — proportionate for a multi-process fleet, not a
  single app with one typed IPC contract.
- **Layout persistence machinery** (~100 files) — for terminal splits we don't have.
