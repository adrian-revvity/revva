/**
 * Output tokens / wall-clock seconds since Send, frozen when execution ends.
 * Streaming is estimated; completed steps use the provider's token counts.
 *
 * Idle time is attributed by phase: quiet while tool calls are in flight is
 * tool time; other time includes TTFT, streaming, local preparation and retries.
 * Attribution is done on event arrival in O(1); the only timer is the 1 s tick.
 */
import { eventBus, runningSignal, type RawEvent } from './bus'
import { sessionIndex } from './session-index'
import { openCodeService } from './service'
import { pushToWindows } from '../push'
import type { ThroughputSnapshot } from '@shared/types'

const TICK_MS = 1_000
const CHARS_PER_TOKEN = 4

interface StepOutput {
  /** Characters per content part; completed payloads replace streamed fragments. */
  parts: Map<string, number>
  chars: number
  tokens?: number
}

interface SessionRate {
  running: boolean
  startedAt: number
  lastOutputAt: number | undefined
  awaitingExecution: boolean
  /** Called-but-unresolved tool calls; >0 means the current gap belongs to a tool. */
  pendingTools: Set<string>
  phaseAt: number
  /** Elapsed phase totals. The unfinished interval is folded in at push. */
  toolIdleMs: number
  modelIdleMs: number
  steps: Map<string, StepOutput>
  totalTokens: number
  estimatedSteps: number
  updatedAt: number
}

class ThroughputMeter {
  private wired = false
  private timer: NodeJS.Timeout | undefined
  private sessions = new Map<string, SessionRate>()
  /** One pending snapshot per session; completions cannot be overwritten by old ticks. */
  private pending = new Map<string, ThroughputSnapshot>()

  wire(): void {
    if (this.wired) return
    this.wired = true
    eventBus.on('event', (event: RawEvent) => this.onEvent(event))
    eventBus.on('stream:reconnect', () => void this.reconcileActive())
  }

  /** Called before prompt submission so preparation and request latency count too. */
  async measurePrompt<T>(sessionId: string, sentAt: unknown, submit: () => Promise<T>): Promise<T> {
    // A queued/steered follow-up must not reset an interaction still in flight.
    const current = this.sessions.get(sessionId)
    const now = Date.now()
    const startedAt = typeof sentAt === 'number' && Number.isFinite(sentAt) && sentAt > 0 && sentAt <= now
      ? sentAt
      : now
    const state = current ?? this.begin(sessionId, startedAt, true)
    try {
      const result = await submit()
      if (result === 'queued' && !current && this.sessions.get(sessionId) === state && state.awaitingExecution) {
        state.running = false
        this.push(sessionId, state, Date.now())
        this.sessions.delete(sessionId)
      }
      return result
    } catch (error) {
      if (!current && this.sessions.get(sessionId) === state && state.awaitingExecution) {
        this.settleGap(state, Date.now())
        state.running = false
        this.push(sessionId, state, Date.now())
        this.sessions.delete(sessionId)
      }
      throw error
    }
  }

  private begin(sessionId: string, startedAt: number, awaitingExecution = false): SessionRate {
    const state: SessionRate = {
      running: true, startedAt, lastOutputAt: undefined, awaitingExecution,
      pendingTools: new Set(), phaseAt: startedAt, toolIdleMs: 0, modelIdleMs: 0, steps: new Map(),
      totalTokens: 0, estimatedSteps: 0, updatedAt: Date.now()
    }
    this.sessions.set(sessionId, state)
    this.push(sessionId, state, Date.now())
    return state
  }

