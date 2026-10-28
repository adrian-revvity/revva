# revva — Ticket pipeline state machine

One `Work` = one ticket being worked in one repo. States persist in `work.state`; every arrow is a user action or an event (session idle, verdict parsed, watcher alert). Crash resume: on app start, any `Running` phase re-attaches to its opencode session (sessions survive restarts).

```
                     ┌──────────────┐
   pick from board ▶ │    READY     │  ticket selected; repo/workspace chosen; choose Interactive/AUTO
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
                     │   REVIEW     │  parallel subagent fan-out: sol-loop + test-audit
                     │  (looping)   │  + impeccable (if UI). Fan-in, one fixer, parallel re-review.
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

Terminal/parallel states: `WAITING_HUMAN` (disputed review finding, unavailable required reviewer choice, grill exhausted, or permission refused), `ABANDONED` (worktree removed). Multiple works run concurrently. Within each review batch, all applicable reviewer subagent sessions start concurrently; a provider/service concurrency limit may delay a batch only when necessary and must be visible in the UI. Use exactly one Sol-loop reviewer per round, not multiple reviewers for that role.

## AUTO run mode

- **Entry:** an explicit `AUTO` checkbox in Start Work. A Settings preference may make it preselected, but the run dialog always displays the active mode and lets the user change it. General chats are not AUTO ticket runs.
- **Decision rule:** prompt the selected agent to achieve the ticket's acceptance criteria, use an explicit recommendation when available, otherwise choose a conservative option supported by ticket context and repository conventions. Record the choice and rationale/assumption; do not ask the user about routine choices.
- **Question handling:** if an OpenCode form offers an obvious recommended/safe answer, Revva replies automatically and records it. If options imply materially different product behavior, credentials/secrets, external commitments, or unsafe permissions, pause and ask one focused question with the agent's recommended option.
- **Execution:** AUTO follows normal build → parallel reviewer subagents → consolidate → fix → parallel re-review → repository checks. It does not skip grill/review/check stages that the user configured as required. It does not wait for a separate "Ship" approval after all gates pass.
- **Delivery:** after green gates, Revva commits if needed, pushes the work branch, and creates/opens the PR. Jira updates happen only according to the user's saved AUTO delivery policy. Never merge or force-push.
- **Permission boundary:** use a separate configurable AUTO permission profile scoped to the selected worktree (routine edits and checks). Never auto-approve access outside the selected workspace, secrets disclosure, destructive/data-loss commands, force-push, or merge. Out-of-policy requests become blockers.
- **Only interrupt for blockers:** ambiguous high-impact intent; unavailable model/skill required by policy; failed checks or incomplete reviewer; disputed blocker/should after review budget; expired/missing credentials; or action outside the permission boundary. Show a persistent status and send a notification only for a blocker or completion, not each phase.
- **Audit:** Cockpit's AUTO activity log shows selected recommendations, assumptions, permission decisions, reviewer/model choices, check results, PR URL, and any pause reason.

## General chat (outside this ticket pipeline)

The global **New Chat** action creates a standard OpenCode session with a selected workspace directory plus the user's selected agent and model (defaulting to the configured general-chat role). It is listed in Chat history and uses the same transcript, follow-up, interrupt, question, and permission UI as a ticket cockpit. It has no Jira key, worktree, review state, PR action, or automatic ticket pipeline. The user can start one without connecting Jira.

## Phase prompts (seeded by revva, editable in Settings)

- **GRILL** — uses the configured grill role agent/model (per-run override at ticket start); `POST /command {name:"grill-me", text:<ticket JSON: summary, description, acceptance criteria, linked issues>}` when that skill/command is available. Completes when session goes idle with your plan.
- **BUILD** — prompt template (include AUTO decision instructions when selected):
  ```
  Work ticket {KEY}: {summary}
  {description}

  Plan (from grill session — deviation must be justified): {plan|none}
  Rules:
  - Work only in this worktree. Commit with message "({KEY}) ..." at logical checkpoints.
  - Do not push, do not open PRs — revva ships after review.
  - Run the repo's checks (lint/typecheck/test) touching your change before finishing.
  - If UI changes are part of the ticket, note them in your final summary.
  - In AUTO: resolve routine choices using explicit recommendations or safest supported project convention; record assumptions; ask only when blocked by ambiguous/high-impact intent, missing credentials, or unsafe permissions.
  ```
  Agent + model = the implementation-role defaults or per-run choices at Start Work. No provider/model is a default requirement; Bedrock-dependent selections are gated by Morning readiness.
- **REVIEW fan-out (parallel):** launch one read-only subagent session per applicable gate at the same time: Sol-loop review, `test-audit`, and `impeccable` if UI is present. Each session uses that role's configured default or the user's per-run override. The user can choose GPU Qwen, GPT-6 Sol, or any other agent/model OpenCode exposes for any reviewer role. Each gets a focused prompt and the same base/diff/check results; none may edit, commit, or launch further reviewers.
- **REVIEW fan-in/fix:** wait for every gate; failed/timed-out/missing-skill reviewers are incomplete, not approval. Record individual outputs in the ledger, consolidate findings, then run one fixer (configured fixer role or implementation session) after reviewers have stopped. Fixer agent/model can be overridden per run.
- **REVIEW re-review:** if behavior changes or blocker/should findings remain, re-launch applicable reviewers concurrently against the updated diff. Sol-loop uses one selected reviewer per round and honors its bounded round budget. UI/test reviewers repeat when their scope changed or findings remain.
- **SHIP** — main-process code (not an agent): in Interactive mode, show the Ship action after approval; in AUTO, automatically proceed once gates pass. Ensure clean tree (agent's commits), `git push -u`, then:
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

- **Board cards** show state/AUTO chip, role/model badges, dep chain, pending-question count (red dot), review round indicator (◐ 2/3), comment-alert badge.
- **Cockpit** = tabs: Transcript (streaming, collapsible tool calls), Phases (timeline with per-phase session links + ledgers), Diff, Questions (inline answers).
- **Inbox** = all pending forms + permission requests across ticket works and general chats, keyboard-driven (↑↓ to pick, 1-4 option select, ⌘⏎ submit).
- **Start Work dialog** selects implementation and reviewer role defaults/overrides, optional grill, dependency branch, and Interactive vs AUTO.
- Global toolbar: **New Chat**, repo/workspace picker (Settings-managed list; the "target a folder" option), Jira refresh when connected, built-in Morning status/configuration, and dynamic agent/model pickers.

## Dependency (stacked) rules

- `dependsOn` comes from Jira issue links (`blocks` / "is blocked by"), shown on cards.
- Start-work dialog for a dependent ticket: parent branch selector defaults to the parent's revva work branch **if that work's worktree exists**, otherwise offers (a) fetch parent's remote branch, (b) branch from default anyway.
- Ship stacks automatically in that case; PR base = parent branch. If parent PR is unmerged when child is shipped, the child PR body gets `Depends on #<parent>` and Jira comment notes it.
