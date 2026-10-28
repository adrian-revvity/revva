# revva

A local Electron desktop app that turns your Jira sprint into shipped, reviewed pull requests — driven by **opencode** sessions you control from one cockpit.

```
Jira sprint board ──▶ pick tickets ──▶ worktree + branch per ticket
        │                                    │
        │                              spin up opencode agent
        │                            (examples only; discover user's models)
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

1. **Sprint board** — fetches Jira issues assigned to you in the current sprint (via the Atlassian MCP server, using Revva's own Jira connection).
2. **Start work** — creates a git worktree + branch per ticket in a workspace folder you pick (configurable, e.g. `~/workspace-worktrees`), optionally **branching from another ticket's branch** (stacked work).
3. **Optional `/grill-me` phase** — before coding, a subagent session grills you about the ticket until the plan is solid; its output seeds the coding prompt.
4. **Agent/model picker** — discover every configured OpenCode agent and model. Set defaults by role and override per run: implementation, Sol-loop, test audit, UI review, grill-me, rework, and general chat.
5. **Scripts** — add your own one-click shell scripts (aliases work; runs in interactive zsh), e.g. your `morning` AWS/SSO/proxy routine. Revva just runs them and shows live output; it ships no AWS-specific logic. Models whose provider needs a local endpoint are grayed out until that port is listening.
6. **General chat** — a global **New Chat** action starts a normal OpenCode session with a chosen workspace directory, agent, model, and optional skills, with no Jira ticket or delivery pipeline required.
7. **Ticket cockpit** — click a ticket → live agent output (streaming text, tool calls, costs), subagent runs, and diffs.
8. **Question inbox** — global view of every **pending form (question)** and **permission request** across Revva sessions; answer inline without leaving the app.
9. **Parallel review pipeline** — when implementation finishes, revva fans out independent read-only subagent reviews concurrently: the sol-loop protocol, `/test-audit`, and `/impeccable` when UI is involved. Each reviewer can use its configured default or a per-run-selected OpenCode agent/model. Findings are consolidated for a fixer; changed code is then re-reviewed in parallel within bounded rounds.
10. **Ship** — create + open the PR (`gh`), stack it with `gh-stack` when the ticket depends on another, transition the Jira issue and post a summary comment.
11. **AUTO mode** — opt into a run that chooses recommended/safe options, minimizes routine questions, completes implementation and parallel reviews, and pushes/opens the PR automatically when gates pass. It pauses on genuine blockers or unsafe requests and never merges.
12. **Comment watcher** — polls Jira for unresolved comments on shipped tickets; a **"Tackle comments"** button spins up a rework agent that fixes the feedback, answers + resolves the comments, and requests re-review (re-entering the review pipeline).

## What it is not

Not a server platform. No Vercel/Neon, no sandboxes, no second agent runtime. revva is a local **cockpit over opencode**. It discovers each user's OpenCode models, agents, skills, and configuration; it does not assume the providers or files currently configured on the original developer's machine.

## Stack

- **Electron + electron-vite + React + TypeScript + Tailwind** — desktop shell and UI.
- **shadcn/ui** — component library for the renderer. Prefer existing components and compositions before creating custom UI; shadcn skill + MCP are configured for development (see [docs/FRONTEND.md](docs/FRONTEND.md)).
- **`@opencode/client`** (official TS client) + `@opencode/client/service` — discovers/starts the opencode background service and drives it over HTTP/SSE. revva does **not** spawn opencode per-session; it attaches to your shared service (`opencode api get /api/info` today returns `http://127.0.0.1:49374` — same mechanism).
- **Atlassian MCP over Streamable HTTP** — connect through Revva's own onboarding/OAuth flow and keep credentials in OS secure storage; optional documented REST/API-token fallback. Never depend on another app's private token-cache file.
- **better-sqlite3** — revva's own state: tickets↔sessions↔branches map, review ledgers, comment-watch watermarks, settings.
- **Built-in AWS readiness manager** — orchestrates AWS CLI v2 SSO login in-app and manages any required bundled local SigV4 proxy; no user's shell function or custom Python script.
- **child_process** — feature-detected `aws`, `gh`, `gh stack`, and `git` operations with in-app status/errors; no AppleScript dependency.

## Repo layout

```
revva/
├── package.json               # pnpm workspace root (single package is fine at first)
├── electron.vite.config.ts
├── components.json             # shadcn/ui project configuration (created in M0)
├── opencode.json               # project-local shadcn MCP for development
├── skills-lock.json            # pinned source metadata for project skills
├── .agents/skills/shadcn/      # project-local shadcn skill
├── src/
│   ├── main/                  # Electron main process = the "engine"
│   │   ├── opencode/          #   service discovery, client singleton, event bus (SSE)
│   │   ├── jira/              #   Atlassian MCP client, JQL queries, comment watcher
│   │   ├── git/               #   worktrees, branches, dependency chains
│   │   ├── pipeline/          #   state machine: intake→grill→build→review→ship→rework
│   │   ├── review/            #   sol-loop / test-audit / impeccable orchestrators
│   │   ├── ship/              #   gh, gh-stack, Jira transitions
│   │   ├── scripts.ts         #   user one-click scripts (aliases, e.g. morning) + endpoint probes
│   │   ├── chat/              #   general, non-ticket OpenCode sessions
│   │   └── db/                #   better-sqlite3 schema + repositories
│   ├── preload/               # typed contextBridge API surface (one `revva` global)
│   └── renderer/              # React UI
│       ├── board/             #   sprint board (columns, cards, dependency badges)
│       ├── cockpit/           #   per-ticket view: transcript, diff, phases, questions
│       ├── chat/              #   general chats and New Chat flow
│       ├── inbox/             #   global questions & permissions inbox
│       └── settings/          #   workspace folders, Jira, AWS profile/region, role defaults
├── skills/
│   └── sol-loop/SKILL.md      # vendored from t3dotgg/tstack (adapted for opencode)
└── docs/
    ├── REQUIREMENTS.md        # reusable product/setup requirements and acceptance criteria
    ├── FRONTEND.md            # shadcn/ui choice, reuse-first policy, and component map
    ├── ARCHITECTURE.md        # components, API surface used, data model
    ├── PIPELINE.md            # the ticket state machine in detail
    └── MILESTONES.md          # build order M0–M7, each shippable
```

## Integration notes (verified against this local setup, 2026-10-28; local values are examples, not requirements)

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
| Original developer's Atlassian MCP is OAuth-configured | Local observation only; Revva must offer its own connection flow and cannot rely on this token cache |
| Original developer's `morning` zsh function calls `useaws.py` and starts a proxy | Local observation only; added as a user **Script** in Revva — Revva runs it and probes its local port, nothing AWS-specific in code |
| Original developer has GPU, Bedrock, and Kimi providers configured | Local observation only; Revva discovers agents/models dynamically and makes none a requirement |
| Original developer has `grill-me`, `test-audit`, `impeccable`, and `gh-stack` installed | Local observation only; Revva checks skills/extensions per installation |
| Original developer uses `.worktrees` and an external worktree allowlist | Local observation only; Revva asks each user to choose worktree locations |

## Requirements

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for reusable-app requirements, first-run setup, optional integration prerequisites, the scripts feature, role-based agent/model selection, general chat, AUTO behavior, security, and acceptance criteria.

## Build order

See [docs/MILESTONES.md](docs/MILESTONES.md). Each milestone is independently usable; early milestones include general chat as well as Jira-driven work.