  /**
   * Attribute the interval before changing phase. This cursor is separate from
   * lastOutputAt: a tool can finish midway through a single visible idle gap.
   * Non-tool intervals include streaming and local work, not just model latency.
   */
  private settleGap(state: SessionRate, now: number): void {
    const gap = Math.max(0, now - state.phaseAt)
    if (gap <= 0) return
    if (state.pendingTools.size > 0) state.toolIdleMs += gap
    else state.modelIdleMs += gap
    state.phaseAt = now
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
    state.updatedAt = now

    const messageId = data.assistantMessageID
    if (typeof messageId === 'string' && (output || isStepEnd || event.type === 'session.step.started')) {
      let step = state.steps.get(messageId)
      if (!step) {
        step = { parts: new Map<string, number>(), chars: 0 }
        state.steps.set(messageId, step)
        state.estimatedSteps++
      }
      const oldTokens = step.tokens ?? step.chars / CHARS_PER_TOKEN
      if (output && (!output.fallback || !step.parts.has(output.key))) {
        const previous = step.parts.get(output.key) ?? 0
        const chars = output.append ? previous + output.text.length : output.text.length
        step.parts.set(output.key, chars)
        step.chars += chars - previous
        if (chars > previous) {
          this.settleGap(state, now)
          state.lastOutputAt = now
        }
      }
      if (isStepEnd) {
        const usage = data.tokens as { output?: unknown; reasoning?: unknown } | undefined
        if (typeof usage?.output === 'number' && typeof usage.reasoning === 'number') {
          const tokens = usage.output + usage.reasoning
          if (Number.isFinite(tokens) && tokens >= 0) {
            if (step.tokens === undefined) state.estimatedSteps--
            step.tokens = tokens
          }
        }
      }
      state.totalTokens += (step.tokens ?? step.chars / CHARS_PER_TOKEN) - oldTokens
    }

    // Settle BEFORE changing phase: tool completion and the following model
    // prefill can share one visible gap without misattributing the tool's time.
    if (typeof data.id === 'string') {
      if (event.type === 'session.tool.called') {
        this.settleGap(state, now)
        state.pendingTools.add(data.id)
      } else if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
        this.settleGap(state, now)
        state.pendingTools.delete(data.id)
      }
    }
    if (event.type === 'session.step.started' && state.pendingTools.size) {
      this.settleGap(state, now)
      state.pendingTools.clear()
    }

    const running = runningSignal(event)
    if (running !== undefined) state.running = running
    if (event.type === 'session.idle') state.running = false

    if (state.running) return

    // Frozen snapshot: close the last gap (interrupted mid-tool → blame the tool)
    // and reset the counter so a re-run starts clean.
    this.settleGap(state, now)
    state.pendingTools.clear()
    this.push(sessionId, state, now)
    this.sessions.delete(sessionId)
  }

  private pushRunning(): void {
    const now = Date.now()
    for (const [sessionId, state] of this.sessions) {
      if (!sessionIndex.kindOf(sessionId)) {
        this.sessions.delete(sessionId)
        this.pending.delete(sessionId)
        continue
      }
      if (!state.running) continue
      this.push(sessionId, state, now)
    }
    if (this.pending.size) {
      pushToWindows({ kind: 'session.throughput', items: [...this.pending.values()] })
      this.pending.clear()
    }
    if (!this.sessions.size && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Recover missed completion/start signals without polling individual sessions. */
  private async reconcileActive(): Promise<void> {
    const requestedAt = Date.now()
    try {
      const active = new Set(Object.keys(await openCodeService.api.session.active()))
      const now = Date.now()
      for (const [id, state] of this.sessions) {
        if (state.updatedAt >= requestedAt || state.awaitingExecution || active.has(id)) continue
        this.settleGap(state, now)
        state.running = false
        this.push(id, state, now)
        this.sessions.delete(id)
      }
      for (const id of active) {
        if (sessionIndex.kindOf(id) && !this.sessions.has(id)) this.begin(id, now)
      }
    } catch {
      // Do not invent completion when the service's state is unavailable.
    }
  }

  private push(sessionId: string, state: SessionRate, now: number): void {
    const elapsedMs = Math.max(1, now - state.startedAt)
    const totalTokens = state.totalTokens
    const estimated = state.steps.size === 0 || state.estimatedSteps > 0
    // Fold the open gap into its current phase so the live numbers add up.
    let toolIdleMs = state.toolIdleMs
    let modelIdleMs = state.modelIdleMs
    if (state.running) {
      const open = Math.max(0, now - state.phaseAt)
      if (state.pendingTools.size > 0) toolIdleMs += open
      else modelIdleMs += open
    }
    const event: ThroughputSnapshot = {
      sessionId,
      tokensPerSecond: totalTokens / (elapsedMs / 1000),
      totalTokens,
      estimated,
      elapsedMs,
      msSinceOutput: state.lastOutputAt === undefined ? null : now - state.lastOutputAt,
      toolIdleMs,
      modelIdleMs,
      running: state.running
    }
    this.pending.set(sessionId, event)
    if (!this.timer) {
      this.timer = setInterval(() => this.pushRunning(), TICK_MS)
      this.timer.unref?.()
    }
  }

}

export const throughputMeter = new ThroughputMeter()
