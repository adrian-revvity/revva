/**
 * Single place that fans an event out to all renderer windows. Preload
 * subscribes every window to IPC.eventPush; keeping the loop here means
 * window-management policy (e.g. filtering hidden windows) changes once.
 */
import { BrowserWindow } from 'electron'
import { IPC, type PushEvent } from '@shared/types'

export function pushToWindows(event: PushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.eventPush, event)
}
