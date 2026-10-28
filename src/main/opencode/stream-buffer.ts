/**
 * Accumulates `session.text.delta` fragments per (sessionId, assistantMessageID)
 * and pushes the accumulated text to renderers, coalesced to one IPC per
 * COALESCE_MS per message. Per-token IPC is quadratic in message length and
 * floods the renderer's render loop; 20 Hz is indistinguishable from "live".
 */
import { BrowserWindow } from 'electron'
import { IPC, type PushEvent } from '@shared/types'

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
  timer: NodeJS.Timeout | undefined
  source: DeltaSource
}

class StreamBuffer {
  private accum = new Map<string, Entry>()

  /** Feed one raw delta; accumulated pushes start/continue on their own timer. */
  push(source: DeltaSource): void {
    const key = `${source.sessionId}:${source.messageId}`
    const entry = this.accum.get(key) ?? { text: '', timer: undefined, source }
    entry.text += source.text
    entry.source = source
    this.accum.set(key, entry)
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      const cur = this.accum.get(key)
      if (!cur) return
      this.send(cur.source, cur.text)
    }, COALESCE_MS)
  }

  /** Push any pending text for a session and stop tracking it (completion). */
  flush(sessionId: string): void {
    for (const [key, entry] of this.accum) {
      if (!key.startsWith(`${sessionId}:`)) continue
      if (entry.timer) clearTimeout(entry.timer)
      this.send(entry.source, entry.text)
      this.accum.delete(key)
    }
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
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.eventPush, event)
  }
}

export const streamBuffer = new StreamBuffer()
