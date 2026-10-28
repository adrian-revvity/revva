# revva — Architecture

## 1. Big picture

```
┌────────────────────────────── Electron app ─────────────────────────────┐
│  Renderer (React)                     Main process (local engine)       │
│  Board · Chat · Cockpit · Inbox  ◀IPC▶ sessions · pipeline · role config│
│                                       ├ OpenCode client + event stream ──┼──▶ local OpenCode service
│                                       ├ Jira MCP client (Revva OAuth) ───┼──▶ Atlassian MCP
│                                       ├ AWS SSO + optional proxy manager │
│                                       ├ git / gh / optional gh-stack     │
│                                       └ local SQLite + OS secure storage│
└─────────────────────────────────────────────────────────────────────────┘

OpenCode owns session execution, configured agents/models/providers, skills,
permissions, and tool execution. Revva discovers that inventory at runtime.
```

Principle: **revva never re-implements agent execution.** Everything the agent does (code, tools, subagents, skills) happens in opencode sessions. revva owns *orchestration state* (which ticket is in which phase), *Jira I/O*, *AWS readiness*, *general-session management*, and *UI*. General chats are ordinary OpenCode sessions without ticket/pipeline metadata.

## 2. Process boundaries

### Main process (`src/main/`)
All privileged work. Subsystems:

| Module | Responsibility |
| --- | --- |
| `opencode/service.ts` | `Service.ensure()` from `@opencode/client/service` → endpoint + auth headers. Reconnect/backoff. Publishes `service.status`. |
| `opencode/bus.ts` | One `client.event.subscribe()` SSE stream; demultiplexes to typed EventEmitter. Reconnect + full resync (re-fetch sessions/forms/permissions) on stream loss — subscriptions are live-only, no replay. |
| `opencode/sessions.ts` | Create ticket/general sessions with location, selected agent + model, and appropriate metadata; send prompts/commands/skill activations; fetch messages; idle detection. |
| `opencode/roles.ts` | Discover agents/models live and apply configurable role defaults/overrides (implementer, grill, each reviewer, rework, general chat). |
| `jira/mcp.ts` | Streamable-HTTP MCP client for Atlassian (see §4). Revva-owned OAuth onboarding/token refresh; credentials in OS-backed secure storage. |
| `jira/board.ts` | JQL: current sprint + assignee. Maps issues → `Ticket` DTO (key, summary, status, story points, **link: blocks/is blocked by** for dependency detection). |
| `jira/watcher.ts` | Poll loop (default 5 min) over "shipped" tickets; new/updated comments by others that are unresolved → `CommentAlert`. Watermark persisted. |
| `git/worktree.ts` | Prefer opencode `POST /api/worktree`; fall back to `git worktree add`. Naming/location come from user settings. Dependent tickets: `from` = parent ticket's branch. |
| `pipeline/` | The state machine (§PIPELINE.md) + one `PhaseRunner` per phase. Persisted transitions; crash-safe resume on app start. |
| `pipeline/auto.ts` | AUTO policy: answer safe/recommended structured questions, record assumptions, apply the configured permission boundary, and advance to automatic PR delivery when gates pass. |
| `review/` | sol-loop round runner, test-audit runner, impeccable runner (see §6). |
| `ship/` | `gh pr create`/`gh stack submit`, Jira transition + summary comment. |
| `scripts.ts` | User one-click shell scripts (name + command/alias, optional cwd) run via interactive zsh with live output, kill, history. Also probes whether loopback endpoints referenced by provider base URLs are listening (drives model gating). Revva contains no AWS/SSO/proxy logic — users paste their own scripts (e.g. `morning`). |
| `chat/` | Create/list/reopen general OpenCode sessions; role/model/skill selection; transcript, follow-up prompts, interrupt, questions/permissions. No Jira association. |
| `db/` | better-sqlite3 under Electron's platform-specific `app.getPath('userData')`; no hard-coded home-directory path. |

