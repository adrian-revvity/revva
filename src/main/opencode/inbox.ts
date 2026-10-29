/**
 * Question Inbox (M2): aggregates pending agent questions (forms) and permission
 * requests across every session Revva knows about (chats + ticket works).
 *
 * SSE is live-only, so state is a memory mirror re-synced on connect/reconnect via
 * session-scoped listings (global /api/form is location-scoped, so we go per session).
 * Every answer is written to an audit table.
 */
import { EventEmitter } from 'node:events'
import { getDb } from '../db'
import { sessionIndex } from './session-index'
import { openCodeService, describeError } from './service'
import { eventBus, type RawEvent } from './bus'
import type { PendingItem } from '@shared/types'
import { pushToWindows } from '../push'
import { notifyInbound } from '../notify'
import { compactLatestAnswer } from './transcript-requests'
import { performanceMeter } from './performance'

interface InboxRow {
  session_id: string
  kind: 'form' | 'permission'
  title: string
  payload: string | null
  answer: string | null
  answered_at: number | null
}

class InboxManager extends EventEmitter {
  private wired = false
  /** key: `form:<id>` / `perm:<id>` — live mirror of pending items. */
  private pending = new Map<string, PendingItem>()

  wire(): void {
    if (this.wired) return
    this.wired = true
    eventBus.on('event', (e: RawEvent) => this.onEvent(e))
    eventBus.on('stream:reconnect', () => void this.resync())
    openCodeService.onStatus((s) => {
      if (s.state !== 'connected') {
        this.recovery?.abort()
        this.clearPreviews()
      }
    })
    if (eventBus.established && openCodeService.connected) void this.resync()
  }

