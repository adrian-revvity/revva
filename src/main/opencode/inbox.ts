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
import { sessionIndex } from './session-index'
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
  private resyncing = false
  async resync(): Promise<void> {
    if (!openCodeService.connected) return
    if (this.resyncing) return // two reconnects in one resync window: the final swap below is authoritative anyway
    this.resyncing = true
    try {
      const sessionIds = this.knownSessions()
      const fresh = new Map<string, PendingItem>()
      // Sessions are independent; per-session the two list calls are too.
      await Promise.allSettled(
        sessionIds.map(async (sessionID) => {
          const dir = this.directoryOf(sessionID)
          const owner = this.ownerLabel(sessionID)
          const [forms, perms] = await Promise.allSettled([
            openCodeService.api.session.form.list({ sessionID }),
            openCodeService.api.permission.list({ sessionID })
          ])
          // A rejected list means the session is gone/unreadable — skip it (as the old per-call catch did).
          if (forms.status === 'fulfilled') {
            for (const f of forms.value) {
              const key = `form:${f.id}`
              fresh.set(key, {
                kind: 'form',
                id: f.id,
                sessionID,
                title: f.title,
                directory: dir,
                // Keep the original wait time so the oldest-first order survives reconnects.
                createdAt: this.pending.get(key)?.createdAt ?? Date.now(),
                fields: f.fields as unknown as PendingItem['fields'],
                owner
              })
            }
          }
          if (perms.status === 'fulfilled') {
            for (const p of perms.value) {
              const key = `perm:${p.id}`
              fresh.set(key, {
                kind: 'permission',
                id: p.id,
                sessionID,
                title: p.message ?? `${p.action} ${p.resources.slice(0, 2).join(', ')}`,
                directory: dir,
                createdAt: this.pending.get(key)?.createdAt ?? Date.now(),
                action: p.action,
                resources: p.resources,
                owner
              })
            }
          }
        })
      )
      this.pending = fresh
      this.push()
    } finally {
      this.resyncing = false
    }
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
        break
      }
      case 'permission.replied': {
        const id = String(data.requestID ?? data.id ?? '')
        if (id && this.pending.delete(`perm:${id}`)) this.push()
        break
      }
    }
  }

  private isKnown(sessionID: string): boolean {
    return sessionIndex.kindOf(sessionID) !== undefined
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

export const inboxManager = new InboxManager()
