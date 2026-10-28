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
