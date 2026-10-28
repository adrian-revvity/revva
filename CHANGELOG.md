# Changelog

All notable changes to Revva are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

- (nothing yet)

## [0.1.0] - 2026-10-28

### Added

- Dashboard landing view summarizing OpenCode, Jira, Inbox, pipeline work, PRs and scripts.
- Release flow: `pnpm release:patch|minor|major` bumps the version, seals CHANGELOG.md, tags, and GitHub Actions publishes a macOS DMG/

ZIP on the Releases page.
- In-app changelog (Setup header → version button), with markdown-rendered chat messages.

## [0.0.1] - 2026-10-28

First internal build.

### Added

- OpenCode service discovery — agents, models and skills come live from your own `opencode` server, never imported config.
- Chats per project folder with streaming, markdown rendering, images and tool-call summaries.
- Jira (Atlassian MCP OAuth): sprint board, Start-flow pipeline (build → Sol-loop review → fixer → ship), comment watcher with tackle-comments rework.
- GitHub tab via `gh` CLI: my PRs, review requests, one-click read-only PR review sessions.
- Review pipeline with per-role agent/model defaults and editable prompt templates.
- Ship: push + PR + Jira sync, with opt-in AUTO ship on approve.
- Crash-safe worktrees with lineage stored in git config; branches are never silently deleted.
- Scripts tab: one-click zsh commands (e.g. “morning”), live output and run history.
- Model favorites pinned to every picker; setup tabs for connections, projects, agents and models.
