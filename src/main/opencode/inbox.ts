/**
 * Question Inbox (M2): aggregates pending agent questions (forms) and permission
 * requests across every session Revva knows about (chats + ticket works).
 *
 * SSE is live-only, so state is a memory mirror re-synced on connect/reconnect via
 * session-scoped listings (global /api/form is location-scoped, so we go per session).
 * Every answer is written to an audit table.
 */
import { BrowserWindow, Notification } from 'electron'
import { getDb } from '../db'
import { openCodeService, describeError } from './service'
import { eventBus, type RawEvent } from './bus'
import { IPC, type PendingItem } from '@shared/types'

interface InboxRow {
  session_id: string
  kind: 'form' | 'permission'
  title: string
  payload: string | null
  answer: string | null
  answered_at: number | null
}

class InboxManager {
  private wired = false
  /** key: `form:<id>` / `perm:<id>` — live mirror of pending items. */
  private pending = new Map<string, PendingItem>()

  wire(): void {
    if (this.wired) return
    this.wired = true
    ensureSchema()
    eventBus.on('event', (e: RawEvent) => this.onEvent(e))
    eventBus.on('stream:reconnect', () => void this.resync())
    openCodeService.onStatus((s) => {
      if (s.state === 'connected') void this.resync()
    })
  }

  list(): PendingItem[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Answer a question form; answers are audited. */
  async replyForm(sessionID: string, formID: string, answer: Record<string, string | number | boolean | string[]>): Promise<void> {
    await openCodeService.api.session.form.reply({ sessionID, formID, answer })
    this.pending.delete(`form:${formID}`)
    this.audit(sessionID, 'form', formID, answer)
    this.push()
  }

  async replyPermission(sessionID: string, requestID: string, decision: 'once' | 'always' | 'reject'): Promise<void> {
    await openCodeService.api.permission.reply({ sessionID, requestID, decision })
    this.pending.delete(`perm:${requestID}`)
    this.audit(sessionID, 'permission', requestID, { decision })
    this.push()
  }

  /** Re-pull pending items for every session we own (crash/SSE-gap safety net). */
  async resync(): Promise<void> {
    if (!openCodeService.connected) return
    const sessionIds = this.knownSessions()
    const fresh = new Map<string, PendingItem>()
    for (const sessionID of sessionIds) {
      const dir = this.directoryOf(sessionID)
      try {
        for (const f of await openCodeService.api.session.form.list({ sessionID })) {
          fresh.set(`form:${f.id}`, {
            kind: 'form',
            id: f.id,
            sessionID,
            title: f.title,
            directory: dir,
            createdAt: Date.now(),
            fields: f.fields as unknown as PendingItem['fields']
          })
        }
      } catch {
        /* session gone */
      }
      try {
        for (const p of await openCodeService.api.permission.list({ sessionID })) {
          fresh.set(`perm:${p.id}`, {
            kind: 'permission',
            id: p.id,
            sessionID,
            title: p.message ?? `${p.action} ${p.resources.slice(0, 2).join(', ')}`,
            directory: dir,
            createdAt: Date.now(),
            action: p.action,
            resources: p.resources
          })
        }
      } catch {
        /* session gone */
      }
    }
    this.pending = fresh
    this.push()
    // Preview tails are fetched after the snapshot is up (resync runs on every
    // connect; message.list per session would slow the initial paint otherwise).
    for (const [key, item] of fresh) this.attachLastMessage(key, item.sessionID)
  }

  private knownSessions(): string[] {
    const db = getDb()
    const chats = db.prepare('SELECT session_id FROM chat').all() as Array<{ session_id: string }>
    const works = db
      .prepare("SELECT session_id FROM work WHERE session_id IS NOT NULL AND state NOT IN ('SHIPPED','ABANDONED')")
      .all() as Array<{ session_id: string }>
    return [...chats, ...works].map((r) => r.session_id).filter(Boolean)
  }

  private directoryCache = new Map<string, string>()

  private directoryOf(sessionID: string): string {
    const cached = this.directoryCache.get(sessionID)
    if (cached) return cached
    const row =
      (getDb().prepare('SELECT directory FROM chat WHERE session_id = ?').get(sessionID) as { directory: string } | undefined) ??
      (getDb().prepare('SELECT worktree_dir AS directory FROM work WHERE session_id = ?').get(sessionID) as { directory: string } | undefined)
    const dir = row?.directory ?? ''
    if (dir) this.directoryCache.set(sessionID, dir)
    return dir
  }

  /** Label for a session (chat title or ticket key) for inbox display. */
  private ownerLabel(sessionID: string): string {
    const chat = getDb().prepare('SELECT title FROM chat WHERE session_id = ?').get(sessionID) as { title: string } | undefined
    if (chat) return chat.title
    const work = getDb().prepare('SELECT ticket_key FROM work WHERE session_id = ?').get(sessionID) as { ticket_key: string } | undefined
    if (work) return work.ticket_key
    return sessionID
  }

  /**
   * Tail of the agent's last assistant message, so an inbox card says what the
   * agent was doing when it blocked — without opening the chat. Best-effort.
   */
  private async lastMessage(sessionID: string): Promise<string | undefined> {
    try {
      const res = await openCodeService.api.message.list({ sessionID, order: 'desc', limit: 20 })
      for (const m of res.data) {
        if (m.type !== 'assistant') continue
        let text = ''
        for (const part of m.content ?? []) {
          const p = part as Record<string, unknown>
          if (p.type === 'text' && typeof p.text === 'string') text += p.text
        }
        const clean = text.trim().replace(/\s+/g, ' ')
        if (!clean) continue
        return clean.length > 280 ? `…${clean.slice(-280)}` : clean
      }
    } catch {
      /* transcript unavailable — card renders without the preview */
    }
    return undefined
  }

  private onEvent(e: RawEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'form.created': {
        const form = data.form as { id: string; sessionID: string; title: string; fields?: unknown[] } | undefined
        if (!form?.sessionID || !this.isKnown(form.sessionID)) return
        this.pending.set(`form:${form.id}`, {
          kind: 'form',
          id: form.id,
          sessionID: form.sessionID,
          title: form.title,
          directory: this.directoryOf(form.sessionID),
          createdAt: Date.now(),
          fields: (form.fields ?? []) as PendingItem['fields'],
          owner: this.ownerLabel(form.sessionID)
        })
        this.markSessionWaiting(form.sessionID)
        this.notify(this.pending.get(`form:${form.id}`)!)
        this.push()
        this.attachLastMessage(`form:${form.id}`, form.sessionID)
        break
      }
      case 'form.replied':
      case 'form.cancelled': {
        const id = String(data.formID ?? data.id ?? '')
        if (id && this.pending.delete(`form:${id}`)) this.push()
        break
      }
      case 'permission.asked': {
        const req = (data.request ?? data) as { id: string; sessionID: string; action: string; resources?: string[]; message?: string }
        if (!req.sessionID || !this.isKnown(req.sessionID)) return
        this.pending.set(`perm:${req.id}`, {
          kind: 'permission',
          id: req.id,
          sessionID: req.sessionID,
          title: req.message ?? `${req.action} ${(req.resources ?? []).slice(0, 2).join(', ')}`,
          directory: this.directoryOf(req.sessionID),
          createdAt: Date.now(),
          action: req.action,
          resources: req.resources ?? [],
          owner: this.ownerLabel(req.sessionID)
        })
        this.markSessionWaiting(req.sessionID)
        this.notify(this.pending.get(`perm:${req.id}`)!)
        this.push()
        this.attachLastMessage(`perm:${req.id}`, req.sessionID)
        break
      }
      case 'permission.replied': {
        const id = String(data.requestID ?? data.id ?? '')
        if (id && this.pending.delete(`perm:${id}`)) this.push()
        break
      }
    }
  }

