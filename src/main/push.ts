/**
 * Single place that fans an event out to all renderer windows. Preload
 * subscribes every window to IPC.eventPush; keeping the loop here means
 * window-management policy (e.g. filtering hidden windows) changes once.
 */
import { BrowserWindow } from 'electron'
import { IPC, type PushEvent } from '@shared/types'
import { transcriptSubscriptions } from './opencode/transcript-subscriptions'

export function pushToWindows(event: PushEvent): void {
  const detail = event.kind === 'chat.delta' || event.kind === 'work.delta' || event.kind === 'review.delta' || event.kind === 'chat.message' || event.kind === 'chat.tool'
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue
    if (detail && (!win.isVisible() || win.isMinimized() || !transcriptSubscriptions.receives(win.webContents.id, event.sessionId))) continue
    win.webContents.send(IPC.eventPush, event)
  }
}
