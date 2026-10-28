/**
 * Single SSE subscription to the OpenCode service, demultiplexed for main-process consumers.
 *
 * Gotcha (verified): the event stream is LIVE-ONLY — no replay. On every (re)connect,
 * consumers must re-fetch their own state (messages, forms, permissions). This bus emits
 * `stream:reconnect` so subsystems can resync.
 */
import { EventEmitter } from 'node:events'
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
}

export const eventBus = new EventBus()

/** Minimal structural view of a pushed event; full union lives in @opencode/client. */
export interface RawEvent {
  type: string
  data?: Record<string, unknown>
  [key: string]: unknown
}
