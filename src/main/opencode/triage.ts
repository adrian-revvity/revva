/**
 * Triage inbox: the email-style feed of everything waiting on you.
 *
 * Two classes, merged into one ranked stream:
 *  1. needs-you — pending forms/permissions (delegated to inboxManager, live mirror);
 *  2. finished-unseen — chats/works whose run completed since you last looked
 *     (`seen_at < updated_at`; both managers maintain those columns).
 *
 * Opening the chat/cockpit marks the session seen; the feed re-ranks and the
 * next card slides in. Mark-read from the card does the same without opening.
 */
import { BrowserWindow } from 'electron'
import { getDb } from '../db'
import { inboxManager } from './inbox'
import { chatManager } from './chats'
import { workManager, UNREAD_WORTHY_STATES } from '../pipeline/works'
import { openCodeService } from './service'
import { IPC, type FinishedRun, type TriageEntry } from '@shared/types'

/** How far back an unseen finish still counts as actionable (stale ones don't). */
const UNREAD_WINDOW_MS = 7 * 24 * 3600_000

class TriageManager {
  list(): TriageEntry[] {
    const entries: TriageEntry[] = [
      ...inboxManager.list().map((item) => ({ type: 'pending' as const, item })),
      ...this.finishedRuns().map((item) => ({ type: 'finished' as const, item }))
    ]
    return entries.sort(rank)
  }

  /** Push the full ranked feed so an open Inbox view slides to the next card in place. */
  push(): void {
    const snapshot = this.list()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.eventPush, { kind: 'triage', entries: snapshot })
    }
  }

  /** Archive without reading. */
  markRead(source: 'chat' | 'work', id: string): void {
    if (source === 'chat') chatManager.markSeen(id)
    else workManager.markSeen(id)
    this.push()
  }

  private finishedRuns(): FinishedRun[] {
    const cutoff = Date.now() - UNREAD_WINDOW_MS
    const db = getDb()
    const out: FinishedRun[] = []
    const chats = db
      .prepare(
        'SELECT session_id, title, directory, updated_at FROM chat WHERE (seen_at IS NULL OR seen_at < updated_at) AND updated_at >= ?'
      )
      .all(cutoff) as Array<{ session_id: string; title: string; directory: string; updated_at: number }>
    for (const c of chats) {
      out.push({
        sessionID: c.session_id,
        source: 'chat',
        owner: c.title,
        directory: c.directory,
        updatedAt: c.updated_at
      })
    }
    const works = db
      .prepare(
        `SELECT id, ticket_key, worktree_dir, session_id, state, updated_at FROM work
         WHERE session_id IS NOT NULL AND state IN ('APPROVED','WAITING_HUMAN','REWORK','SHIPPED')
           AND (seen_at IS NULL OR seen_at < updated_at) AND updated_at >= ?`
      )
      .all(cutoff) as Array<{
      id: string
      ticket_key: string
      worktree_dir: string
      session_id: string
      state: string
      updated_at: number
    }>
    for (const w of works) {
      out.push({
        sessionID: w.session_id,
        source: 'work',
        workId: w.id,
        workState: w.state as FinishedRun['workState'],
        owner: w.ticket_key,
        directory: w.worktree_dir,
        updatedAt: w.updated_at
      })
    }
    // Attach message previews after the snapshot logic; async fills land as pushes.
    for (const run of out) void this.attachPreview(run)
    return out
  }

  /** Keyed by (session, updatedAt) so a fresh reply invalidates the cached tail. */
  private previews = new Map<string, string>()

  private previewKey(run: FinishedRun): string {
    return `${run.source}:${run.sessionID}:${run.updatedAt}`
  }

  private async attachPreview(run: FinishedRun): Promise<void> {
    if (!openCodeService.connected) return
    const key = this.previewKey(run)
    const cached = this.previews.get(key)
    if (cached) {
      run.preview = cached
      return
    }
    try {
      const res = await openCodeService.api.message.list({ sessionID: run.sessionID, order: 'desc', limit: 20 })
      let text = ''
      for (const m of res.data) {
        if (m.type !== 'assistant') continue
        for (const part of m.content ?? []) {
          const p = part as Record<string, unknown>
          if (p.type === 'text' && typeof p.text === 'string') text += p.text
        }
        break
      }
      const clean = text.trim().replace(/\s+/g, ' ')
      if (!clean) return
      const preview = clean.length > 280 ? `…${clean.slice(-280)}` : clean
      // Keep the cache bounded; previews are only needed while cards are unseen.
      if (this.previews.size > 200) this.previews.clear()
      this.previews.set(key, preview)
      run.preview = preview
      this.push()
    } catch {
      /* transcript unavailable — card renders without the preview */
    }
  }
}

/** needs-you first (oldest first), then finished-unseen (newest first). */
function rank(a: TriageEntry, b: TriageEntry): number {
  if (a.type !== b.type) return a.type === 'pending' ? -1 : 1
  if (a.type === 'pending' && b.type === 'pending') return a.item.createdAt - b.item.createdAt
  if (a.type === 'finished' && b.type === 'finished') return b.item.updatedAt - a.item.updatedAt
  return 0
}

export const triageManager = new TriageManager()
