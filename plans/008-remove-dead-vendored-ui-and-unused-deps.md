# Plan 008: Delete dead vendored UI components and the unused `cn` dependency

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 830a20f..HEAD -- src/renderer/src/components/ui package.json`
> On any diff, re-run Step 1's grep (usage counts) before deleting anything;
> a file that gained a real importer since plan-writing must be kept.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `830a20f`, 2026-10-28

## Why this matters

The shadcn vendoring process left three **dead** components in
`src/renderer/src/components/ui/` — `sidebar.tsx` (724 lines),
`dropdown-menu.tsx` (254 lines), and `sheet.tsx` (only consumed by the dead
sidebar) — ~1,100 lines that typecheck, review, and grep like live code but
serve nothing (the app uses a hand-rolled `<aside>` in `App.tsx`). The npm
package `cn@0.5.4` sits in `dependencies` imported by nobody — the actual `cn`
helper is `src/renderer/src/lib/utils.ts` (clsx + tailwind-merge); the dead dep
is a name-collision trap. Removing all four shrinks the codebase a meaningful
~10% of the renderer surface and ends docs/FRONTEND.md's "reuse-first
inventory" pointing at ghosts.

## Current state

- `src/renderer/src/components/ui/sidebar.tsx` — zero importers
  (`grep -rn "components/ui/sidebar" src --include='*.tsx' | grep -v 'components/ui/sidebar.tsx'` → no matches at plan time).
- `src/renderer/src/components/ui/dropdown-menu.tsx` — zero importers (same grep).
- `src/renderer/src/components/ui/sheet.tsx` — imported ONLY by `sidebar.tsx`
  (verify with `grep -rn "components/ui/sheet" src --include='*.tsx' | grep -v 'components/ui/sheet.tsx'`).
- `cn` in `package.json` dependencies — `grep -rn "from 'cn'" src` /
  `from "cn"` → zero. Real helper: `src/renderer/src/lib/utils.ts`.
- **Keep** `@base-ui/react`: `collapsible.tsx` uses it and `Chat.tsx` imports
  that; `components.json` says `"style": "base-nova"` — the project's chosen
  shadcn base IS base-ui for newly added components. 13 older vendored files
  use `radix-ui` (the pre-existing base). This mixed state is the recorded
  outcome of the init choice vs. later additions; resolving it (migrating the
  13 radix files to base-ui) is a separate, bigger decision — explicitly NOT
  part of this plan.
- `radix-ui` stays in dependencies (the 13 live ui files import it).

Repo conventions: docs/FRONTEND.md — shadcn components are vendored & owned;
remove what's unused rather than keeping an inventory graveyard.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Usage check | `grep -rn "components/ui/<name>" src --include='*.tsx' \| grep -v "components/ui/<name>.tsx"` | no matches (= safe to delete) |
| Remove dep | `pnpm remove cn` | package.json `dependencies.cn` gone |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Build | `pnpm build` | exit 0 |
| Manual | `pnpm dev` | app starts, Setup tabs + tooltips + chat render |

## Scope

**In scope**:
- delete `src/renderer/src/components/ui/sidebar.tsx`, `dropdown-menu.tsx`, `sheet.tsx`
- `package.json` + `pnpm-lock.yaml` (only via `pnpm remove cn`)

**Out of scope**:
- any other file; any rewrite of radix→base-ui (see Current state);
  `components.json` untouched.

## Git workflow

- Branch: `advisor/008-dead-ui`
- Commit style: `chore(ui): drop unused vendored components and cn dependency`
- Do NOT push.

## Steps

### Step 1: Re-verify deadness, then delete

Run the three usage greps from the Commands table for `sidebar`,
`dropdown-menu`, `sheet`. **All three must return no importers** (sheet's only
importer may be sidebar.tsx itself — which you're deleting in the same commit;
if sheet has any OTHER importer, keep sheet and report). Then
`git rm` the three files.

**Verify**: `ls src/renderer/src/components/ui/` shows none of the three.

### Step 2: Remove the `cn` dependency

`pnpm remove cn`

**Verify**: `grep '"cn"' package.json` → no match; `pnpm typecheck` → exit 0.

### Step 3: Build + manual smoke

`pnpm build` then `pnpm dev`: app window opens; open Setup (tabs render),
a chat with a tool call (collapsible rows render), sidebar nav works (it's
hand-rolled `aside`, not the deleted component).

**Verify**: no console/terminal errors referencing missing modules.

## Test plan

No automated tests (AGENTS.md). Step 3 manual pass is the audit trail.

## Done criteria

- [ ] Three files deleted; `pnpm typecheck` exit 0; `pnpm build` exit 0
- [ ] `grep '"cn"' package.json` → no match
- [ ] `pnpm-lock.yaml` diff only touches the `cn` package entry
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- Any usage grep finds a live importer (owner wired one up since plan-writing) → keep that file, note it, continue.
- `pnpm dev` fails resolving any `@/components/ui/*` import → you deleted something live; `git checkout` it, report.

## Maintenance notes

- If a real sidebar/overflow-menu is built later, re-add via shadcn CLI
  (`pnpm dlx shadcn@latest add sidebar`) rather than resurrecting these files
  from git history — the registry version will match the current base-nova style.
- The radix-vs-base-ui consolidation is deliberately deferred; if it's ever
  picked up, decide in favor of base-ui (matches `components.json` style).
