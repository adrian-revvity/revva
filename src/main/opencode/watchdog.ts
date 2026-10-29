/**
 * Stale-session watchdog: spots conversations that Revva still believes are
 * running but have produced nothing for a while — the agent died mid-turn, the
 * provider dropped the stream, or the run hung on a tool that never returns.
 *
 * Detection is event-driven, not polled: every progress signal (execution start,
 * text delta, tool call, retry) stamps the session; a slow tick only checks the
 * elapsed time and pushes when a flag flips. Nothing is re-fetched per session.
 *
 * "Wake up" escalates the two ways a session actually goes quiet:
 *  - OpenCode no longer considers it active → it finished/died silently, so a
 *    plain `continue` prompt restarts the turn;
 *  - OpenCode still considers it active but emits nothing → it is wedged, so
 *    interrupt first, then prompt (stop/start).
 */
import { EventEmitter } from 'node:events'
import { openCodeService, describeError } from './service'
import { eventBus, runningSignal, type RawEvent } from './bus'
import { inboxManager } from './inbox'
import { workManager } from '../pipeline/works'
import { getDb, settingGet } from '../db'
import { sessionIndex } from './session-index'
import { pushToWindows } from '../push'
import type { StaleSession, WorkState } from '@shared/types'

/** Quiet longer than this (while marked running) is reported as stale. */
const DEFAULT_STALE_SECS = 90
/** After a wake attempt, stay quiet this long before blaming it again. */
const WAKE_GRACE_MS = 45_000
/** Cheap clock for the flip check; staleness itself is computed on read. */
const TICK_MS = 10_000
/** How long the wake action belongs to a session; after this the count resets. */
const WAKE_MEMORY_MS = 10 * 60_000
/** Between interrupting a wedged run and prompting it again. */
const INTERRUPT_SETTLE_MS = 1_000

/** What a successful wake does. The transcript shows this as a user message. */
const WAKE_PROMPT =
  'Continue where you left off. If you were interrupted, resume the step you were on; if the work is already done, say so in one line instead of starting over.'

interface Tracked {
  /** Last signal said the session is running. */
  running: boolean
  /** Last progress signal (start / delta / tool / busy). */
  lastBeat: number
  wakeAt: number | undefined
  wakeCount: number
  lastWakeError: string | undefined
}

/** Text/tool/status events that prove the session is still making progress. */
const PROGRESS_EVENTS = new Set([
  'session.execution.started',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.text.delta',
  'session.reasoning.delta',
  'session.text.started',
  'session.step.started',
  'session.step.streamed',
  'session.step.ended',
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.failed',
  'session.shell.started',
  'session.shell.ended',
  'session.compaction.started',
  'session.compaction.delta',
  'session.retry.scheduled',
  'session.inbox.delivered',
  'session.inbox.enqueued'
])

class Watchdog extends EventEmitter {
  private wired = false
  private timer: NodeJS.Timeout | undefined
  /** Flagged sessions as last pushed; the tick only pushes on a change. */
  private pushedKeys = ''
  private tracked = new Map<string, Tracked>()

  wire(): void {
    if (this.wired) return
    this.wired = true
    eventBus.on('event', (e: RawEvent) => this.onEvent(e))
    // SSE is live-only: after a reconnect we have missed everything, so adopt
    // OpenCode's own view of which sessions are busy and restart the clock.
    eventBus.on('stream:reconnect', () => void this.adoptActiveSessions())
    openCodeService.onStatus((s) => {
      if (s.state === 'connected') void this.adoptActiveSessions()
      if (s.state === 'missing' || s.state === 'error') this.tracked.clear()
    })
    if (!this.timer) {
      this.timer = setInterval(() => this.push(), TICK_MS)
      this.timer.unref?.()
    }
  }

  /** Threshold in ms, user-tunable so a slow model isn't flagged at 90 s. */
  private staleMs(): number {
    const secs = settingGet<number>('watchdog.staleSecs')
    return (typeof secs === 'number' && secs >= 30 && secs <= 3600 ? secs : DEFAULT_STALE_SECS) * 1000
  }

