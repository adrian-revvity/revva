# revva — Product requirements

## Product goal

Revva is a reusable local desktop cockpit for running OpenCode sessions against personal work or Jira tickets. A new user should be able to install it, connect their own OpenCode/Jira/AWS setup, choose local repositories, and use the app without copying Adrian's shell functions, scripts, credentials, paths, model IDs, or machine configuration.

## Functional requirements

### Setup and integrations

- **REQ-SETUP-1 — First-run setup:** guide the user through OpenCode connection, workspace-folder selection, optional Jira connection, and optional model-provider setup. Show which capabilities are ready, unavailable, or need configuration; allow skipping Jira and AWS.
- **REQ-SETUP-2 — OpenCode discovery:** discover a compatible local OpenCode service and show actionable guidance when OpenCode is missing, stopped, or incompatible. Do not silently rewrite the user's OpenCode config.
- **REQ-SETUP-3 — Dynamic models, agents, and skills:** load available models, agents, and skills from the connected OpenCode service. Do not require `gpu-poc`, Bedrock, particular model IDs, or a fixed set of skills. User-defined aliases/presets may be saved in Revva settings.
- **REQ-SETUP-4 — Workspace selection:** let the user add/remove authorized root folders and choose a repository within them. Do not assume `~/workspace`, a specific repository, or a fixed worktree path. Confirm before creating worktrees outside the selected root.
- **REQ-SETUP-5 — Jira onboarding:** make Jira optional. Provide a supported authentication flow for the Atlassian MCP server and store Revva credentials in OS-backed secure storage. Do not depend on, read, or modify another user's `mcp-auth.json`. If the MCP OAuth flow cannot be used in a supported environment, offer a documented Jira Cloud REST/API-token connection as an explicit alternative.
- **REQ-SETUP-6 — External tools:** detect `git`, `gh`, optional `gh-stack`, and (for AWS SSO in v1) AWS CLI v2. Explain unavailable features and install/configure guidance; never assume one person's global tools are installed.
- **REQ-SETUP-7 — Per-role agent/model defaults:** allow users to set default OpenCode agent and model independently for each role: general chat, ticket implementation, grill-me, Sol-loop review, test audit, UI review, feedback rework, and fixer. At run creation, allow overriding the relevant default. Populate choices from the connected user's OpenCode configuration; preserve any supported configured agent/model, not only examples documented here.
- **REQ-SETUP-8 — Review role selection:** each parallel review subagent has its own selectable OpenCode agent/model setting and per-run override. Sol-loop may use GPU Qwen, GPT-6 Sol, or another configured model/agent the user chooses. Do not require the reviewer to be named Sol or use a Bedrock provider. Enforce read-only behavior for review roles regardless of the selected agent.

### Work and chat

- **REQ-WORK-1 — Jira board:** when connected, show the signed-in user's current-sprint tickets and refresh them; Jira is not required to use general chat.
- **REQ-WORK-2 — Ticket work:** start, inspect, stop, and resume ticket-linked OpenCode sessions; select a repository, model, and optional dependency branch.
- **REQ-WORK-3 — Questions:** aggregate pending OpenCode forms and permission requests for Revva sessions; allow answering from an inbox or the relevant session view.
- **REQ-CHAT-1 — New general chat:** provide a globally available **New Chat** action (sidebar, app shortcut, and empty states) that creates an ordinary OpenCode session without a Jira issue, pipeline, branch, review, or PR association.
- **REQ-CHAT-2 — Chat context:** before creating a general chat, let the user choose a working directory from their authorized workspace folders (remember a configurable default); allow a non-repository folder when OpenCode supports it.
- **REQ-CHAT-3 — Chat model and skills:** use the same live model/agent discovery and selection as ticket work; allow a default model and optional skills. Show unavailable models clearly rather than substituting silently.
- **REQ-CHAT-4 — Chat history:** list and reopen Revva-created general chat sessions, stream output, answer questions/permissions, send follow-up messages, and interrupt a running session. Chat sessions remain OpenCode sessions and survive Revva restarts.
- **REQ-CHAT-5 — Separation:** general chats never enter the Jira review/ship pipeline unless the user explicitly converts/links the session to a ticket in a later feature.