  /** Async tail-fetch after the item is already shown; pushes an updated snapshot. */
  private attachLastMessage(key: string, sessionID: string): void {
    void this.lastMessage(sessionID).then((text) => {
      const item = this.pending.get(key)
      if (!item || !text) return
      item.lastMessage = text
      this.push()
    })
  }

  private isKnown(sessionID: string): boolean {
    const db = getDb()
    return (
      db.prepare('SELECT 1 FROM chat WHERE session_id = ?').get(sessionID) !== undefined ||
      db.prepare('SELECT 1 FROM work WHERE session_id = ?').get(sessionID) !== undefined
    )
  }

  /** A blocked run is visibly WAITING_HUMAN on its ticket card. */
  private markSessionWaiting(sessionID: string): void {
    getDb()
      .prepare("UPDATE work SET state = 'WAITING_HUMAN', updated_at = ? WHERE session_id = ? AND state = 'BUILDING'")
      .run(Date.now(), sessionID)
  }

  private audit(sessionID: string, kind: 'form' | 'permission', refId: string, answer: unknown): void {
    getDb()
      .prepare(
        `INSERT INTO inbox_audit(session_id, kind, ref_id, answer, answered_at) VALUES(?,?,?,?,?)`
      )
      .run(sessionID, kind, refId, JSON.stringify(answer), Date.now())
  }

  /** macOS notification so a blocked session is noticed without the window focused. */
  private notify(item: PendingItem): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: item.kind === 'form' ? 'Question from agent' : 'Permission request',
      body: `${item.owner ?? item.directory}\n${item.title}`,
      silent: false
    })
    notification.on('click', () => this.focusWindow())
    notification.show()
  }

  /** Bring Revva to the front when the notification is clicked. */
  private focusWindow(): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  private push(): void {
    const snapshot = this.list()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.eventPush, { kind: 'inbox', items: snapshot })
    }
  }
}

function ensureSchema(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS inbox_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
    answer TEXT, answered_at INTEGER NOT NULL
  );`)
}

export const inboxManager = new InboxManager()