### Preload (`src/preload/`)
Single namespaced `window.revva` API mirroring main IPC channels (`revva:board:refresh`, `revva:work:start`, `revva:form:reply`, …). All payloads typed from `src/shared/types.ts` (zod schemas, IPC-validated on both ends). No raw IPC in renderer.

### Renderer
React + TanStack Query (server state = snapshots pulled via IPC, invalidated by event pushes) + Tailwind. Views: **Board**, **Cockpit** (per ticket), **Chat** (general sessions), **Inbox** (global questions/permissions), **Settings/Setup**.

## 3. opencode API surface revva uses (verified against `/v2/openapi.json`, server 2.0.30)

| Need | Endpoint |
| --- | --- |
| Attach to service | `@opencode/client/service` `Service.ensure()` / `discover()`; `Service.headers()` |
| Create ticket or general session | `POST /api/session` `{location:{directory}, agent?, model:{providerID,id}, metadata, permissions?}`; general chats omit ticket/workflow metadata |
| Drive it | `POST /api/session/{id}/prompt` `{text, skills?, delivery?}`; `POST …/command {name,text}` for slash commands (`/grill-me`) |
| Activate a skill directly | `POST /api/experimental/session/{id}/skill {id}` |
| Stream transcript | `GET /api/event` (SSE; filter `message.*`, `session.idle`, `form.*`, `permission.*` types client-side) + `GET /api/session/{id}/message` for history |
| **Pending questions** | `GET /api/form` (all pending, location-scoped) + `GET /api/session/{id}/form`; answer `POST /api/session/{id}/form/{formID}/reply {answer}` |
| Permission prompts | `GET /api/permission/request`; `POST /api/session/{id}/permission/{requestID}/reply {reply:"once"|"always"|"reject"}` |
| Idle / completion | `session.idle` events; `POST /api/experimental/session/{id}/wait` for blocking phase waits |
| Interrupt / fork | `POST …/interrupt`, `POST …/fork` (used by rework on already-merged work) |
| Worktrees | `POST /api/worktree {projectID, from?, branch?, directory?, name?}`; `GET /api/worktree` |
| Models/agents/skills listing | `GET /api/model`, `/api/agent`, `/api/skill` |
| Diff view | `GET /api/vcs/diff`, `GET /api/session/{id}/diff` |

Gotchas (documented in code):
- SSE is **live-only** — on reconnect, revva re-fetches forms/permissions/messages per active session before applying events.
- `GET /api/form` is *location-scoped* → the inbox polls per-location across active ticket worktrees and general chat locations.
- Sessions from a non-TUI origin: set `metadata.revva.*` so revva can reconstruct state after restart (`GET /api/session` list + metadata filter).

## 4. Jira via Atlassian MCP

- Endpoint `https://mcp.atlassian.com/v1/mcp`, `Authorization: Bearer <accessToken>`, `Accept: application/json, text/event-stream`, Streamable-HTTP session (`initialize` → `mcp-session-id` header on subsequent calls).
- Authentication: Revva provides its own supported OAuth onboarding/refresh flow and stores tokens in OS-backed secure storage. Do not read/copy/write `~/.local/share/opencode/mcp-auth.json` or depend on another app's OAuth client. If MCP OAuth is unavailable in a supported deployment, allow the explicit Jira REST/API-token alternative. If auth expires, show a reconnect action in Settings.
- **Risk (earlier probe, mitigated):** a naive non-browser HTTP client once hit Cloudflare 1010. Re-probed 2026-10-28 with MCP headers (`Accept: application/json, text/event-stream` + `initialize` JSON-RPC): endpoint answers **401 unauthenticated** — reachable. OAuth discovery works (`/v1/authorize`, `/v1/token`) and **dynamic client registration works** (`POST /v1/register` → client_id, PKCE, `token_endpoint_auth_method: none`), so Revva owns its OAuth onboarding with a loopback redirect + `safeStorage` token store. **Plan B** if ever blocked again: REST v3 + API token behind the same `jira/api.ts` interface.
- At connection time, discover the actual MCP tool inventory and map supported capabilities (search/JQL, issue details, comments, transitions, user info) behind a stable Revva interface; do not assume every Atlassian deployment exposes identical tool names.
- JQL: `project in (...) AND sprint in openSprints() AND assignee = currentUser() AND statusCategory != Done`; refresh on window focus + every 5 min.
- Dependencies: issue links (`Blocks`) → `dependsOn: [KEY]`. Board cards show a chain badge; "Start work" on a dependent ticket offers *branch from parent worktree/branch* when the parent work exists, else warns and branches from default.

