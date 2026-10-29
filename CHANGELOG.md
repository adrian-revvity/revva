# Changelog

All notable changes to Revva are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

The rule of thumb: every user-visible change gets an `[Unreleased]` bullet as part of the PR, and a release is cut with `pnpm release:patch|minor|major` (see [README → Releases](README.md#releases--changelog)).

## [Unreleased]

- **Inbox messages** — display the complete, formatted final response with an expandable view and more room to read.
- **Worktree count** — the sidebar shows linked worktrees in known repos and warns when there are more than 10 to review.
- **Inbox diagnostics** — show technical details when finished runs or pending questions fail to load, and indicate when retrying.
- **Review and shipping recovery** — explain how to investigate timed-out reviewers, accurately identify commits that passed review, and show why shipping is blocked or checks failed.
- **Inbox replies** — align the reply composer with chat, make Send the primary action, and move the conversation shortcut beside the title.
- **Review recovery** — inspect reviewer errors and retry individual reviewers or a failed fixer; ticket states use clearer labels.
- **Push / Open PR from the ticket conversation** — the cockpit header now always shows the ship action: **Open PR** once shipped, **Push / PR** whenever the run is at rest, and a disabled button explaining why while a session is running. Shipping outside green gates is allowed but warns in the dialog and is recorded on the ticket; AUTO keeps the hard reviewed-commit gate.
- **Sidebar sections** — ongoing ticket runs have their own section above chats, and the new-chat button sits under the Chats heading.
- **Inbox triage** — see each item’s type and position, browse without answering, and reply to finished chats directly from the inbox.
- **Triage inbox** — finished chats and ticket runs you haven’t opened now appear in the Inbox beside pending questions, ranked below them. One card at a time: answer or open it and the next slides in, like clearing an email queue. Mark read dismisses a card without opening; opening the chat or cockpit clears it everywhere.
- **Ticket conversations** — reduce duplicate header information, use shorter model labels, and move branch, worktree, model and session details into a top-bar popover.
- **Questions in conversations** — answer pending questions and permission requests directly in their chat or ticket transcript, as well as in the inbox.
- **Question inbox** — pending questions remain visible if the finished-run feed can’t load; the inbox now explains when Revva needs a restart or a retry.
- **Ticket review and shipping** — follow-ups and retries start fresh review rounds, review blockers are visible, and AUTO ships after required gates pass.
- **Conversation composer** — streamlined message entry, controls, and image previews into one compact layout.
- **Session IDs** — copy a conversation's session ID from its header to reference it in another chat.
- **Conversation context** — show context usage as a compact percentage beside the composer, with the token count in a tooltip.
- **Auto-titled chats** — starting a chat no longer asks for a title; OpenCode generates one from your first message and it appears in the sidebar as soon as the reply starts. Manual rename still wins.
- **Grouped agent turns** — a chain of tool calls (patches, shells, greps…) now renders as one card per turn with the steps collapsed inside ("Worked through N steps"), instead of a separate bubble per step. Applies to chats, the work cockpit and review transcripts.
- **Fixed messages vanishing** — transcripts were loading only the 200 *oldest* messages, so long chats silently stopped showing your newest messages (and pipeline verdicts/Jira replies read from the wrong message). Long sessions now show their newest 200.

## [0.3.0] - 2026-10-28

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
