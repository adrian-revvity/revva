# revva

A local Electron desktop app that turns your Jira sprint into shipped, reviewed pull requests — driven by **opencode** sessions you control from one cockpit.

```
Jira sprint board ──▶ pick tickets ──▶ worktree + branch per ticket
        │                                    │
        │                              spin up opencode agent
        │                            (Qwen / GPU cluster, or Bedrock Sol / Luna)
        │                                    │
        │        ┌───────────────────────────┼───────────────────────────┐
        │        ▼                           ▼                           ▼
        │  /grill-me intake          main coding session        review loops
        │  (optional)                streaming output view      (sol-loop ×N, /test-audit,
        │        │                   answer pending questions   /impeccable when UI)
        │        └───────────┬───────────────────────────────────────────┘
        │                    ▼
        └── status/comment ◀── PR + gh-stack + Jira transition
             sync ◀────────── "tackle new comments" rework agent
```

## What it does (feature list)

1. **Sprint board** — fetches Jira issues assigned to you in the current sprint (via the Atlassian MCP server, reusing your existing opencode OAuth token).
2. **Start work** — creates a git worktree + branch per ticket in a workspace folder you pick (configurable, e.g. `~/workspace-worktrees`), optionally **branching from another ticket's branch** (stacked work).
3. **Optional `/grill-me` phase** — before coding, a subagent session grills you about the ticket until the plan is solid; its output seeds the coding prompt.
4. **Agent runner** — creates opencode sessions via the OpenCode HTTP API with a model picker: `gpu-poc/qwen3.8-flash-next` (GPU cluster) or `amazon-bedrock/openai.gpt-*-sol|luna|...`.
5. **Morning button** — spawns the `morning` flow (AWS SSO login + Bedrock SigV4 proxy) in Terminal.app; revva shows live "Bedrock ready" status by probing port `:57777` and AWS creds.
6. **Ticket cockpit** — click a ticket → live agent output (streaming text, tool calls, costs), subagent runs, and diffs.
7. **Question inbox** — global view of every **pending form (question)** and **permission request** across all revva sessions; answer inline without leaving the app.
8. **Review pipeline** — when the agent finishes, revva automatically runs:
   - `sol-loop` (vendored skill) — Sol/Bedrock reviewer subagent, up to 3 rounds, ledger-tracked;
   - `/test-audit` — test audit subagent;
   - `/impeccable` — UI review pass, only when the diff touches UI files (heuristic + flag).
9. **Ship** — create + open the PR (`gh`), stack it with `gh-stack` when the ticket depends on another, transition the Jira issue and post a summary comment.
10. **Comment watcher** — polls Jira for unresolved comments on shipped tickets; a **"Tackle comments"** button spins up a rework agent that fixes the feedback, answers + resolves the comments, and requests re-review (re-entering the review pipeline).

## What it is not

Not a server platform. No Vercel/Neon, no sandboxes, no second agent runtime. revva is a thin, local **cockpit over opencode** — opencode owns sessions, providers, skills, subagents, permissions, and config (your existing `~/.config/opencode/opencode.jsonc` with `gpu-poc`, `amazon-bedrock`, `kimi-bedrock` works unchanged).

## Stack

- **Electron + electron-vite + React + TypeScript + Tailwind** — desktop shell and UI.
- **`@opencode/client`** (official TS client) + `@opencode/client/service` — discovers/starts the opencode background service and drives it over HTTP/SSE. revva does **not** spawn opencode per-session; it attaches to your shared service (`opencode api get /api/info` today returns `http://127.0.0.1:49374` — same mechanism).
- **Atlassian MCP over Streamable HTTP** — revva talks JSON-RPC to `https://mcp.atlassian.com/v1/mcp` using the OAuth tokens already stored in `~/.local/share/opencode/mcp-auth.json` (with refresh). No new Jira credentials.
- **better-sqlite3** — revva's own state: tickets↔sessions↔branches map, review ledgers, comment-watch watermarks, settings.
- **child_process / AppleScript** — Terminal.app spawn for `morning`, `gh`/`gh stack`/`git` invocations.