### Automatic execution mode

- **REQ-AUTO-1 — AUTO opt-in:** provide a visible `AUTO` checkbox/toggle per ticket run, plus an optional user preference for its initial state. The UI must clearly show when AUTO is active; it must not be silently enabled by an update.
- **REQ-AUTO-2 — Autonomous goal completion:** in AUTO, use configured role defaults, proceed through implementation, parallel review subagents, fixes, and required checks without routine approval prompts. Prefer the agent's explicitly recommended option; if none is explicit, choose the safest option consistent with ticket acceptance criteria and existing project conventions, recording the assumption.
- **REQ-AUTO-3 — Automatic PR delivery:** once all required review gates and checks pass, Revva commits/pushes the work branch and creates/opens the PR without asking for a separate ship confirmation. Never merge the PR. Jira status/comment updates follow the user's AUTO delivery settings.
- **REQ-AUTO-4 — Reduce, do not hide, blockers:** AUTO answers structured agent questions/forms when a recommended or clearly safe answer can be inferred from context. If intent is genuinely ambiguous, required credentials are unavailable, a required reviewer/check cannot run, reviewers remain disputed, or a request exceeds the configured permission policy, pause in `WAITING_HUMAN` and notify the user rather than guessing unsafely.
- **REQ-AUTO-5 — Permission boundary:** AUTO may pre-authorize only actions within an explicitly configured least-privilege policy (for example, normal edits and tests inside the selected worktree). Never auto-approve access outside selected folders, secret disclosure, destructive git/data-loss actions, force-push, or PR merge. Show any permission request that is not covered by the policy.
- **REQ-AUTO-6 — Auditability:** keep an AUTO decision log with chosen options, inferred assumptions, reviewer outputs, checks, push/PR results, and any pause reason. AUTO completion and blockers are visible in Revva; routine progress need not interrupt the user.

### AWS / Bedrock readiness (“Morning”)

- **REQ-AWS-1 — Built-in feature:** implement Morning as a first-class Revva feature. Do not require a user's `morning` shell function, `useaws.py`, custom Python environment, Terminal.app, or machine-specific proxy script.
- **REQ-AWS-2 — Per-user configuration:** configure AWS SSO profile, SSO start URL/region as applicable, and Bedrock/AWS region in Revva. Do not bundle the current developer's organization URL, account/profile names, role names, or credentials.
- **REQ-AWS-3 — Login lifecycle:** start AWS SSO login from the UI, show progress/errors and open the browser when the AWS CLI requests it, then report readiness and credential expiry. Provide retry/sign-out guidance; never collect or display secrets.
- **REQ-AWS-4 — Proxy lifecycle:** where a selected OpenCode provider needs the SigV4 proxy, start, monitor, and stop a Revva-managed local proxy with user-configurable bind/port and region. Do not start an unauthenticated network listener; default to loopback only.
- **REQ-AWS-5 — Optional integration:** AWS/Bedrock setup is optional. Non-AWS providers and general chat remain usable without AWS configuration. Gate only models that actually require unavailable AWS credentials/proxy.
- **REQ-AWS-6 — No silent model substitution:** if a requested model cannot run, explain why and let the user choose another available model.

### Ticket pipeline and delivery

- **REQ-PIPE-1:** optional `/grill-me`, ticket implementation, pending-question handling, bounded Sol review loop, `/test-audit`, and `/impeccable` when relevant, with human-visible progress and findings.
- **REQ-PIPE-2:** create ticket worktrees in the user-selected location; allow a dependent ticket to branch from another ticket's branch when available.
- **REQ-PIPE-3:** after gates pass, offer PR creation and optional gh-stack integration; never merge automatically. Update Jira status/comment only when Jira is connected and the user has enabled those actions.
- **REQ-PIPE-4:** poll configured Jira tickets for new unresolved comments; user explicitly starts the feedback-fix run; Revva reports proposed replies/resolutions and performs Jira writes only according to the user's configured approval policy.
- **REQ-PIPE-5 — Parallel configurable reviewers:** start all applicable review subagents concurrently, each using that role's default or per-run selected OpenCode agent/model. Fan-in their independent results before one fixer acts; incomplete/error results are not approvals. Permit the same model or different models across reviewer roles.