  list(): StaleSession[] {
    if (!openCodeService.connected) return []
    const now = Date.now()
    const limit = this.staleMs()
    const out: StaleSession[] = []
    for (const [sessionId, t] of this.tracked) {
      if (!this.isStale(sessionId, t, now, limit)) continue
      out.push({
        sessionId,
        kind: sessionIndex.kindOf(sessionId) ?? 'chat',
        owner: this.ownerLabel(sessionId),
        directory: this.directoryOf(sessionId),
        lastBeat: t.lastBeat,
        silentMs: now - t.lastBeat,
        workId: this.workIdOf(sessionId),
        wakeCount: t.wakeCount,
        lastWakeError: t.lastWakeError
      })
    }
    return out.sort((a, b) => b.silentMs - a.silentMs)
  }

  /** Snapshot push for the sidebar/inbox warning; skipped while nothing changed. */
  private push(): void {
    const items = this.list()
    const keys = items.map((i) => i.sessionId).join(',')
    if (keys === this.pushedKeys) return
    this.pushedKeys = keys
    pushToWindows({ kind: 'session.stale', items })
  }

  private isStale(sessionId: string, t: Tracked, now: number, limit: number): boolean {
    if (!t.running) return false
    if (!this.isOwned(sessionId)) return false
    if (now - t.lastBeat < limit) return false
    // A wake is in flight / just landed — give the model time to answer.
    if (t.wakeAt && now - t.wakeAt < WAKE_GRACE_MS) return false
    // Blocked on an answer is not stale — the inbox already says "Needs you".
    if (inboxManager.list().some((item) => item.sessionID === sessionId)) return false
    if (this.workStateOf(sessionId) === 'WAITING_HUMAN') return false
    return true
  }

  private isOwned(sessionId: string): boolean {
    const kind = sessionIndex.kindOf(sessionId)
    return kind === 'chat' || kind === 'work'
  }

  private track(sessionId: string, now: number): Tracked {
    const existing = this.tracked.get(sessionId)
    if (existing) return existing
    const fresh: Tracked = { running: false, lastBeat: now, wakeAt: undefined, wakeCount: 0, lastWakeError: undefined }
    this.tracked.set(sessionId, fresh)
    return fresh
  }

  /** Forget a session entirely (deleted chat, abandoned work). */
  forget(sessionId: string): void {
    if (this.tracked.delete(sessionId)) this.push()
  }

  /**
   * User pressed "Wake up". Returns what it did so the UI can say so honestly —
   * a wake that finds the session already gone is an error, not a success.
   */
  async wake(sessionId: string): Promise<string> {
    if (!openCodeService.connected) throw new Error('OpenCode is not connected.')
    if (!this.isOwned(sessionId)) throw new Error('This conversation is no longer tracked by Revva.')
    await this.assertSessionExists(sessionId)

    const active = await this.isActive(sessionId)
    const t = this.track(sessionId, Date.now())
    const previousWakeAt = t.wakeAt
    let note: string
    if (active) {
      // Wedged: OpenCode still owns the run, so a prompt alone would only queue.
      await this.interrupt(sessionId)
      await new Promise((r) => setTimeout(r, INTERRUPT_SETTLE_MS))
      await this.continuePrompt(sessionId)
      note = 'Interrupted the stuck run and asked it to continue.'
    } else {
      await this.continuePrompt(sessionId)
      note = 'The run had already stopped — sent “continue” to restart it.'
    }
    const now = Date.now()
    t.wakeAt = now
    t.lastBeat = now
    t.running = true
    // Attempts only group while they belong to the same stall.
    t.wakeCount = previousWakeAt !== undefined && now - previousWakeAt < WAKE_MEMORY_MS ? t.wakeCount + 1 : 1
    t.lastWakeError = undefined
    this.push()
    return note
  }

  private async assertSessionExists(sessionId: string): Promise<void> {
    try {
      await openCodeService.api.session.get({ sessionID: sessionId })
    } catch {
      throw new Error('This conversation no longer exists in OpenCode.')
    }
  }

  /** OpenCode's own answer to "is this session still executing?". */
  private async isActive(sessionId: string): Promise<boolean> {
    try {
      const active = await openCodeService.api.session.active()
      return Object.keys(active).includes(sessionId)
    } catch (err) {
      // Unknown: assume the safer branch — prompt without interrupting a live run.
      console.warn('[watchdog] active-session probe failed:', describeError(err))
      return false
    }
  }

