/**
 * revva's own sqlite state, under Electron's userData (never a hardcoded home path).
 * M0 ships schema v1; pipeline/review tables arrive with their milestones but are
 * declared now so migrations are forward-only.
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

let db: Database.Database | undefined

export function getDb(): Database.Database {
  if (db) return db
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'revva.db'))
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS role_config (
        role TEXT PRIMARY KEY,
        agent_id TEXT,
        provider_id TEXT,
        model_id TEXT
      );
      CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        default_base_branch TEXT
      );
      CREATE TABLE IF NOT EXISTS chat (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        directory TEXT NOT NULL,
        agent_id TEXT,
        provider_id TEXT,
        model_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `)
  }
  if (version < 2) {
    // v2: every table the pipeline/review/scripts/jira modules previously created
    // lazily in their own ensureSchema(). Forward-only and idempotent: databases
    // that already have some of these tables (or columns) skip the no-ops.
    db.exec(`
      CREATE TABLE IF NOT EXISTS work (
        id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, workspace_id TEXT, repo_dir TEXT NOT NULL,
        branch TEXT NOT NULL, worktree_dir TEXT NOT NULL, parent_work_id TEXT,
        mode TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id TEXT NOT NULL, round INTEGER NOT NULL, role TEXT NOT NULL,
        session_id TEXT, status TEXT NOT NULL, findings TEXT NOT NULL DEFAULT '',
        error TEXT, agent_id TEXT, provider_id TEXT, model_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_work ON review(work_id, round);
      CREATE TABLE IF NOT EXISTS auto_decision (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id TEXT NOT NULL, round INTEGER, kind TEXT NOT NULL,
        detail TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
        answer TEXT, answered_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS script (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL,
        cwd TEXT, interactive INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS script_run (
        id INTEGER PRIMARY KEY AUTOINCREMENT, script_id TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, output_tail TEXT
      );
      CREATE TABLE IF NOT EXISTS jira_comment (
        work_id TEXT NOT NULL, ticket_key TEXT NOT NULL, comment_id TEXT NOT NULL,
        author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
        seen_at INTEGER NOT NULL, tackled_at INTEGER,
        PRIMARY KEY (work_id, comment_id)
      );
      CREATE TABLE IF NOT EXISTS ticket (
        key TEXT PRIMARY KEY, jira_id TEXT, summary TEXT, status TEXT, status_category TEXT,
        points REAL, depends_on TEXT, raw TEXT, synced_at INTEGER
      );
    `)
    addColumnIfMissing(db, 'chat', 'ticket_key', 'TEXT')
    addColumnIfMissing(db, 'chat', 'pr_url', 'TEXT')
    if (addColumnIfMissing(db, 'chat', 'seen_at', 'INTEGER')) {
      // Existing chats were last seen "now", otherwise every row dots up after upgrading.
      db.exec('UPDATE chat SET seen_at = updated_at WHERE seen_at IS NULL')
    }
    addColumnIfMissing(db, 'work', 'review_sel', 'TEXT')
    addColumnIfMissing(db, 'work', 'ship_on_approve', 'INTEGER')
    addColumnIfMissing(db, 'work', 'pr_url', 'TEXT')
    db.exec('PRAGMA user_version = 2;')
  }
  if (version < 3) {
    // Columns the pipeline gained after v2 shipped (blocker/review cycle, unread dots).
    addColumnIfMissing(db, 'work', 'blocker', 'TEXT')
    addColumnIfMissing(db, 'work', 'review_cycle_start', 'INTEGER')
    addColumnIfMissing(db, 'work', 'review_head', 'TEXT')
    if (addColumnIfMissing(db, 'work', 'seen_at', 'INTEGER')) {
      // Existing works count as "last seen now", so upgrading doesn't flood the inbox.
      db.exec('UPDATE work SET seen_at = updated_at WHERE seen_at IS NULL')
    }
    db.exec('PRAGMA user_version = 3;')
  }
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, decl: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  return true
}

/* ---------- settings ---------- */

export function settingGet<T>(key: string): T | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row) return undefined
  try {
    return JSON.parse(row.value) as T
  } catch {
    return undefined
  }
}

export function settingSet(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value ?? null))
}

/* ---------- role_config (per-role agent/model defaults; every role overridable per run) ---------- */

export interface RoleConfigRow {
  role: string
  agentID?: string
  model?: { providerID: string; id: string }
}

export function roleConfigGet(role: string): RoleConfigRow | undefined {
  const row = getDb()
    .prepare('SELECT * FROM role_config WHERE role = ?')
    .get(role) as { role: string; agent_id: string | null; provider_id: string | null; model_id: string | null } | undefined
  if (!row) return undefined
  return {
    role: row.role,
    agentID: row.agent_id ?? undefined,
    model: row.provider_id && row.model_id ? { providerID: row.provider_id, id: row.model_id } : undefined
  }
}

export function roleConfigList(): RoleConfigRow[] {
  return (
    getDb()
      .prepare('SELECT * FROM role_config')
      .all() as Array<{ role: string; agent_id: string | null; provider_id: string | null; model_id: string | null }>
  ).map((row) => ({
    role: row.role,
    agentID: row.agent_id ?? undefined,
    model: row.provider_id && row.model_id ? { providerID: row.provider_id, id: row.model_id } : undefined
  }))
}

export function roleConfigSet(cfg: RoleConfigRow): void {
  getDb()
    .prepare(
      `INSERT INTO role_config(role, agent_id, provider_id, model_id) VALUES(?,?,?,?)
       ON CONFLICT(role) DO UPDATE SET agent_id = excluded.agent_id, provider_id = excluded.provider_id, model_id = excluded.model_id`
    )
    .run(cfg.role, cfg.agentID ?? null, cfg.model?.providerID ?? null, cfg.model?.id ?? null)
}

/* ---------- model favorites (order-preserving list of `providerID::modelID`) ---------- */

export function favoriteModels(): string[] {
  const v = settingGet<string[]>('model.favorites')
  return Array.isArray(v) ? v : []
}

export function toggleFavoriteModel(key: string): string[] {
  const cur = favoriteModels()
  const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
  settingSet('model.favorites', next)
  return next
}
