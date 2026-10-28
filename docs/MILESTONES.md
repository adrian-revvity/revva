# revva — Milestones

Each milestone ships something you can use daily. Order assumes evenings/weekends; estimates are rough focused-work hours.

## M0 — Scaffold, first-run setup + service attach (≈1d)
- electron-vite + React + TS + Tailwind scaffold in `revva/`; strict TS, pnpm.
- Initialize shadcn/ui for Vite, commit `components.json` and theme tokens; use the project-local shadcn skill/MCP and reuse-first policy from `docs/FRONTEND.md`.
- First-run setup: discover OpenCode, choose workspace/worktree folders, detect optional tools; no user-specific path/provider/token assumptions.
- `src/main/opencode`: `Service.ensure()`, typed IPC `revva:service:status`, reconnect logic, dynamic models/agents/skills.
- Status bar shows opencode version/url (today: `v2.0.30 @ 127.0.0.1:49374`).
- **Exit test:** clean user profile can connect without importing developer config and sees that profile's live service/models/agents/skills.

## M0.5 — General chat (≈0.5d)
- Global New Chat action; choose authorized workspace directory plus configured agent/model; create an ordinary OpenCode session.
- Chat list/history, streaming transcript, follow-up, interrupt, forms, and permission handling; no Jira connection required.
- **Exit test:** start, close, and reopen a non-ticket chat; resume the same OpenCode session after restarting Revva.

## M1 — Board + start work + watch (≈1.5d)
- Settings: user-selected workspace/worktree roots, Atlassian OAuth onboarding (and documented REST-token fallback), and per-role agent/model defaults.
- Atlassian MCP client (Revva-owned auth, session init, tools map) + JQL board fetch with 5-min/focus refresh.
- Start work: pick repo, implementation agent/model (default or per-run), reviewer role overrides, optional grill toggle, dep parent branch → opencode `POST /api/worktree` + `session.create` + build prompt.
- Start Work exposes Interactive/AUTO selection; persist mode visibly on the ticket run (AUTO execution policy and delivery completed in M5).
- Cockpit v1: SSE transcript (text + tool calls + costs), interrupt, chat box, stop.
- sqlite schema v1 (settings/workspace/ticket/work/phase).
- **Exit test:** pick a ticket from the connected user's Jira → agent codes in a fresh worktree → watch it live.

## M2 — Question inbox (≈0.5d)
- `GET /api/form` + `/api/permission/request` per active location, SSE-pushed; global Inbox; inline in Cockpit; answered-audit table.
- **Exit test:** agent asks a question → red badge → answer from Inbox → agent continues.

## M3 — Scripts (user one-click commands) (≈0.5d)
- Sidebar Scripts section: user-defined scripts (name + shell command or alias, optional cwd), run/kill with live streamed output, last exit/duration, run history. Runs through interactive zsh so the user's own aliases (e.g. `morning`) work unchanged.
- "Morning" is NOT modeled: no AWS CLI/SSO/proxy/SigV4 logic in Revva. The user pastes their own script.
- Light model gating only: providers whose baseURL is a loopback endpoint get grayed out in pickers while that port is not listening, with a "run its script" explanation. No provider ever blocks the app (REQ-AWS-5).
- **Exit test:** add a script, click Run, see live output + exit code; a loopback-provider model is disabled until the port answers.

## M4 — Review pipeline (≈2d) ⭐ the meat — DONE 2026-10-28
- Phase runner framework (idle detection via `session.idle` + `/wait`, verdict parsing, ledger persistence, resume).
- Parallel review fan-out of read-only subagent sessions: one Sol-loop reviewer, test-audit, and impeccable when UI is detected; no reviewer edits or starts other reviewers.
- Per-role agent/model defaults plus per-run overrides for every reviewer and fixer; any agent/model exposed by the user's OpenCode service is eligible.
- AUTO decision policy: explicit recommendation/safe-choice handling, assumptions log, concise blocker escalation, and a separately configured least-privilege permission profile. No routine progress pings.
- Fan-in ledger, consolidated findings, one fixer session, then bounded parallel re-review; incomplete/error reviewers block approval and are visible.
- Sol-loop ≤3 rounds by default, up to 5 only under its stated conditions; each round has one Sol-loop reviewer.
- Provider-aware concurrency limits may queue a whole reviewer batch when necessary, but may not silently serialize gates or mark queued gates approved.
- **Exit test (done manually):** build finished → sol + test-audit reviewers ran concurrently (impeccable skipped: no UI files), test-audit requested changes → fixer ran → round 2 → round 3 → rounds capped at 3 → WAITING_HUMAN with the reason in the decision ledger. Role defaults live in Setup; per-run overrides in Start Work. Remaining later: verify multiple arbitrary models by taste while using the app.

