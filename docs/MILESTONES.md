# revva — Milestones

Each milestone ships something you can use daily. Order assumes evenings/weekends; estimates are rough focused-work hours.

## M0 — Scaffold + service attach (≈0.5d)
- electron-vite + React + TS + Tailwind scaffold in `revva/`; strict TS, pnpm.
- `src/main/opencode`: `Service.ensure()`, typed IPC `revva:service:status`, reconnect logic.
- Status bar shows opencode version/url (today: `v2.0.30 @ 127.0.0.1:49374`).
- **Exit test:** `pnpm dev` opens a window that shows the live service and lists sessions/models/agents/skills.

## M1 — Board + start work + watch (≈1.5d)
- Settings: workspaces (`~/workspace` subfolders), worktrees root (`~/workspace-worktrees` per your global permission allowlist), Jira user/site check.
- Atlassian MCP client (token load/refresh, session init, tools map) + JQL board fetch with 5-min/focus refresh.
- Start work: pick repo, model preset, optional grill toggle, dep parent branch → opencode `POST /api/worktree` + `session.create` + build prompt.
- Cockpit v1: SSE transcript (text + tool calls + costs), interrupt, chat box, stop.
- sqlite schema v1 (settings/workspace/ticket/work/phase).
- **Exit test:** pick a real CLN ticket → agent codes in a fresh worktree → you watch it live.

## M2 — Question inbox (≈0.5d)
- `GET /api/form` + `/api/permission/request` per active location, SSE-pushed; global Inbox; inline in Cockpit; answered-audit table.
- **Exit test:** agent asks a question → red badge → answer from Inbox → agent continues.

## M3 — Morning button (≈0.5d)
- Terminal.app spawn, readiness prober, titlebar chip, Bedrock preset gating (model dropdown filters on readiness).
- **Exit test:** click Morning → SSO in Terminal → chip goes green → "gpt-6.1-sol" preset selectable for a session.

## M4 — Review pipeline (≈2d) ⭐ the meat
- Phase runner framework (idle detection via `session.idle` + `/wait`, verdict parsing, ledger persistence, resume).
- sol-loop: vendor skill from tstack with opencode adaptation (§6 ARCHITECTURE); reviewer (Sol, deny-edit) + fixer pair; ≤3 rounds; stop conditions; WAITING_HUMAN escalation card in Cockpit.
- test-audit reviewer via skill API; findings → fixer; ≤2 rounds.
- impeccable conditional run (UI-file diff heuristic + label `ui`); warn/block policy.
- Sequential Bedrock-reviewer queue.
- **Exit test:** finish a build → watch rounds appear as cards with verdicts/ledger → APPROVE unlocks Ship.

## M5 — Ship + Jira sync (≈0.5d)
- Commit-tree check, push, `gh pr create` (open browser), `gh stack submit` path for dep chains, Jira transition + summary comment, stack base wiring.
- **Exit test:** two dependent tickets → stacked PRs (child base = parent branch) → both tickets transition with links.

## M6 — Comment watcher + rework (≈1d)
- Poller (watermarks), unresolved-comment detection (exclude agent's own), alert badge + Inbox section, "Tackle comments" rework session, revva-side Jira reply/resolve from agent's structured response block, auto-return to REVIEW.
- **Exit test:** add a Jira comment on a shipped ticket → badge → tackle → PR updated + thread resolved.

## M7 — Polish (ongoing)
- Multi-work concurrency dashboard, cost totals, per-repo check commands, plan-edit before BUILD, reduced-motion/a11y pass, launch-at-login, auto-update (electron-builder + notarization skipped while personal).

## Open decisions (resolve when each milestone starts)
1. **Atlassian MCP reliability** (M1): if the Node MCP client trips Cloudflare 1010, flip to REST v3 + Keychain PAT behind the same interface (plan B is a config flag, not a rewrite).
2. **grill-me session lifecycle** (M4 if grill feels clunky): keep grill as its own session (current plan) vs. same session as build with the command — same-session loses the clean "locked plan" artifact; current plan preferred.
3. **sol-loop model substitution wording** (M4): skill says "do not substitute a model" — revva surfaces an explicit, user-acknowledged fallback chip rather than silently using Qwen as reviewer.
4. **Rework Jira writes by agent vs. revva** (M6): current plan = revva writes (agents get no Jira credentials); revisit if comment replies lose the agent's nuance.
