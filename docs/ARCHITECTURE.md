# revva — Architecture

## 1. Big picture

```
┌───────────────────────────── Electron app ─────────────────────────────┐
│                                                                         │
│  Renderer (React)                    Main process ("engine")            │
│  ┌───────────────┐  contextBridge   ┌────────────────────────────────┐ │
│  │ Board          │ ◀── IPC (typed) ─▶│ Pipeline orchestrator         │ │
│  │ Cockpit        │                  │  ├─ opencode client ───────────────▶ opencode background
│  │ Question inbox │                  │  │   (@opencode/client, SSE)   │ │   service (shared,   ─┐
│  │ Settings       │                  │  ├─ jira (Atlassian MCP) ───────────▶ mcp.atlassian.com  │
│  └───────────────┘                  │  ├─ git (worktrees) / gh      │ │   (OAuth via cached   │
│                                      │  ├─ morning (Terminal.app)   │ │    token + refresh)   │
│                                      │  └─ sqlite (revva.db)        │ │                       │
│                                      └────────────────────────────────┘ │                       │
└─────────────────────────────────────────────────────────────────────────┘                       │
                                                                                                   ▼
                                                                        opencode service owns: sessions, agents,
                                                                        skills, subagents, providers (gpu-poc,
                                                                        amazon-bedrock), permissions, worktrees
```

Principle: **revva never re-implements agent execution.** Everything the agent does (code, tools, subagents, skills) happens in opencode sessions. revva owns *orchestration state* (which ticket is in which phase), *Jira I/O*, and *UI*.

## 2. Process boundaries

### Main process (`src/main/`)
All privileged work. Subsystems:

| Module | Responsibility |
| --- | --- |
| `opencode/service.ts` | `Service.ensure()` from `@opencode/client/service` → endpoint + auth headers. Reconnect/backoff. Publishes `service.status`. |
| `opencode/bus.ts` | One `client.event.subscribe()` SSE stream; demultiplexes to typed EventEmitter. Reconnect + full resync (re-fetch sessions/forms/permissions) on stream loss — subscriptions are live-only, no replay. |
| `opencode/sessions.ts` | Create sessions with `{location:{directory: worktreePath}, model, metadata:{revvaTicket, revvaRole}}`; send prompts/commands/skill activations; fetch messages; idle detection. |
| `jira/mcp.ts` | Streamable-HTTP MCP client for Atlassian (see §4). Token loading + refresh from `~/.local/share/opencode/mcp-auth.json` (own copy in Keychain if the file shape changes). |
| `jira/board.ts` | JQL: current sprint + assignee. Maps issues → `Ticket` DTO (key, summary, status, story points, **link: blocks/is blocked by** for dependency detection). |
| `jira/watcher.ts` | Poll loop (default 5 min) over "shipped" tickets; new/updated comments by others that are unresolved → `CommentAlert`. Watermark persisted. |
| `git/worktree.ts` | Prefer opencode `POST /api/worktree`; fall back to `git worktree add`. Naming `<worktreesRoot>/<KEY>-<slug>`, branch `<prefix>/<KEY>-<slug>` (matches existing `.worktrees/CLN-128750-*` convention). Dependent tickets: `from` = parent ticket's branch. |
| `pipeline/` | The state machine (§PIPELINE.md) + one `PhaseRunner` per phase. Persisted transitions; crash-safe resume on app start. |
| `review/` | sol-loop round runner, test-audit runner, impeccable runner (see §6). |
| `ship/` | `gh pr create`/`gh stack submit`, Jira transition + summary comment. |
| `morning/` | AppleScript `osascript` → open Terminal.app running `zsh -ic morning`; readiness = TCP probe `127.0.0.1:57777` + `~/.aws/credentials` mtime + `aws sts get-caller-identity` cache. |
| `db/` | better-sqlite3 at `~/Library/Application Support/revva/revva.db`. |

### Preload (`src/preload/`)
Single namespaced `window.revva` API mirroring main IPC channels (`revva:board:refresh`, `revva:work:start`, `revva:form:reply`, …). All payloads typed from `src/shared/types.ts` (zod schemas, IPC-validated on both ends). No raw IPC in renderer.

### Renderer
React + TanStack Query (server state = snapshots pulled via IPC, invalidated by event pushes) + Tailwind. Views: **Board**, **Cockpit** (per ticket), **Inbox** (global questions/permissions), **Settings**.

## 3. opencode API surface revva uses (verified against `/v2/openapi.json`, server 2.0.30)

