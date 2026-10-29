# Plan 013: Cmd+K command palette over chats, works, tickets, PRs

> Executor: read `AGENTS.md`. Planned at `2eb91c0`, 2026-10-29 from `docs/ORCA-NOTES.md` backlog item 11. Inspect `git diff` in the working tree first; preserve all unrelated in-flight work.

## Status and intent

P2 · M · LOW risk · independent. One keyboard-first entry point (Cmd+K) that jumps to any chat, ticket work, Jira ticket, or PR, and runs a handful of commands (new chat, start work, open worktrees dialog…). Orca's lesson: the matcher is a quality ladder — exact > word-prefix > boundary-substring > typo — not a fuzzy score. Revva has no palette today (no `cmdk`, no global key handler outside inputs).

## Current state

`src/renderer/src/App.tsx` owns the `View` union and the queries for chats (`chat.list`), works (`work.list`); Jira board via `jira.board()`, PRs via `github.list(scope)`. All are already IPC-available through `src/preload/index.ts` — no main-process changes needed. Navigation = `setView(...)` in App. shadcn `dialog`/`popover` exist; add the shadcn `command` primitive via CLI (docs/FRONTEND.md: reuse shadcn before building).

## Scope and conventions

In scope: `src/renderer/src/views/CommandPalette.tsx` (new), `src/renderer/src/App.tsx`, `src/renderer/src/components/ui/command.tsx` (via `pnpm dlx shadcn@latest add command`), `CHANGELOG.md`. No new dependencies beyond what the shadcn command primitive pulls. No tests (owner policy). Gates: `pnpm typecheck`, `pnpm build`, manual `pnpm dev`.

## Steps

1. Add the shadcn `command` component. Mount `<CommandPalette>` in App; global `keydown` for (meta|ctrl)+K that works from any focus (attach on window; ignore repeat). Dialog lists grouped results: Chats, Works, Tickets, PRs, Commands.
2. Data: reuse the queries App already has (chats, works); fetch tickets/PRs lazily on first palette open, cache with react-query; a fetch failure shows that section as unavailable — never blocks the other sections. Empty state and zero-result copy included.
3. Matcher: implement the ladder in a small pure helper (exact match on title/key > every word prefixed > boundary-subsequence of the title > single-typo Levenshtein≤1 on tokens), stable order within class. Keep it a pure function so it is trivially checkable by hand from the console.
4. Selection: Enter navigates (`setView`), Esc closes, arrow keys move; commands reuse existing flows (New chat → `setNewChatOpen(true)`, Worktrees → `setWorktreesOpen(true)`). Remember last session (react-query cache only). Add an `[Unreleased]` changelog bullet.

## Verification and done

`pnpm typecheck`, `pnpm build`, `git diff --check` exit 0. In `pnpm dev`: open with Cmd+K from a chat view and from inside a textarea; results for a ticket key (exact), a partial chat title (prefix), a typo; Enter lands on each entity type; offline Jira/GitHub degrade per section; keyboard-only operation end to end. Update `plans/README.md` when complete.

STOP if the shadcn command primitive conflicts with the installed base-ui setup and a bespoke listbox would be needed (docs/FRONTEND.md forbids one-off generic primitives — redesign instead of hacking), or if global Cmd+K cannot be captured without intercepting browser shortcuts.
