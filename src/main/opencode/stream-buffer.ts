/**
 * Accumulates `session.text.delta` fragments per (sessionId, assistantMessageID)
 * and pushes the accumulated text to renderers, coalesced to one IPC per
 * COALESCE_MS per message. Per-token IPC is quadratic in message length and
 * floods the renderer's render loop; 20 Hz is indistinguishable from "live".
 */
import type { PushEvent } from '@shared/types'
import { pushToWindows } from '../push'

const COALESCE_MS = 50

type DeltaKind = 'chat.delta' | 'work.delta' | 'review.delta'

/** One raw fragment; `workId` is required by the work/review channels. */
export interface DeltaSource {
  kind: DeltaKind
  sessionId: string
  messageId: string
  text: string
  workId?: string
}

interface Entry {
  text: string
  source: DeltaSource
}

class StreamBuffer {
  private accum = new Map<string, Entry>()
  private dirty = new Set<string>()
  private timer: NodeJS.Timeout | undefined

  /** Feed one raw delta; accumulated pushes start/continue on their own timer. */
  push(source: DeltaSource): void {
    const key = `${source.sessionId}:${source.messageId}`
    const entry = this.accum.get(key) ?? { text: '', source }
    entry.text += source.text
    entry.source = source
    this.accum.set(key, entry)
    this.dirty.add(key)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const id of this.dirty) {
        const cur = this.accum.get(id)
        if (cur) this.send(cur.source, cur.text)
      }
      this.dirty.clear()
    }, COALESCE_MS)
  }

  /** Push any pending text for a session and stop tracking it (completion). */
  flush(sessionId: string): void {
    for (const [key, entry] of this.accum) {
      if (!key.startsWith(`${sessionId}:`)) continue
      this.send(entry.source, entry.text)
      this.accum.delete(key)
      this.dirty.delete(key)
    }
    if (!this.dirty.size && this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Missing SSE fragments invalidate the accumulator; history repairs the gap. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.accum.clear()
    this.dirty.clear()
  }

  private send(source: DeltaSource, text: string): void {
    // Explicit literals per kind: PushEvent is a discriminated union; work/review
    // carry workId, chat does not.
    const event: PushEvent =
      source.kind === 'chat.delta'
        ? { kind: 'chat.delta', sessionId: source.sessionId, messageId: source.messageId, text }
        : source.kind === 'work.delta'
          ? { kind: 'work.delta', workId: source.workId ?? '', sessionId: source.sessionId, messageId: source.messageId, text }
          : { kind: 'review.delta', workId: source.workId ?? '', sessionId: source.sessionId, messageId: source.messageId, text }
    pushToWindows(event)
  }
}

export const streamBuffer = new StreamBuffer()