| Need | Endpoint |
| --- | --- |
| Attach to service | `@opencode/client/service` `Service.ensure()` / `discover()`; `Service.headers()` |
| Create per-role session | `POST /api/session` `{location:{directory}, model:{providerID,id}, metadata, permissions?}` |
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
- `GET /api/form` is *location-scoped* → the inbox polls per-location across all worktrees of active works (cheap, only active sessions' locations).
- Sessions from a non-TUI origin: set `metadata.revva.*` so revva can reconstruct state after restart (`GET /api/session` list + metadata filter).

## 4. Jira via Atlassian MCP

- Endpoint `https://mcp.atlassian.com/v1/mcp`, `Authorization: Bearer <accessToken>`, `Accept: application/json, text/event-stream`, Streamable-HTTP session (`initialize` → `mcp-session-id` header on subsequent calls).
- Tokens: read `~/.local/share/opencode/mcp-auth.json` (`atlassian.tokens.{accessToken, refreshToken, expiresAt}`) + `clientInfo.clientId`; refresh against Atlassian's token endpoint when expired. If refresh fails, Settings shows "re-authenticate in opencode (`/mcps`)". revva writes back the refreshed token (best-effort, keep in sync) and keeps its own copy via Electron `safeStorage`.
- **Risk (observed):** a naive non-browser HTTP client hit a Cloudflare 1010 on the MCP endpoint. Mitigation: use `@modelcontextprotocol/sdk`'s StreamableHTTP client from Node (same class of client opencode itself uses successfully) with its default headers. **Plan B** if ever blocked: switch `jira/` to plain REST v3 with an email + API token stored in Keychain — the `jira/api.ts` interface keeps this swappable.
- Tools used (names verified at runtime by `tools/list`; wrapped behind a capability map, not hardcoded everywhere): Rovo `search`, issue get, comment list/add, comment resolve, issue transition, user info.
- JQL: `project in (...) AND sprint in openSprints() AND assignee = currentUser() AND statusCategory != Done`; refresh on window focus + every 5 min.
- Dependencies: issue links (`Blocks`) → `dependsOn: [KEY]`. Board cards show a chain badge; "Start work" on a dependent ticket offers *branch from parent worktree/branch* when the parent work exists, else warns and branches from default.

## 5. Data model (revva.db)

```sql
settings(key TEXT PK, value JSON)                 -- workspacesRoot, worktreesRoot, jql, pollSecs, modelPresets…
workspace(id PK, path, defaultBaseBranch)         -- folders the user allows revva to target (Settings → "Add folder")
ticket(key PK, jiraId, summary, status, statusCategory, points, dependsOn JSON, raw JSON, syncedAt)
work(id PK, ticketKey, workspaceId, repoDir, branch, worktreeDir, parentWorkId NULL,
     state TEXT, createdAt, updatedAt)             -- state = pipeline node (PIPELINE.md)
phase(workId, node TEXT, status, sessionId NULL, startedAt, endedAt, detail JSON, PK(workId,node))
question(id PK, workId, sessionId, formId, kind 'form'|'permission', title JSON,
     state 'pending'|'answered'|'rejected', answeredBy, createdAt, answeredAt)  -- full audit trail; live = state='pending'
reviewRun(id PK, workId, kind 'sol-loop'|'test-audit'|'impeccable', round, sessionId,
     verdict NULL, ledger JSON, startedAt, endedAt)
commentWatch(ticketKey PK, watermark TEXT, lastCheckedAt)      -- watcher state
commentAlert(id PK, ticketKey, commentId, author, body, seenAt, handledAt NULL)
ship(workId PK, prUrl, prNumber, stackJson JSON, jiraTransition TEXT, shippedAt)
```

Single source of truth for "which agent session belongs to which ticket/phase": the `phase` table (sessions also self-describe via `metadata.revva` for rebuild).

## 6. Review pipeline design (PIPELINE.md has the state machine)

Phase runners all follow the same contract:

```ts
interface PhaseRunner {
  start(work: Work): Promise<{ sessionId: string }>   // create session, seed prompt
  onComplete(work: Work, sessionId: string): Promise<Next>  // parse verdict → next node | loop | human
}
```

- **sol-loop**: vendored skill at `revva/skills/sol-loop` (from t3dotgg/tstack), adapted: the T3 `delegate_task` section is replaced with "you are the Sol reviewer subagent" — revva creates a **reviewer session on `amazon-bedrock/openai.gpt-6.1-sol`** (Bedrock readiness required; else falls back to `gpu-poc/qwen3.8-flash-next` with a warning, since the loop is model-agnostic) with `permissions` denying `edit`/`write`, `location.directory = worktree`. Prompt = the skill's Round-1 brief (base sha from `git merge-base`, intent from ticket summary + phase notes, checks output). Round loop ≤3 per skill budget; ledger kept in `reviewRun.ledger`; a separate **fixer session** (main model) applies agreed findings between rounds. Stop conditions per skill: APPROVE with no blocker/should open, or escalate to user when disputed.
- **test-audit**: reviewer session, skill `test-audit` activated via `POST …/skill`; findings handed to same fixer loop (bounded 2 rounds).
- **impeccable**: triggers when the diff touches `*.{tsx,jsx,vue,css,html}` or ticket label `ui`. Reviewer session with `impeccable` skill; findings optional-gate (configurable: warn | block).
- Runners run **sequentially** (sol-loop → test-audit → impeccable) by default — parallel is a later option; sequential keeps a single fixer authority and matches the sol-loop "don't grow the diff" rule.

## 7. Question inbox

- Live pending = `GET /api/form` + `GET /api/permission/request` unioned across active locations, plus SSE pushes.
- Inbox view groups by ticket with jump-to-cockpit; answering posts the reply and records it in `question`.
- The cockpit also shows the pending question inline at the bottom of the transcript.

## 8. Morning / Bedrock readiness

- Button → `osascript -e 'tell app "Terminal" to do script "cd ~/workspace && zsh -ic morning"'` (interactive SSO happens in Terminal, per user decision).
- Readiness probe (10 s loop): TCP `127.0.0.1:57777` open **and** `~/.aws/credentials` `[default]` section parses & unexpired (best-effort via `aws sts get-caller-identity`, 5-min cache).
- UI: status chip in the titlebar (● red / ● pulsing amber "SSO in Terminal…" / ● green "Bedrock ready"). Bedrock model presets disabled with tooltip when not ready.

## 9. Security & safety

- Renderer: `contextIsolation`, no `nodeIntegration`, CSP. All fs/exec in main behind typed IPC with zod validation.
- Secrets (Atlassian token copy, any PAT) via Electron `safeStorage` (macOS Keychain).
- Agent permissions: worktree dirs already in the user's global allowlist (`~/workspace-worktrees/**`); reviewer sessions get explicit deny-edit permission rulesets; `git clean/reset --hard` remain "ask" via the user's own opencode config.
- revva performs `git`/`gh` only where stated (worktree add, fetch, PR create, stack submit) — never force-push, never merge.