## 5. Data model (revva.db)

```sql
settings(key TEXT PK, value JSON)                 -- workspace roots, Jira, pollSecs, AWS config, misc
roleConfig(role PK, agentID, providerID, modelID) -- role defaults; run overrides snapshot to each session
workspace(id PK, path, defaultBaseBranch)         -- folders the user allows revva to target (Settings → "Add folder")
ticket(key PK, jiraId, summary, status, statusCategory, points, dependsOn JSON, raw JSON, syncedAt)
work(id PK, ticketKey, workspaceId, repoDir, branch, worktreeDir, parentWorkId NULL,
     mode 'interactive'|'auto', state TEXT, createdAt, updatedAt)
chat(sessionId PK, title, location, agentID, providerID, modelID, createdAt, updatedAt)
phase(workId, node TEXT, status, startedAt, endedAt, detail JSON, PK(workId,node))
question(id PK, workId NULL, sessionId, formId, kind 'form'|'permission', title JSON,
     state 'pending'|'answered'|'rejected', answeredBy, createdAt, answeredAt)  -- full audit trail; live = state='pending'
reviewRun(id PK, workId, kind 'sol-loop'|'test-audit'|'impeccable', round, sessionId,
     agentID, providerID, modelID, verdict NULL, ledger JSON, startedAt, endedAt)
autoDecision(id PK, workId, sessionId NULL, kind, input JSON, choice JSON,
     rationale TEXT, state, createdAt)                        -- choices, assumptions, pauses, delivery events
commentWatch(ticketKey PK, watermark TEXT, lastCheckedAt)      -- watcher state
commentAlert(id PK, ticketKey, commentId, author, body, seenAt, handledAt NULL)
ship(workId PK, prUrl, prNumber, stackJson JSON, jiraTransition TEXT, shippedAt)
```

Single source of truth for "which agent session belongs to which ticket/phase": the `phase` table (sessions also self-describe via `metadata.revva` for rebuild).

## 6. Review pipeline design (PIPELINE.md has the state machine)

Sequential phases (build, grill, ship) use a single-session runner. Parallel reviews use a batch runner:

```ts
interface ReviewBatchRunner {
  start(work: Work, roles: ReviewerRole[]): Promise<ReviewSession[]> // launch all applicable child sessions concurrently
  collect(work: Work, sessions: ReviewSession[]): Promise<ReviewResult[]> // wait for all; errors remain incomplete
  onBatchComplete(work: Work, results: ReviewResult[]): Promise<Next> // consolidate → fix → re-review | human | ship
}
```

