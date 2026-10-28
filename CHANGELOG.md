# Changelog

All notable changes to Revva are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

The rule of thumb: every user-visible change gets an `[Unreleased]` bullet as part of the PR, and a release is cut with `pnpm release:patch|minor|major` (see [README → Releases](README.md#releases--changelog)).

## [Unreleased]

- **Conversation scrolling** — switching conversations opens the transcript at the latest messages.
- **`/new` chat command** — type `/new` in a chat composer (or pick it from the `/` menu) to start a fresh session with the same directory, agent, model, and ticket/PR links; a context reset that keeps the old chat in the sidebar.
- **Conversation context** — chats and work transcripts show the last reported token usage, model context limit, and percentage used when available.
- **Workspace repositories** — choose a repository discovered within a workspace when starting Jira work, with suggestions based on ticket history and names.
- **PR status in the GitHub tab** — each PR shows whether it is merged, approved, changes-requested, or awaiting review, plus a "new comment" flag (with author and age) when someone commented since you last looked. "Mine" also lists recently merged PRs.
- **Unread chats** — a sidebar chat whose run finished while you weren't looking swaps its icon for a dot; opening the chat clears it.
- **Inbox context** — pending question and permission cards quote the tail of the agent's last message, so you can answer without opening the chat first.

## [0.2.0] - 2026-10-28

- **Windows builds** — every release now also ships a Windows x64 NSIS installer + ZIP, built on a `windows-latest` CI runner alongside the macOS DMG/ZIP. Jira OAuth (Windows Credential store), chats, pipelines and GitHub work there; the Scripts tab runs PowerShell instead of zsh, and `opencode`/`git`/`gh` must be on `PATH`. Builds are unsigned (SmartScreen: More info → Run anyway).

## [0.1.0] - 2026-10-28

The "cockpit" release: Revva now opens on a Dashboard that summarizes everything it is watching, chat reads like it should, and the app ships as a downloadable installer.

### Added

- **Dashboard** — new landing view: OpenCode health, Jira sprint progress bar, inbox, active pipeline work, PRs needing attention, script status, recent chats. Every card deep-links into its view.
- **macOS installers** — `pnpm release:minor` (or patch/major) bumps the version, seals this changelog, tags, and GitHub Actions publishes a DMG + ZIP on the Releases page with matching release notes (builds are unsigned for now: first launch needs right-click → Open).
- **In-app changelog** — the Setup header shows your version; click it to read this file without leaving the app.
- **Worktree cleanup** — list every git worktree across your repos, see which belong to live Revva work, and remove stale ones safely (branch deletion only when git agrees).

### Changed

- **Chat renders markdown** — headings, lists, tables, task lists, fenced code and links now render properly in agent messages (GitHub-flavored); links open in your default browser. Your own messages stay verbatim.
- **Setup is tabbed** — Connections / Projects / Agents & prompts / Models instead of one long scroll.
- **Model picker list unified** — one alphabetical list grouped by provider with favorites pinned on top, and a category dropdown (Models / Agents / Skills); no more duplicated badge clouds.
- **Board → Jira**, and the sidebar reordered: Dashboard → Inbox → Jira → GitHub → Scripts.
- **PR attention markers** — PRs with new comments or requested changes are flagged in the GitHub tab; "mark seen" silences them.

## [0.0.1] - 2026-10-28

First internal build — the whole M0–M7 milestone slice in one tag.

### Added

- **OpenCode service discovery** — agents, models and skills come live from your own `opencode` server; no imported config, ever.
- **Chats per project folder** — streaming output, images, tool-call summaries; a ticket-free escape hatch from the pipeline.
- **Jira integration** — Atlassian MCP over Revva's own OAuth connection (never another app's token cache): sprint board, Start-flow pipeline (build → Sol-loop review → fixer → ship), comment watcher with tackle-comments rework.
- **Parallel review pipeline** — concurrent read-only reviewers (sol-loop, test audit, UI review when UI files changed), findings fanned into one fixer, bounded re-review rounds. Skipped ≠ approved, always.
- **Ship** — pre-flight checks, push (never force), `gh pr create` with a review-gate summary, Jira transition + summary comment. Revva never merges. Opt-in AUTO mode ships on approve by itself.
- **GitHub tab** — your open PRs across all projects via `gh`; one-click read-only review sessions on a checked-out PR worktree.
- **Crash-safe worktrees** — lineage stored in git config; branches are never silently deleted, even if Revva dies mid-operation.
- **Question inbox** — every pending form and permission request across sessions, answered inline and audited.
- **Scripts tab** — one-click zsh commands (your `morning` routine etc.), live output, kill, run history, local-port probing.
- **Per-role agent/model defaults + prompt tuning** — every reviewer, fixer and one-click button tunable in Setup; starred favorite models pin to the top of every picker.
