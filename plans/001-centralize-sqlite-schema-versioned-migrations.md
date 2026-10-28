# Plan 001: Centralize all SQLite schema into versioned migrations in `src/main/db/index.ts`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 830a20f..HEAD -- src/main/db/index.ts src/main/opencode/chats.ts src/main/opencode/inbox.ts src/main/pipeline/works.ts src/main/review.ts src/main/ship.ts src/main/scripts.ts src/main/jira/watch.ts src/main/jira/board.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `830a20f`, 2026-10-28

## Why this matters

Revva's SQLite schema is created by **ten separate lazy `ensureSchema()` functions**
scattered across modules — some called from `wire()`, some from `list()`, some
from `create()`, one from inside `audit()`. Two migration mechanisms coexist
(`PRAGMA user_version` in `db/index.ts` vs. `CREATE TABLE IF NOT EXISTS` +
ad-hoc `PRAGMA table_info`/`ALTER` everywhere else), and `work.pr_url` is
added by **two different modules**. Adding any table/column today means knowing
which random call site "owns" it. This plan consolidates everything into one
forward-only migration list in `db/index.ts` so every other module can assume
the schema exists.

## Current state

- `src/main/db/index.ts` — `getDb()` opens the DB (WAL) and calls `migrate()`.
  `migrate()` has a single `version < 1` block creating `settings`,
  `role_config`, `workspace`, `chat`, then sets `PRAGMA user_version = 1`.
- Schema declared **elsewhere** today (all of this moves into `db/index.ts`):
  - `src/main/opencode/chats.ts:116-120` — `ensureSchema()` adds `chat.ticket_key`,
    `chat.pr_url` via `PRAGMA table_info` + `ALTER`; called from `wire()` and `create()`.
  - `src/main/pipeline/works.ts:44-62` — `ensureSchema()` creates `work` table and
    adds `review_sel`, `ship_on_approve`, `pr_url`; called from `wire()`, `list()`, `start()`.
  - `src/main/review.ts:51-65` — `ensureSchema()` creates `review` (+ index
    `idx_review_work`) and `auto_decision`; called from `wire()`, `reviewsFor()`,
    `startRound()`, and **inside `audit()` (line 446)**.
  - `src/main/ship.ts:29-32` — `ensureSchema()` adds `work.pr_url` *again*; called
    from `checks()`, `ship()`, `requireWork()`.
  - `src/main/opencode/inbox.ts:239-245` — `ensureSchema()` creates `inbox_audit`; called from `wire()`.
  - `src/main/scripts.ts:32-41` — `wire()` execs `CREATE TABLE IF NOT EXISTS script / script_run`.
  - `src/main/jira/watch.ts:34-41` — `ensureSchema()` creates `jira_comment`; called from `wire()`, `pending()`.
  - `src/main/jira/board.ts:83-86` — `cacheTickets()` execs `CREATE TABLE IF NOT EXISTS ticket` on every board refresh.

Repo conventions:
- Main process is ESM; no `require()`. Keep `db/index.ts` dependency-light.
- Comments style: concise block comments explaining *why* (see `db/index.ts` header).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Build     | `pnpm build` | exit 0 |
| Manual run | `pnpm dev` | app window opens, no main-process stack traces |

**Known baseline**: at plan time the repo had pre-existing typecheck failures in
`src/main/worktrees.ts` and `src/main/ipc.ts` from unrelated in-flight work. If
those files still fail when you start, confirm your change adds **no new
errors** (diff the error list before/after) and note it in your report. Any
error in an in-scope file below is yours to fix.

## Scope

**In scope** (the only files you should modify):
- `src/main/db/index.ts`
- `src/main/opencode/chats.ts`, `src/main/opencode/inbox.ts` (delete their `ensureSchema` + calls)
- `src/main/pipeline/works.ts`, `src/main/review.ts`, `src/main/ship.ts`,
  `src/main/scripts.ts`, `src/main/jira/watch.ts`, `src/main/jira/board.ts` (same)

**Out of scope**:
- `src/main/worktrees.ts` and `src/main/ipc.ts` — in-flight work by the owner; do not touch.
- Any data changes, table renames, or column removals. This is a **pure relocation**:
  identical tables, columns, and index names.
- Query statements in modules (prepare/run calls) — they stay exactly where they are.

## Git workflow

