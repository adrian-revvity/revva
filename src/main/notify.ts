/**
 * OS (laptop-level) notifications for inbox arrivals. Managers call this when
 * something lands in the inbox that should pull the user back to Revva:
 * a question/permission, a finished chat message, a work state that waits.
 */
import { BrowserWindow, Notification } from 'electron'

/** One event often raises several near-simultaneous notifications (chat idle
 *  + execution.succeeded; a reviewer's form + the WAITING_HUMAN flip). Keep
 *  the first per session within this window. */
const DEDUPE_MS = 5000
const lastShown = new Map<string, number>()

/** Show an OS notification; clicking brings Revva to the front. */
export function notifyInbound(key: string, title: string, body: string): void {
  const now = Date.now()
  const last = lastShown.get(key)
  if (last !== undefined && now - last < DEDUPE_MS) return
  lastShown.set(key, now)
  if (lastShown.size > 200) for (const [k, t] of lastShown) if (now - t >= DEDUPE_MS) lastShown.delete(k)
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, silent: false })
  notification.on('click', focusRevva)
  notification.show()
}

/** Bring Revva to the front when the notification is clicked. */
function focusRevva(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