## Repo layout

```
revva/
├── package.json               # pnpm workspace root (single package is fine at first)
├── electron.vite.config.ts
├── src/
│   ├── main/                  # Electron main process = the "engine"
│   │   ├── opencode/          #   service discovery, client singleton, event bus (SSE)
│   │   ├── jira/              #   Atlassian MCP client, JQL queries, comment watcher
│   │   ├── git/               #   worktrees, branches, dependency chains
│   │   ├── pipeline/          #   state machine: intake→grill→build→review→ship→rework
│   │   ├── review/            #   sol-loop / test-audit / impeccable orchestrators
│   │   ├── ship/              #   gh, gh-stack, Jira transitions
│   │   ├── morning/           #   Terminal.app spawn + readiness probes
│   │   └── db/                #   better-sqlite3 schema + repositories
│   ├── preload/               # typed contextBridge API surface (one `revva` global)
│   └── renderer/              # React UI
│       ├── board/             #   sprint board (columns, cards, dependency badges)
│       ├── cockpit/           #   per-ticket view: transcript, diff, phases, questions
│       ├── inbox/             #   global questions & permissions inbox
│       └── settings/          #   workspace folders, JQL, models, poll interval
├── skills/
│   └── sol-loop/SKILL.md      # vendored from t3dotgg/tstack (adapted for opencode)
└── docs/
    ├── ARCHITECTURE.md        # components, API surface used, data model
    ├── PIPELINE.md            # the ticket state machine in detail
    └── MILESTONES.md          # build order M0–M7, each shippable
```

## Key integration facts (verified on this machine, 2026-10-28)

| Fact | Evidence |
| --- | --- |
| opencode v2.2.0 background service with HTTP API | `opencode api get /api/info` → `{"version":"2.0.30","urls":["http://127.0.0.1:49374"],...}` |
| Pending agent questions = **forms**: `GET /api/form`, answer `POST /api/session/{id}/form/{formID}/reply` | OpenAPI `/v2/openapi.json` |
| Permission prompts: `GET /api/permission/request`, reply `POST /api/session/{id}/permission/{requestID}/reply` | same |
| Skills can be invoked over the API: `POST /api/experimental/session/{id}/skill {id}`; prompt endpoint also accepts `skills:[{id,name}]` | same |
| Commands (`/grill-me`) over API: `POST /api/session/{id}/command {name,text}` | same |
| Worktree API: `POST /api/worktree {projectID, from, branch, directory}` | same |
| Model selection per session: `session.create({model:{providerID,id}, location:{directory}})` | same |
| Streaming transcript: `GET /api/event` (SSE) + `GET /api/session/{id}/message` | same |
| Atlassian MCP token available | `~/.local/share/opencode/mcp-auth.json` → `atlassian.tokens.accessToken` for `https://mcp.atlassian.com/v1/mcp` |
| `morning` = zsh function: `useaws.py --login` + SigV4 proxy on `127.0.0.1:57777` | `~/.zshrc` |
| Providers configured | `~/.config/opencode/opencode.jsonc`: `gpu-poc` (qwen3.8-flash-next, glm-5.3-flash), `amazon-bedrock` (sol/luna/terra/astra), `kimi-bedrock` |
| Skills installed | `~/.agents/skills/`: grill-me, test-audit, impeccable, gh-stack ✓; **sol-loop ✗ — vendor it** |
| `gh stack` extension v0.1.1 installed | `gh extension list` |
| Existing worktree convention | `~/workspace/.worktrees/CLN-128750-...`, permission allowlist for `~/workspace-worktrees/**` |

## Build order

See [docs/MILESTONES.md](docs/MILESTONES.md). Each milestone is independently usable; M0+M1 already give you a "board + agent + watch" daily driver.
