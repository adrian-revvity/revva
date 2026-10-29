/**
 * Output tokens / wall-clock seconds since Send, frozen when execution ends.
 * Streaming is estimated; completed steps use the provider's token counts.
 */
import { eventBus, runningSignal, type RawEvent } from './bus'
import { sessionIndex } from './session-index'
import { pushToWindows } from '../push'
import type { PushEvent } from '@shared/types'

const TICK_MS = 1_000
const CHARS_PER_TOKEN = 4

interface StepOutput {
  /** Characters per content part; completed payloads replace streamed fragments. */
  parts: Map<string, number>
  tokens?: number
}

interface SessionRate {
  running: boolean
  startedAt: number
  lastOutputAt: number | undefined
  awaitingExecution: boolean
  steps: Map<string, StepOutput>
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

  /** Called before prompt submission so preparation and request latency count too. */
  async measurePrompt(sessionId: string, sentAt: unknown, submit: () => Promise<void>): Promise<void> {
    // A queued/steered follow-up must not reset an interaction still in flight.
    const current = this.sessions.get(sessionId)
    const now = Date.now()
    const startedAt = typeof sentAt === 'number' && Number.isFinite(sentAt) && sentAt > 0 && sentAt <= now
      ? sentAt
      : now
    const state = current ?? this.begin(sessionId, startedAt, true)
    try {
      await submit()
    } catch (error) {
      if (!current && this.sessions.get(sessionId) === state && state.awaitingExecution) {
        state.running = false
        this.push(sessionId, state, Date.now())
        this.sessions.delete(sessionId)
      }
      throw error
    }
  }

  private begin(sessionId: string, startedAt: number, awaitingExecution = false): SessionRate {
    const state: SessionRate = {
      running: true, startedAt, lastOutputAt: undefined, awaitingExecution, steps: new Map()
    }
    this.sessions.set(sessionId, state)
    this.push(sessionId, state, Date.now())
    return state
  }

  private onEvent(event: RawEvent): void {
    const data = event.data ?? {}
    const sessionId = data.sessionID
    if (typeof sessionId !== 'string' || !sessionIndex.kindOf(sessionId)) return

    const now = Date.now()
    if (event.type === 'session.execution.started') {
      const pending = this.sessions.get(sessionId)
      if (pending?.awaitingExecution) pending.awaitingExecution = false
      else this.begin(sessionId, now)
      return
    }

    let output: { key: string; text: string; append: boolean; fallback?: boolean } | undefined
    switch (event.type) {
      case 'session.text.delta':
      case 'session.reasoning.delta':
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const append = event.type.endsWith('.delta')
        const text = append ? data.delta : data.text
        const kind = event.type.startsWith('session.text.') ? 'text' : 'reasoning'
        if (typeof data.ordinal === 'number' && typeof text === 'string') {
          output = { key: `${kind}:${data.ordinal}`, text, append }
        }
        break
      }
      case 'session.tool.input.delta':
      case 'session.tool.input.ended': {
        const append = event.type.endsWith('.delta')
        const text = append ? data.delta : data.text
        if (typeof data.id === 'string' && typeof text === 'string') {
          output = { key: `tool:${data.id}`, text, append }
        }
        break
      }
      case 'session.tool.called': {
        // Some providers deliver a complete tool call without input fragments.
        if (typeof data.id === 'string' && data.input && typeof data.input === 'object') {
          output = { key: `tool:${data.id}`, text: JSON.stringify(data.input), append: false, fallback: true }
        }
        break
      }
    }
    const isStepEnd = event.type === 'session.step.ended' || event.type === 'session.step.failed'
    let state = this.sessions.get(sessionId)
    if (!state && (output || event.type === 'session.step.started' || runningSignal(event) === true)) {
      state = this.begin(sessionId, now)
    }
    if (!state) return

    const messageId = data.assistantMessageID
    if (typeof messageId === 'string' && (output || isStepEnd || event.type === 'session.step.started')) {
      const step = state.steps.get(messageId) ?? { parts: new Map<string, number>() }
      if (output && (!output.fallback || !step.parts.has(output.key))) {
        const previous = step.parts.get(output.key) ?? 0
        const chars = output.append ? previous + output.text.length : output.text.length
        step.parts.set(output.key, chars)
        if (chars > previous) state.lastOutputAt = now
      }
      if (isStepEnd) {
        const usage = data.tokens as { output?: unknown; reasoning?: unknown } | undefined
        if (typeof usage?.output === 'number' && typeof usage.reasoning === 'number') {
          const tokens = usage.output + usage.reasoning
          if (Number.isFinite(tokens) && tokens >= 0) step.tokens = tokens
        }
      }
      state.steps.set(messageId, step)
    }

    const running = runningSignal(event)
    if (running !== undefined) state.running = running
    if (event.type === 'session.idle') state.running = false

    if (state.running) return

    this.push(sessionId, state, now)
    this.sessions.delete(sessionId)
  }

  private pushRunning(): void {
    const now = Date.now()
    for (const [sessionId, state] of this.sessions) {
      if (!sessionIndex.kindOf(sessionId)) {
        this.sessions.delete(sessionId)
        continue
      }
      if (!state.running) continue
      this.push(sessionId, state, now)
    }
  }

  private push(sessionId: string, state: SessionRate, now: number): void {
    const elapsedMs = Math.max(1, now - state.startedAt)
    let totalTokens = 0
    let estimated = state.steps.size === 0
    for (const step of state.steps.values()) {
      const chars = [...step.parts.values()].reduce((sum, count) => sum + count, 0)
      totalTokens += step.tokens ?? chars / CHARS_PER_TOKEN
      if (step.tokens === undefined) estimated = true
    }
    const event: PushEvent = {
      kind: 'session.throughput',
      sessionId,
      tokensPerSecond: totalTokens / (elapsedMs / 1000),
      totalTokens,
      estimated,
      elapsedMs,
      msSinceOutput: state.lastOutputAt === undefined ? null : now - state.lastOutputAt,
      running: state.running
    }
    pushToWindows(event)
  }

}

export const throughputMeter = new ThroughputMeter()