### UI implementation

- **REQ-UI-1 — Component library:** use shadcn/ui for the React renderer, initialized for the Vite-based Electron renderer with its CLI and committed `components.json` configuration.
- **REQ-UI-2 — Reuse before custom:** before creating a new UI component, inspect the installed shadcn/ui components and use the shadcn skill/MCP to search the default or configured registries. Prefer composing/extending an existing accessible component. Create a custom component only when the product interaction is genuinely domain-specific or no existing component fits; document the gap and reuse shadcn primitives inside it where possible.
- **REQ-UI-3 — Accessible composition:** use shadcn's form, menu, dialog, sidebar, table, status, and chat/AI components where they fit; preserve keyboard/focus semantics and the project's visual tokens when composing them. Avoid duplicating primitives already provided by shadcn/ui.

## Non-functional requirements

- **NFR-1 Portability:** v1 targets macOS, with integration boundaries that do not depend on zsh, AppleScript, a home-directory layout, or macOS-only paths. Windows/Linux support may follow; platform-specific operations are isolated behind adapters.
- **NFR-2 Security:** keep provider/Jira credentials out of renderer and logs; use Electron `safeStorage`/OS credential store; validate all IPC; use least privilege; bind local proxies to loopback; no automatic PR merge or destructive git action.
- **NFR-3 Transparency:** show which model/provider, directory, Jira connection, and pipeline stage a session uses; show cost/usage when OpenCode provides it; retain a review ledger.
- **NFR-4 Resilience:** persist Revva associations and pipeline state locally; recover OpenCode sessions after app restart; resync after lost event streams; make polling intervals and retry errors visible.
- **NFR-5 Accessibility:** keyboard-operable core workflows, readable status/error messages, reduced-motion support, and screen-reader labels.
- **NFR-6 Data minimization:** store only the Jira fields/comment watermarks needed for the UI and workflow; make local session association and cached ticket-data cleanup user-controllable.
- **NFR-7 UI consistency:** custom UI is built from shared shadcn/ui primitives and theme tokens rather than one-off controls/styles.

## Initial prerequisites and supported setup

Required to use Revva:

1. A supported desktop OS (initial release: macOS).
2. OpenCode installed and configured with at least one usable provider/model; Revva discovers these from the OpenCode service.
3. Git and at least one local repository/workspace folder.

Optional, feature-specific:

- Jira Cloud account + Atlassian MCP OAuth authorization (or explicitly configured Jira REST/API-token fallback) for sprint board, comments, and transitions.
- AWS CLI v2 + a locally configured AWS IAM Identity Center/SSO profile for the initial built-in Morning implementation; AWS account access to the desired Bedrock models. The app orchestrates the login and proxy; users do not install or run Revva-specific scripts.
- GitHub CLI authenticated to GitHub for PR creation; `gh-stack` extension for stacked PR conveniences. Without these, coding/review still works and the ship panel explains what's missing.
- Skills are discovered from OpenCode. Missing optional skills are surfaced in setup and can be installed by the user; Revva must not assume this developer's `~/.agents/skills` directory.

## Acceptance criteria for reusability

- A clean user account with no Revva-specific shell function, custom Python script, personal workspace path, or preexisting OpenCode Jira token can complete setup using documented steps.
- Changing the available provider/model list changes Revva's model picker without a code change.
- A user can start and reopen a general chat without connecting Jira or entering a ticket workflow.
- A user can choose different configured agents/models for implementation and each review role, either from defaults or as per-run overrides; the review subagents still run concurrently and read-only.
- New visual features use existing shadcn/ui components where suitable; custom primitives are introduced only with a documented reason.
- AUTO can complete an eligible run through PR creation without routine user prompts; a simulated ambiguous/security-sensitive question pauses safely, and no run merges a PR.
- An AWS user can configure their own SSO profile and start Morning from Revva; no developer-specific AWS URL/account/profile is present in shipped code or defaults.
- Missing optional integrations degrade independently and are explained in the UI rather than preventing app startup.
