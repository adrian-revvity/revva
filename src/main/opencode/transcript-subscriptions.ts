import { randomUUID } from 'node:crypto'
import { BrowserWindow, type WebContents } from 'electron'
import { IPC, type PushEvent, type TranscriptAttachment, type TranscriptUpdate } from '@shared/types'
import { performanceMeter } from './performance'

interface Attachment extends TranscriptAttachment { tokens: Set<string> }
class TranscriptSubscriptions {
  private owners = new Map<number, Map<string, Attachment>>()
  receives(senderId: number, sessionId: string): boolean { return this.owners.get(senderId)?.has(sessionId) ?? false }
  private measure(): void {
    if (!performanceMeter.enabled) return
    performanceMeter.gauge('subscriptions.sessions', [...this.owners.values()].reduce((total, sessions) => total + sessions.size, 0))
    performanceMeter.gauge('subscriptions.visible', BrowserWindow.getAllWindows().reduce((total, win) => total + (win.isVisible() && !win.isMinimized() ? this.owners.get(win.webContents.id)?.size ?? 0 : 0), 0))
  }

  subscribe(sender: WebContents, sessionId: string, token: string): TranscriptAttachment {
    let sessions = this.owners.get(sender.id)
    if (!sessions) {
      sessions = new Map()
      this.owners.set(sender.id, sessions)
      const current = sessions
      const clear = (): void => { current.clear(); this.measure() }
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) clear()
      })
      sender.on('render-process-gone', clear)
      sender.once('destroyed', () => { this.owners.delete(sender.id); this.measure() })
      const win = BrowserWindow.fromWebContents(sender)
      const resume = (): void => {
        this.measure()
        if (sender.isDestroyed() || !win?.isVisible() || win.isMinimized()) return
        for (const [id, attachment] of current) {
          attachment.epoch = randomUUID()
          attachment.sequence = 0
          sender.send(IPC.eventPush, { kind: 'transcript.reset', sessionId: id, epoch: attachment.epoch })
        }
      }
      win?.on('show', resume)
      win?.on('restore', resume)
      win?.on('hide', () => this.measure())
      win?.on('minimize', () => this.measure())
    }
    if (sessions.size >= 32 && !sessions.has(sessionId)) throw new Error('Too many transcript subscriptions.')
    let attachment = sessions.get(sessionId)
    if (!attachment) {
      attachment = { epoch: randomUUID(), sequence: 0, tokens: new Set() }
      sessions.set(sessionId, attachment)
    }
    if (attachment.tokens.size >= 64 && !attachment.tokens.has(token)) throw new Error('Too many transcript consumers.')
    attachment.tokens.add(token)
    this.measure()
    performanceMeter.add('subscriptions.attach')
    return { epoch: attachment.epoch, sequence: attachment.sequence }
  }

  unsubscribe(sender: WebContents, token: string): void {
    const sessions = this.owners.get(sender.id)
    if (!sessions) return
    for (const [id, attachment] of sessions) {
      if (attachment.tokens.delete(token)) performanceMeter.add('subscriptions.detach')
      if (!attachment.tokens.size) sessions.delete(id)
    }
    this.measure()
  }

  observed(sessionId: string): boolean {
    return BrowserWindow.getAllWindows().some((win) =>
      win.isVisible() && !win.isMinimized() && this.owners.get(win.webContents.id)?.has(sessionId))
  }

  detail(sessionId: string, updates: TranscriptUpdate[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      const attachment = this.owners.get(win.webContents.id)?.get(sessionId)
      if (!attachment || !win.isVisible() || win.isMinimized() || win.webContents.isDestroyed()) continue
      const event: PushEvent = {
        kind: 'transcript.batch', sessionId, epoch: attachment.epoch, sequence: ++attachment.sequence,
        updates, diagnostic: performanceMeter.enabled
      }
      performanceMeter.add('transcript.ipc.count')
      if (performanceMeter.enabled) performanceMeter.add('transcript.ipc.bytes', Buffer.byteLength(JSON.stringify(event)))
      win.webContents.send(IPC.eventPush, event)
    }
  }

  reset(sessionId?: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue
      for (const [id, attachment] of this.owners.get(win.webContents.id) ?? []) {
        if (sessionId && id !== sessionId) continue
        attachment.epoch = randomUUID()
        attachment.sequence = 0
        if (win.isVisible() && !win.isMinimized()) win.webContents.send(IPC.eventPush, { kind: 'transcript.reset', sessionId: id, epoch: attachment.epoch })
      }
    }
  }
}
export const transcriptSubscriptions = new TranscriptSubscriptions()