  list(): PendingItem[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Drop questions belonging to a review that is no longer being tracked. */
  forgetSession(sessionID: string): void {
    let changed = false
    for (const [key, item] of this.pending) {
      if (item.sessionID === sessionID) {
        this.pending.delete(key)
        changed = true
      }
    }
    if (changed) this.push()
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
  private resyncAgain = false
  private revision = 0
  private recovery: AbortController | undefined
  private recoveredGeneration = -1
  private scanningGeneration = -1
  async resync(force = false): Promise<void> {
    if (!openCodeService.connected) return
    const generation = eventBus.generation
    if (this.resyncing) {
      if (generation !== this.scanningGeneration || force) {
        this.resyncAgain = true
        if (generation !== this.scanningGeneration) this.recovery?.abort()
      }
      return
    }
    if (!force && generation === this.recoveredGeneration) return
    this.resyncing = true
    this.scanningGeneration = generation
    const controller = new AbortController()
    this.recovery = controller
    if (generation !== this.recoveredGeneration) this.clearPreviews()
    performanceMeter.add('inbox.scans')
    try {
      const revision = this.revision
      const sessionIds = this.knownSessions()
      const active = await performanceMeter.request('inbox.active', () => openCodeService.api.session.active({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })).catch(() => ({}))
      const blocked = new Set([...this.pending.values()].map((item) => item.sessionID))
      sessionIds.sort((a, b) => Number(b in active || blocked.has(b)) - Number(a in active || blocked.has(a)))
      const fresh = new Map<string, PendingItem>()
      // Four workers, two independent calls each: at most eight recovery calls.
      let next = 0
      await Promise.allSettled(Array.from({ length: Math.min(4, sessionIds.length) }, async () => {
        while (next < sessionIds.length && !controller.signal.aborted) {
          const sessionID = sessionIds[next++]!
          const dir = this.directoryOf(sessionID)
          const owner = this.ownerLabel(sessionID)
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
          const [forms, perms] = await Promise.allSettled([
            performanceMeter.request('inbox.forms', () => openCodeService.api.session.form.list({ sessionID }, { signal })),
            performanceMeter.request('inbox.permissions', () => openCodeService.api.permission.list({ sessionID }, { signal }))
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
          } else {
            for (const [key, item] of this.pending) if (item.sessionID === sessionID && item.kind === 'form') fresh.set(key, item)
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
          } else {
            for (const [key, item] of this.pending) if (item.sessionID === sessionID && item.kind === 'permission') fresh.set(key, item)
          }
        }
      }))
      if (controller.signal.aborted || generation !== eventBus.generation) return
      if (revision !== this.revision) {
        this.resyncAgain = true
        return
      }
      for (const [key, item] of fresh) if (!this.isKnown(item.sessionID)) fresh.delete(key)
      this.pending = fresh
      this.recoveredGeneration = generation
      this.push(false)
      // Preview tails are fetched after the snapshot is up (resync runs on every
      // connect; message.list per session would slow the initial paint otherwise).
      for (const [key, item] of fresh) this.attachLastMessage(key, item.sessionID)
    } finally {
      this.resyncing = false
      if (this.resyncAgain) {
        this.resyncAgain = false
        void this.resync(true)
      }
    }
  }

  private knownSessions(): string[] {
    const db = getDb()
    const chats = db.prepare('SELECT session_id FROM chat').all() as Array<{ session_id: string }>
    const works = db
      .prepare("SELECT session_id FROM work WHERE session_id IS NOT NULL AND state NOT IN ('SHIPPED','ABANDONED')")
      .all() as Array<{ session_id: string }>
    const reviews = db.prepare("SELECT session_id FROM review WHERE session_id IS NOT NULL AND status = 'running'").all() as Array<{ session_id: string }>
    return [...new Set([...chats, ...works, ...reviews].map((r) => r.session_id).filter((id) => !!id && this.isKnown(id)))]
  }

  private directoryCache = new Map<string, string>()

  private directoryOf(sessionID: string): string {
    const cached = this.directoryCache.get(sessionID)
    if (cached) return cached
    const row =
      (getDb().prepare('SELECT directory FROM chat WHERE session_id = ?').get(sessionID) as { directory: string } | undefined) ??
      (getDb().prepare('SELECT worktree_dir AS directory FROM work WHERE session_id = ?').get(sessionID) as { directory: string } | undefined) ??
      (getDb().prepare('SELECT w.worktree_dir AS directory FROM review r JOIN work w ON w.id = r.work_id WHERE r.session_id = ?').get(sessionID) as { directory: string } | undefined)
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
    const review = getDb().prepare('SELECT w.ticket_key, r.role FROM review r JOIN work w ON w.id = r.work_id WHERE r.session_id = ?').get(sessionID) as { ticket_key: string; role: string } | undefined
    if (review) return `${review.ticket_key} · ${review.role} review`
    return sessionID
  }

  /**
   * Tail of the agent's last assistant message, so an inbox card says what the
   * agent was doing when it blocked — without opening the chat. Best-effort.
   */
  private async lastMessage(sessionID: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const text = await compactLatestAnswer(sessionID, this.previewGeneration, signal)
      const clean = text?.trim().replace(/\s+/g, ' ')
      return clean ? clean.length > 280 ? `…${clean.slice(-280)}` : clean : undefined
    } catch {
      /* transcript unavailable — card renders without the preview */
    }
    return undefined
  }

  private onEvent(e: RawEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>
    if (['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.revert.committed', 'session.revert.cleared', 'session.compaction.ended', 'session.message.content.updated'].includes(e.type) && typeof data.sessionID === 'string') {
      this.previews.get(data.sessionID)?.controller.abort()
      this.previews.delete(data.sessionID)
    }
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
  private previews = new Map<string, { controller: AbortController; promise: Promise<string | undefined> }>()
  private previewGeneration = 0
  private clearPreviews(): void {
    this.previewGeneration++
    for (const entry of this.previews.values()) entry.controller.abort()
    this.previews.clear()
  }
  private attachLastMessage(key: string, sessionID: string): void {
    let entry = this.previews.get(sessionID)
    if (!entry) {
      const controller = new AbortController()
      entry = { controller, promise: this.lastMessage(sessionID, controller.signal) }
      this.previews.set(sessionID, entry)
      while (this.previews.size > 128) {
        const oldest = this.previews.keys().next().value!
        this.previews.get(oldest)?.controller.abort()
        this.previews.delete(oldest)
      }
    }
    const current = entry
    void current.promise.then((text) => {
      if (this.previews.get(sessionID) !== current || current.controller.signal.aborted) return
      const item = this.pending.get(key)
      if (!item || item.sessionID !== sessionID || !text || item.lastMessage === text) return
      item.lastMessage = text
      this.push(false)
    })
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
    notifyInbound(
      item.sessionID,
      item.kind === 'form' ? 'Question from agent' : 'Permission request',
      `${item.owner ?? item.directory}\n${item.title}`
    )
  }

  private push(stateChanged = true): void {
    if (stateChanged) this.revision++
    this.emit('changed')
    pushToWindows({ kind: 'inbox', items: this.list() })
  }
}

export const inboxManager = new InboxManager()
