/**
 * In-memory index: sessionId → what revva owns it as. SSE deltas arrive far
 * faster than any SQLite probe should; entries are registered at the same
 * places that write the sqlite rows and rebuilt from sqlite on boot.
 */
import { getDb } from '../db'

type SessionKind = 'chat' | 'work'

class SessionIndex {
  private kinds = new Map<string, SessionKind>()

  register(sessionId: string, kind: SessionKind): void {
    this.kinds.set(sessionId, kind)
  }
  forget(sessionId: string): void {
    this.kinds.delete(sessionId)
  }
  kindOf(sessionId: string): SessionKind | undefined {
    return this.kinds.get(sessionId)
  }

  /** Rebuild from sqlite (boot / safety net). Work rows key on session_id. */
  rebuild(): void {
    this.kinds.clear()
    const db = getDb()
    for (const row of db.prepare('SELECT session_id FROM chat').all() as Array<{ session_id: string }>) {
      this.kinds.set(row.session_id, 'chat')
    }
    for (const row of db.prepare('SELECT session_id FROM work WHERE session_id IS NOT NULL').all() as Array<{ session_id: string }>) {
      this.kinds.set(row.session_id, 'work')
    }
  }
}

export const sessionIndex = new SessionIndex()