- **Role selection:** `GET /api/agent` and `GET /api/model` populate selectors. Persist a default agent/model per role; permit per-run overrides. Agent and model are selectable independently where OpenCode supports that combination. Revalidate against the live inventory at run time; never silently swap a missing choice.
- **Parallel fan-out per review round:** create OpenCode child/subagent sessions concurrently (set `parentID` to the implementation session where supported): (1) one Sol-loop reviewer, (2) a test-audit reviewer, and (3) an impeccable reviewer only if the diff has UI. Each role uses its saved default or per-run agent/model choice. Reviewers do not edit files or start other reviewers. The Sol loop has **one reviewer per round**, not multiple Sol reviewers.
- **sol-loop**: vendored skill at `revva/skills/sol-loop` (from t3dotgg/tstack), adapted from T3 delegation to a dedicated OpenCode reviewer session. The user may select GPU Qwen, GPT-6 Sol, or any other available agent/model for this role; the skill behavior is the review protocol, not a forced model identity. Prompt = Round-1 brief (base sha, intent, checks). Default maximum 3 rounds (up to 5 only for the skill's stated high-risk cases or user request); ledger per finding. A separate fixer session applies the consolidated findings after all reviewers finish.
- **test-audit**: independent reviewer session with the skill activated if installed/available; its agent/model is independently configurable. If missing, mark the gate unavailable and ask whether to install/continue; never report it as passed.
- **impeccable**: independent reviewer session when changed files/UI signal indicates UI work; agent/model independently configurable. Policy configurable (warn/block).
- **Fan-in and re-review:** wait for every applicable reviewer result; errors/timeouts are not approvals. Consolidate/dedupe findings, then one fixer handles them. Launch applicable reviewers concurrently again when behavior changes or blocker/should findings remain, subject to bounded budgets. Preserve each subagent's chosen agent/model, verdict, output, and round in the ledger. Do not allow concurrent reviewers to edit the same worktree.

## 7. AUTO mode policy

- AUTO is an explicit per-ticket-run mode (optionally prechecked from a user preference); display a persistent badge and save the mode on the work record.
- The agent prompt directs the chosen role to pursue the ticket's acceptance criteria, prefer an explicit recommendation, otherwise choose a conservative option consistent with repo conventions, and report assumptions. Revva may answer structured forms using those recommendations/context and records every selection in `autoDecision`.
- AUTO proceeds through the same required fan-out reviews and checks as Interactive mode; it does **not** skip gates. The fixer makes one consolidated correction pass before applicable concurrent re-review.
- When gates pass, Revva's ship coordinator pushes the branch and creates/opens the PR without a separate confirmation. Jira transition/comment actions follow explicit user settings. AUTO never merges.
- Use a separate, configurable least-privilege permission profile for AUTO sessions. Routine edits/tests stay within the selected worktree. Do not auto-grant out-of-root access, secret access/disclosure, destructive git/data-loss operations, force-push, or merge.
- Pause in `WAITING_HUMAN` only for a real blocker: ambiguous intent with materially different outcomes, missing credentials/tools, a required reviewer/check error, unresolved/disputed blocker, or an action outside the configured permission policy. Present one concise blocking question with evidence and the recommended choice; do not send routine progress pings.
- AUTO does not apply to general chats, which have no ticket or PR lifecycle. Chat sessions use ordinary OpenCode permissions and answer flows.

## 8. Question inbox

- Live pending = `GET /api/form` + `GET /api/permission/request` unioned across active locations, plus SSE pushes.
- Inbox view groups by ticket with jump-to-cockpit; answering posts the reply and records it in `question`.
- The cockpit also shows the pending question inline at the bottom of the transcript.

## 9. Scripts (user one-click commands)

- Users define scripts in Revva: name, shell command or alias, optional working directory, interactive-shell toggle (loads .zshrc so aliases/functions work). Run/kill with live streamed output, last exit/duration, run history in sqlite.
- Revva models nothing about what scripts do — no AWS/SSO/proxy/SigV4 code. The earlier "built-in Morning" design was dropped as overengineering; the user's own `morning` alias is just a Script.
- Providers whose `settings.baseURL` points at a loopback endpoint (e.g. a local proxy started by a user script) get their models grayed out in pickers while the port is not listening, with an explanation. The gate is per-provider and never blocks other providers or chat.

## 10. Security & safety

- Renderer: `contextIsolation`, no `nodeIntegration`, CSP. All fs/exec in main behind typed IPC with zod validation.
- Secrets (Atlassian OAuth tokens, optional PAT, and any AWS secret material) via Electron `safeStorage`/OS credential store. Do not log secrets.
- Agent permissions: worktrees are user-selected; reviewer sessions get explicit deny-edit permission rulesets; destructive git actions require confirmation.
- revva performs `git`/`gh` only where stated (worktree add, fetch, PR create, stack submit) — never force-push, never merge.