## M5 — Ship + Jira sync (≈0.5d) — DONE 2026-10-28
- Commit-tree check, push, `gh pr create` (open browser), `gh stack submit` path for dep chains, Jira transition + summary comment, stack base wiring.
- In AUTO mode, push/create/open PR automatically after all review gates and repository checks pass; Interactive mode retains an explicit Ship action. Neither mode merges; never force-push.
- AUTO activity log records choices, assumptions, permission decisions, outcomes, and blockers; notify only for blocker or completion.
- **Exit test (done manually 2026-10-28, single-ticket):** APPROVED → Ship dialog checks all green → push → `gh pr create` (correct base/title/body, opened in browser) → Jira transitioned to "Ready for Test" + summary comment → state SHIPPED with PR link in the cockpit. Stacked two-ticket run still to try organically on real tickets (base = parent branch is already wired via parentWorkId).
- **AUTO exit test:** a clear ticket completes from Start Work to PR without routine user prompts; a high-impact ambiguous question, missing auth, or unsafe permission pauses for the user; no PR is merged.

## M6 — Comment watcher + rework (≈1d) — DONE 2026-10-28
- Poller (watermarks), unresolved-comment detection (exclude agent's own), alert badge + Inbox section, "Tackle comments" rework session, revva-side Jira reply/resolve from agent's structured response block, auto-return to REVIEW.
- **Exit test (done manually 2026-10-28):** watcher polls every 60s for works with a PR; seeded a comment row → cockpit strip rendered with author preview + "Tackle comments" button; pending IPC and push events verified live. Full live loop (real Jira comment → tackle → PR push + Jira reply) to confirm organically on the next shipped ticket — the tackle path posts to the real ticket so it was not fired against CLN-112681 during smoke.

## M7 — Portability and polish (ongoing)
- Multi-work concurrency dashboard, cost totals, per-repo check commands, plan-edit before BUILD, reduced-motion/a11y pass, launch-at-login, auto-update (electron-builder + notarization skipped while personal).
- Validate clean-profile installation, OS-specific paths/credential storage adapters, optional integrations, and setup docs; macOS is v1 target, avoid architectural AppleScript/zsh dependencies.

## Open decisions (resolve when each milestone starts)
1. **Atlassian MCP reliability** (M1): if the Node MCP client trips Cloudflare 1010, use REST v3 + OS-secured API token behind the same interface (plan B is a config flag, not a rewrite).
2. **grill-me session lifecycle** (M4 if grill feels clunky): keep grill as its own session (current plan) vs. same session as build with the command — same-session loses the clean "locked plan" artifact; current plan preferred.
3. **Review role defaults** (M4): ship sensible empty/default role settings based on the user's available inventory; never hardcode Sol/Qwen. Any role can be overridden per run.
4. **Rework Jira writes by agent vs. revva** (M6): current plan = revva writes (agents get no Jira credentials); revisit if comment replies lose the agent's nuance.

---

---

## Testing policy (owner decision — YOLO)

No E2E tests and nearly no unit tests, on purpose. Every "Exit test" above means:
run the app manually and click through the flow once. `pnpm typecheck` +
`pnpm build` are the only automated gates. See AGENTS.md.

## Owner notes (backlog)

- **Board polish:** give Jira status codes a color palette so they're easy to tell apart at a glance; add a status dropdown filter and a search bar to the Board page.