- Branch: `advisor/001-schema-migrations` off current HEAD
- Commit style (from `git log`): conventional commits, e.g. `refactor(db): single versioned migration list`
- Do NOT push or open a PR.

## Steps

### Step 1: Write the v2 migration in `db/index.ts`

Add a `addColumnIfMissing` helper and an `if (version < 2)` block **after** the
existing v1 block (keep v1 untouched — existing user databases need it). The v2
block must be safe on databases where some tables already exist (use
`IF NOT EXISTS` + `addColumnIfMissing` everywhere). Move the DDL verbatim from
the ten sites listed above — same names, same columns:

```ts
function addColumnIfMissing(db: Database.Database, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}
```

Inside `if (version < 2)`: create (IF NOT EXISTS) `work`, `review` (+ index),
`auto_decision`, `inbox_audit`, `script`, `script_run`, `jira_comment`,
`ticket`; then `addColumnIfMissing` for `chat.ticket_key TEXT`,
`chat.pr_url TEXT`, `work.review_sel TEXT`, `work.ship_on_approve INTEGER`,
`work.pr_url TEXT`; then `PRAGMA user_version = 2;`. Copy each `CREATE TABLE`
statement from the module that currently owns it (exact column definitions are
in the Current-state file/line references — open them).

**Verify**: `pnpm typecheck` → exit 0, no errors in `src/main/db/index.ts`.

### Step 2: Delete every module-local `ensureSchema`

In each of the eight modules: delete the `ensureSchema` (or wire-time `exec` in
`scripts.ts`) function **and every call to it**. Do not change anything else in
those functions/files. `board.ts`'s `cacheTickets` keeps its prepared upsert —
just delete the `db.exec(CREATE TABLE ...)` above it.

**Verify**: `grep -rn "ensureSchema" src/main/` → no matches.
`grep -rn "CREATE TABLE" src/main/` → matches only in `src/main/db/index.ts`.
`pnpm typecheck` → exit 0, no errors.

### Step 3: Fresh-database smoke test

```bash
mv "$(ls -d ~/Library/Application\ Support/revva 2>/dev/null || echo /nonexistent)" /tmp/revva-userdata-backup 2>/dev/null || true
pnpm dev
```
The app must start clean (fresh DB), show the sidebar/dashboard, and
`ls ~/Library/Application\ Support/revva/revva.db` must exist. Quit the app
(Cmd+Q) afterwards. If you had to move real user data, restore it:
`rm -rf ~/Library/Application\ Support/revva && mv /tmp/revva-userdata-backup ~/Library/Application\ Support/revva` and restart `pnpm dev` once to confirm the *upgraded* DB also opens without errors.

**Verify**: both launches clean; then `sqlite3 ~/Library/Application\ Support/revva/revva.db 'PRAGMA user_version'` → `2`.

### Step 4: Build gate

**Verify**: `pnpm build` → exit 0 (or baseline failures only in the two known files).

## Test plan

Per AGENTS.md this repo has **no automated tests by policy** — do not add any.
Verification is the typecheck/build gates plus the Step 3 manual run.

## Done criteria

- [ ] `grep -rn "ensureSchema\|CREATE TABLE\|ALTER TABLE" src/main/` → matches only inside `src/main/db/index.ts`
- [ ] `pnpm typecheck` introduces exit 0, no errors
- [ ] `pnpm build` succeeds (modulo the two known baseline-failing files, if still broken)
- [ ] Fresh-DB and upgraded-DB manual runs both start clean; `PRAGMA user_version` → 2
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report (do not improvise) if:
- Any "Current state" file/line does not match the live code (drift).
- A `CREATE TABLE` you are relocating has **different columns** than the
  module excerpt in this plan — the plan text is authoritative only when it matches code.
- `pnpm dev` throws an SQLite error on either the fresh or upgraded DB.
- You discover another module not listed above creating tables (grep for
  `CREATE TABLE`/`ALTER TABLE` under `src/main/`).

## Maintenance notes

- Future schema changes: append a new `if (version < N)` block in `db/index.ts`.
  Never edit shipped blocks; the file stays forward-only.
- Reviewers: the diff should be *moved* SQL, not *rewritten* SQL. Any changed
  column type or name in the diff is a defect.
- Follow-up deferred: `ticket` and `work` may want indexes later (e.g.
  `work(session_id)`); add them in a future v-N block, not here.
