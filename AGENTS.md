# revva — agent working agreement

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
