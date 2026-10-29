# revva — agent working agreement

## Proportional investigation

- For small, localized changes, read the relevant implementation and immediate dependencies, then make the smallest correct patch. Expand scope only to resolve a specific uncertainty or follow evidence.
- Batch independent searches/reads when possible. Reuse results; re-read only for a specific missing detail or after a file changes.
- Stop broad discovery once you can explain the relevant behavior and identify the change. Use directly relevant/required skills; delegate research or planning only when complexity warrants the overhead.
- Keep all required verification and safety checks. Do not turn a small fix into unrelated cleanup.

## File map (start here, not a whole-repo search)

- `src/renderer/src/views/`: product screens and workflows; `Chat.tsx` renders conversations, `GitHubView.tsx` the GitHub board, `ReviewPanel.tsx` review controls, and `Setup.tsx` settings/prompt editing.
- `src/renderer/src/components/`: shared UI; `components/ui/` contains installed shadcn primitives. `src/renderer/src/assets/index.css` holds global styles/theme tokens; see `docs/FRONTEND.md` for UI policy.
- `src/renderer/src/lib/`: renderer utilities, including transcript streaming/cache updates in `transcript-stream.ts`.
- `src/main/ipc.ts` → `src/preload/index.ts` → `src/shared/ipc-channels.ts` / `src/shared/types.ts`: main/renderer IPC wiring and contracts.
- `src/main/opencode/`: service connection, ordinary sessions/prompts/transcripts (`chats.ts`), events, and throughput metrics (`throughput.ts`).
- `src/main/pipeline/works.ts`: ticket worktrees, build prompts, follow-ups, and work-state transitions. `src/main/review.ts` owns reviewer/fixer orchestration; `src/main/ship.ts` owns shipping.
- `src/main/github.ts`: GitHub/PR operations and PR conversations. `src/main/jira/`: Jira integration. `src/main/tasks.ts`: one-click ticket conversations.
- `src/shared/prompts.ts`: default task prompt templates. `src/main/db/index.ts`: SQLite schema, persistence, and settings.
- `src/main/worktrees.ts` / `src/main/worktree-safety.ts`: worktree listing, cleanup, and deletion safeguards.

## Testing policy: YOLO

- **Do not write E2E tests. Write nearly no unit tests.** This project is deliberately untested by choice of the owner.
- Do not add test frameworks, fixtures, mocks, or coverage tooling.
- Verification is manual: run the app (`pnpm dev`), click through the flow, read the logs.
- `pnpm typecheck` and `pnpm build` are the only automated gates.
- If a milestone doc mentions an "Exit test", that means *manually try it once*, not "write an automated test".

## Conventions

- Reuse shadcn/ui components before creating new ones (see docs/FRONTEND.md).
- Main process is ESM: no `require()`. Preload must stay dependency-light (no zod there).
- Never hardcode model IDs, provider names, AWS profiles, or paths — discover from the user's OpenCode service / machine.
- User scripts (Morning etc.) are opaque shell commands; Revva does not model what they do.

## Releases & versioning

- Every user-visible change gets a bullet under `## [Unreleased]` in `CHANGELOG.md` **in the same change** — not at release time, when the detail is gone.
- Do **not** bump `package.json` version yourself; releases are the owner's call.
- To ship (from a clean `main`): `pnpm release:patch|minor|major`. It bumps the version, seals `[Unreleased]`, commits, tags `vX.Y.Z`, pushes — GitHub Actions then builds the mac DMG/ZIP + Windows NSIS/ZIP and publishes them at Releases with the matching changelog section as notes.
- Semver: patch = fixes; minor = features (this app is 0.x — treat features as minor); major = reserve.
- Builds are unsigned for now (no Developer ID identity); document the right-click → Open caveat rather than "fixing" it by hacking entitlements.
