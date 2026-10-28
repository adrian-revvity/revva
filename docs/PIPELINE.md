# revva — Ticket pipeline state machine

One `Work` = one ticket being worked in one repo. States persist in `work.state`; every arrow is a user action or an event (session idle, verdict parsed, watcher alert). Crash resume: on app start, any `Running` phase re-attaches to its opencode session (sessions survive restarts).

```
                     ┌──────────────┐
   pick from board ▶ │    READY     │  ticket selected; repo/workspace chosen
                     └──────┬───────┘
            Start work ▶  (worktree + branch; dep ⇒ branch from parent's branch)
                     ┌──────▼───────┐
      optional       │   GRILLING   │  session A: /grill-me — interactive; you answer in Cockpit/Inbox
      (toggle off ──▶│              │  output = locked plan → saved as phase detail
      goes to BUILD) └──────┬───────┘
                     ┌──────▼───────┐
                     │    BUILD     │  session B (main model you picked): prompt = ticket + plan
                     │              │  + gh/grill context. You can chat, steer, answer questions.
                     └──────┬───────┘
              session idle + diff non-empty
                     ┌──────▼───────┐
                     │   REVIEW     │  sol-loop ≤3 rounds → test-audit → (impeccable if UI)
                     │  (looping)   │  fixer session between rounds. Any blocker unresolved
                     └──────┬───────┘  after budget ⇒ WAITING_HUMAN
              verdict APPROVE
                     ┌──────▼───────┐
                     │    SHIP      │  commit+push ⇒ gh pr create / gh stack submit
                     └──────┬───────┘  ⇒ Jira transition + summary comment with PR link
                     ┌──────▼───────┐
                     │   SHIPPED    │  watcher polls this ticket's comments
                     └──────┬───────┘
        new unresolved comment by someone else (watcher alert, badge on card)
                     ┌──────▼───────┐
                     │ REWORK_READY │  "Tackle comments" button
                     └──────┬───────┘
                     ┌──────▼───────┐  new session in same worktree:
                     │ REWORKING    │  read comments → fix → answer each comment thread
                     └──────┬───────┘  → resolve → push → request re-review
                             │
                     back to REVIEW (fresh rounds; existing PR updated)
```

Terminal/parallel states: `WAITING_HUMAN` (disputed review finding, grill exhausted, or permission refused), `ABANDONED` (worktree removed). Multiple works run concurrently — each is independent; only `REVIEW`'s model usage is throttled (one Bedrock reviewer at a time by default, queue is FIFO).

## Phase prompts (seeded by revva, editable in Settings)

- **GRILL** — `POST /command {name:"grill-me", text:<ticket JSON: summary, description, acceptance criteria, linked issues>}`. Completes when session goes idle with your plan.
- **BUILD** — prompt template:
  ```
  Work ticket {KEY}: {summary}
  {description}

  Plan (from grill session — deviation must be justified): {plan|none}
  Rules:
  - Work only in this worktree. Commit with message "({KEY}) ..." at logical checkpoints.
  - Do not push, do not open PRs — revva ships after review.
  - Run the repo's checks (lint/typecheck/test) touching your change before finishing.
  - If UI changes are part of the ticket, note them in your final summary.
  ```
  Model = your pick at Start-work time (default preset: `gpu-poc/qwen3.8-flash-next`; Bedrock presets gated on morning-ready).
- **REVIEW/sol-loop** — reviewer session (Sol) + fixer session (build model). Ledger JSON in `reviewRun`. Fixer prompt = findings with your auto-agree policy (blockers/shoulds auto-fix; nits listed as follow-ups).
- **REVIEW/test-audit** — reviewer session with `test-audit` skill (audit mode). Output = findings → fixer loop (≤2 rounds).
- **REVIEW/impeccable** — reviewer session with `impeccable` skill scoped to changed UI files. Gate policy configurable; default warn-only, findings posted to Cockpit for one-click "fix these".
- **SHIP** — main-process code (not an agent): ensure clean tree (agent's commits), `git push -u`, then:
  - no dep → `gh pr create --base {default} --fill-first`, open browser.
  - dep → ensure parent branch pushed → `gh stack` per gh-stack skill (stack submit); base = parent branch.
  - Jira: transition to configured status per repo/workspace setting ("In Review"), add comment: PR link + review summary (rounds, verdicts, models used).
- **REWORK** — new session in same worktree:
  ```
  Jira reviewers left feedback on {KEY} (PR {url}):
  {comment threads with ids/authors}
  Fix the valid feedback on this branch, push, then for EACH thread reply with what
  changed (via Jira MCP tools) and resolve it. Finally request re-review on the PR.
  ```
  (The Jira side of rework uses revva main-process tools exposed to the agent? **No** — kept simple: agent fixes+pushes via git/PR tools it already has; replying/resolving Jira comments is done by revva itself from the agent's structured "comment responses" block, via the MCP client. This avoids giving every agent Jira write access.)

## UI-to-pipeline mapping

- **Board cards** show state chip, model badge, dep chain, pending-question count (red dot), review round indicator (◐ 2/3), comment-alert badge.
- **Cockpit** = tabs: Transcript (streaming, collapsible tool calls), Phases (timeline with per-phase session links + ledgers), Diff, Questions (inline answers).
- **Inbox** = all pending forms + permission requests across all works, keyboard-driven (↑↓ to pick, 1-4 option select, ⌘⏎ submit).
- Global toolbar: repo/workspace picker (Settings-managed list; the "target a folder" option), Jira refresh, Morning chip, Bedrock-model dropdown (disabled until ready).

## Dependency (stacked) rules

- `dependsOn` comes from Jira issue links (`blocks` / "is blocked by"), shown on cards.
- Start-work dialog for a dependent ticket: parent branch selector defaults to the parent's revva work branch **if that work's worktree exists**, otherwise offers (a) fetch parent's remote branch, (b) branch from default anyway.
- Ship stacks automatically in that case; PR base = parent branch. If parent PR is unmerged when child is shipped, the child PR body gets `Depends on #<parent>` and Jira comment notes it.
