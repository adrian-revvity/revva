/**
 * Single SSE subscription to the OpenCode service, demultiplexed for main-process consumers.
 *
 * Gotcha (verified): the event stream is LIVE-ONLY — no replay. On every (re)connect,
 * consumers must re-fetch their own state (messages, forms, permissions). This bus emits
 * `stream:reconnect` so subsystems can resync.
 */
import { EventEmitter } from 'node:events'
import type { PushEvent } from '@shared/types'
import { pushToWindows } from '../push'
import { openCodeService } from './service'

class EventBus extends EventEmitter {
  private abort: AbortController | undefined
  private running = false

  start(): void {
    if (this.running) return
    this.running = true
    openCodeService.onStatus((status) => {
      if (status.state === 'connected') void this.connect()
      else this.stopStream()
    })
    if (openCodeService.connected) void this.connect()
  }

  stop(): void {
    this.running = false
    this.stopStream()
  }

  private stopStream(): void {
    this.abort?.abort()
    this.abort = undefined
  }

  private async connect(): Promise<void> {
    this.stopStream()
    const controller = new AbortController()
    this.abort = controller
    const client = openCodeService.api
    // Backoff grows on repeated failures; reset after a long-lived stream.
    let backoff = 1000
    while (this.running && !controller.signal.aborted && openCodeService.connected) {
      const startedAt = Date.now()
      try {
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          backoff = 1000
          if (process.env.REVVA_DEBUG_EVENTS) console.log('[bus]', (event as RawEvent).type)
          this.emit('event', event)
          this.pushActivity(event as RawEvent)
          this.pushInbox(event as RawEvent)
          this.pushModel(event as RawEvent)
        }
      } catch {
        // stream error — fall through to reconnect
      }
      if (!this.running || controller.signal.aborted) return
      if (Date.now() - startedAt > 60_000) backoff = 1000
      this.emit('stream:reconnect')
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 15_000)
    }
  }

  private pushActivity(event: RawEvent): void {
    const sessionId = event.data?.sessionID
    if (typeof sessionId !== 'string') return
    let running: boolean | undefined
    if (event.type === 'session.execution.started') running = true
    else if (
      event.type === 'session.execution.succeeded' ||
      event.type === 'session.execution.failed' ||
      event.type === 'session.execution.interrupted'
    ) running = false
    else if (event.type === 'session.status') {
      const status = event.data?.status as { type?: unknown } | undefined
      if (status?.type === 'busy' || status?.type === 'retry') running = true
      else if (status?.type === 'idle') running = false
    }
    if (running === undefined) return
    const update: PushEvent = { kind: 'session.activity', sessionId, running }
    pushToWindows(update)
  }

  private pushInbox(event: RawEvent): void {
    const sessionId = event.data?.sessionID
    if (typeof sessionId !== 'string') return
    if (!event.type.startsWith('session.inbox.')) return
    const update: PushEvent = { kind: 'session.queue', sessionId }
    pushToWindows(update)
  }

  private pushModel(event: RawEvent): void {
    if (event.type !== 'session.model.selected') return
    const sessionId = event.data?.sessionID
    if (typeof sessionId !== 'string') return
    const update: PushEvent = { kind: 'session.model', sessionId }
    pushToWindows(update)
  }
}

export const eventBus = new EventBus()

/** Minimal structural view of a pushed event; full union lives in @opencode/client. */
export interface RawEvent {
  type: string
  data?: Record<string, unknown>
  [key: string]: unknown
}
