/**
 * Estimates live model output throughput from streamed text and reasoning.
 * The rolling window uses wall-clock time, so gaps with no output lower the rate.
 */
import { eventBus, runningSignal, type RawEvent } from './bus'
import { sessionIndex } from './session-index'
import { pushToWindows } from '../push'
import type { PushEvent } from '@shared/types'

const WINDOW_MS = 10_000
const TICK_MS = 1_000
const CHARS_PER_TOKEN = 4

interface Sample {
  at: number
  chars: number
}

interface SessionRate {
  running: boolean
  startedAt: number
  lastOutputAt: number | undefined
  samples: Sample[]
}

class ThroughputMeter {
  private wired = false
  private timer: NodeJS.Timeout | undefined
  private sessions = new Map<string, SessionRate>()

  wire(): void {
    if (this.wired) return
    this.wired = true
    eventBus.on('event', (event: RawEvent) => this.onEvent(event))
    this.timer = setInterval(() => this.pushRunning(), TICK_MS)
    this.timer.unref?.()
  }

  private onEvent(event: RawEvent): void {
    const data = event.data ?? {}
    const sessionId = data.sessionID
    if (typeof sessionId !== 'string' || !sessionIndex.kindOf(sessionId)) return

    const now = Date.now()
    if (event.type === 'session.execution.started') {
      this.sessions.set(sessionId, { running: true, startedAt: now, lastOutputAt: undefined, samples: [] })
      this.push(sessionId, this.sessions.get(sessionId)!, now)
      return
    }

    const isOutput = event.type === 'session.text.delta' || event.type === 'session.reasoning.delta'
    const delta = isOutput && typeof data.delta === 'string' ? data.delta : ''
    let state = this.sessions.get(sessionId)
    if (!state && (isOutput || runningSignal(event) === true)) {
      state = { running: true, startedAt: now, lastOutputAt: undefined, samples: [] }
      this.sessions.set(sessionId, state)
    }
    if (!state) return

    if (delta) {
      state.samples.push({ at: now, chars: delta.length })
      state.lastOutputAt = now
    }

    const running = runningSignal(event)
    if (running !== undefined) state.running = running
    if (event.type === 'session.idle') state.running = false

    if (state.running) {
      this.prune(state, now)
      return
    }

    this.push(sessionId, state, now)
    this.sessions.delete(sessionId)
  }

  private pushRunning(): void {
    const now = Date.now()
    for (const [sessionId, state] of this.sessions) {
      if (!state.running) continue
      this.prune(state, now)
      this.push(sessionId, state, now)
    }
  }

  private push(sessionId: string, state: SessionRate, now: number): void {
    const windowStart = now - WINDOW_MS
    const chars = state.samples.reduce((sum, sample) => sum + (sample.at >= windowStart ? sample.chars : 0), 0)
    const elapsedMs = Math.max(1, Math.min(WINDOW_MS, now - state.startedAt))
    const windowTokens = chars / CHARS_PER_TOKEN
    const event: PushEvent = {
      kind: 'session.throughput',
      sessionId,
      tokensPerSecond: windowTokens / (elapsedMs / 1000),
      windowTokens,
      elapsedMs,
      msSinceOutput: state.lastOutputAt === undefined ? null : now - state.lastOutputAt,
      running: state.running
    }
    pushToWindows(event)
  }

  private prune(state: SessionRate, now: number): void {
    const cutoff = now - WINDOW_MS
    state.samples = state.samples.filter((sample) => sample.at >= cutoff)
  }
}

export const throughputMeter = new ThroughputMeter()