  private async interrupt(sessionId: string): Promise<void> {
    try {
      await openCodeService.api.session.interrupt({ sessionID: sessionId })
    } catch (err) {
      // Already stopped / interrupt unsupported — prompting is still worth trying.
      console.warn('[watchdog] interrupt failed:', describeError(err))
    }
  }

  /** Send the wake prompt through the owning manager so pipeline state stays correct. */
  private async continuePrompt(sessionId: string): Promise<void> {
    try {
      if (sessionIndex.kindOf(sessionId) === 'work') await workManager.followUp(sessionId, WAKE_PROMPT)
      else await openCodeService.api.session.prompt({ sessionID: sessionId, text: WAKE_PROMPT })
    } catch (err) {
      const t = this.track(sessionId, Date.now())
      t.lastWakeError = describeError(err)
      this.push()
      throw new Error(`Could not wake this conversation: ${describeError(err)}`)
    }
  }

  private onEvent(e: RawEvent): void {
    const sessionId = e.data?.sessionID
    if (typeof sessionId !== 'string') return
    if (!this.isOwned(sessionId)) return
    const running = runningSignal(e)
    if (e.type === 'session.deleted') {
      this.forget(sessionId)
      return
    }
    if (!PROGRESS_EVENTS.has(e.type) && running === undefined && e.type !== 'session.status') return

    const now = Date.now()
    const t = this.track(sessionId, now)
    if (running === true) t.running = true
    else if (running === false) t.running = false
    if (PROGRESS_EVENTS.has(e.type) || e.type === 'session.status') t.lastBeat = now
  }

  /** Adopt OpenCode's busy set: what it lists is running, everything else isn't. */
  private async adoptActiveSessions(): Promise<void> {
    if (!openCodeService.connected) return
    try {
      const active = new Set(Object.keys(await openCodeService.api.session.active()))
      const now = Date.now()
      for (const id of this.knownSessions()) {
        const t = this.track(id, now)
        if (active.has(id)) {
          // A live run we just learned about gets a full grace period.
          if (!t.running) {
            t.running = true
            t.lastBeat = now
          }
        } else {
          t.running = false
        }
      }
      this.push()
    } catch (err) {
      console.warn('[watchdog] adopt active sessions failed:', describeError(err))
    }
  }

  private knownSessions(): string[] {
    const db = getDb()
    const chats = db.prepare('SELECT session_id FROM chat').all() as Array<{ session_id: string }>
    const works = db
      .prepare("SELECT session_id FROM work WHERE session_id IS NOT NULL AND state NOT IN ('SHIPPED','ABANDONED')")
      .all() as Array<{ session_id: string }>
    return [...new Set([...chats, ...works].map((r) => r.session_id).filter((id) => !!id && this.isOwned(id)))]
  }

  private ownerLabel(sessionId: string): string {
    const chat = getDb().prepare('SELECT title FROM chat WHERE session_id = ?').get(sessionId) as { title: string } | undefined
    if (chat) return chat.title
    const work = getDb().prepare('SELECT ticket_key FROM work WHERE session_id = ?').get(sessionId) as { ticket_key: string } | undefined
    return work?.ticket_key ?? sessionId
  }

  private directoryOf(sessionId: string): string {
    const chat = getDb().prepare('SELECT directory FROM chat WHERE session_id = ?').get(sessionId) as { directory: string } | undefined
    if (chat) return chat.directory
    const work = getDb().prepare('SELECT worktree_dir AS directory FROM work WHERE session_id = ?').get(sessionId) as { directory: string } | undefined
    return work?.directory ?? ''
  }

  private workIdOf(sessionId: string): string | undefined {
    const row = getDb().prepare('SELECT id FROM work WHERE session_id = ?').get(sessionId) as { id: string } | undefined
    return row?.id
  }

  private workStateOf(sessionId: string): WorkState | undefined {
    const row = getDb().prepare('SELECT state FROM work WHERE session_id = ?').get(sessionId) as { state: string } | undefined
    return row?.state as WorkState | undefined
  }
}

export const watchdog = new Watchdog()
