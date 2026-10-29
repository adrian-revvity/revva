import type { WebContents } from 'electron'
import { performanceMeter } from './performance'
import { openCodeService } from './service'

class TranscriptRequests {
  private owners = new Map<number, { active: Map<string, AbortController>; cancelled: Set<string> }>()

  private owner(sender: WebContents): { active: Map<string, AbortController>; cancelled: Set<string> } {
    let owner = this.owners.get(sender.id)
    if (!owner) {
      owner = { active: new Map(), cancelled: new Set() }
      this.owners.set(sender.id, owner)
      const current = owner
      const clear = (): void => {
        for (const controller of current.active.values()) controller.abort()
        current.active.clear()
        current.cancelled.clear()
        this.measure()
      }
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) clear()
      })
      sender.on('render-process-gone', clear)
      sender.once('destroyed', () => {
        clear()
        this.owners.delete(sender.id)
        this.measure()
      })
    }
    return owner
  }

  private measure(): void {
    if (!performanceMeter.enabled) return
    performanceMeter.gauge('registry.active', [...this.owners.values()].reduce((total, owner) => total + owner.active.size, 0))
  }

  cancel(sender: WebContents, id: string): void {
    const owner = this.owner(sender)
    const request = owner.active.get(id)
    if (request) request.abort()
    else {
      owner.cancelled.add(id)
      while (owner.cancelled.size > 256) owner.cancelled.delete(owner.cancelled.values().next().value!)
    }
  }

  async run<T>(sender: WebContents, id: string | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const owner = this.owner(sender)
    if (id && owner.cancelled.delete(id)) throw new Error('Transcript request cancelled.')
    if (owner.active.size >= 64) throw new Error('Too many transcript requests.')
    const controller = new AbortController()
    const key = id ?? crypto.randomUUID()
    if (owner.active.has(key)) throw new Error('Duplicate transcript request.')
    owner.active.set(key, controller)
    this.measure()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    performanceMeter.add('registry.registered')
    try {
      const result = await run(controller.signal)
      controller.signal.throwIfAborted()
      return result
    } finally {
      clearTimeout(timeout)
      if (owner.active.get(key) === controller) owner.active.delete(key)
      this.measure()
      performanceMeter.add('registry.released')
    }
  }
}
export const transcriptRequests = new TranscriptRequests()

const executionStarts = new Map<string, number>()
export function recordExecutionStart(sessionID: string, created: number): void {
  executionStarts.set(sessionID, created)
  while (executionStarts.size > 2000) executionStarts.delete(executionStarts.keys().next().value!)
}

/** First assistant in the newest execution, including an intentionally blank answer. */
export async function latestAssistantText(sessionID: string, signal?: AbortSignal, after = 0): Promise<string> {
  const boundary = Math.max(after, executionStarts.get(sessionID) ?? 0)
  let cursor: string | undefined
  let initialIdle = true
  const seen = new Set<string>()
  for (let pages = 0; pages < 100; pages++) {
    const page = await performanceMeter.request('latest', () => openCodeService.api.message.list({ sessionID, order: 'desc', limit: 10, cursor }, { signal }))
    for (const message of page.data) {
      if (message.time.created < boundary) return ''
      if (message.type === 'idle') {
        if (!initialIdle) return ''
        initialIdle = false
        continue
      }
      if (message.type === 'user') return ''
      if (message.type !== 'assistant') continue
      return message.content.filter((part) => part.type === 'text').map((part) => part.type === 'text' ? part.text : '').join('')
    }
    cursor = page.cursor.next ?? undefined
    if (!cursor || seen.has(cursor)) return ''
    seen.add(cursor)
  }
  // Bounded search fails closed rather than returning an older verdict.
  return ''
}

let previewActive = 0
const previewQueue: Array<() => void> = []
async function previewSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw signal.reason
  if (previewActive >= 4) await new Promise<void>((resolve, reject) => {
    const start = (): void => { signal.removeEventListener('abort', abort); resolve() }
    const abort = (): void => {
      const index = previewQueue.indexOf(start)
      if (index >= 0) previewQueue.splice(index, 1)
      reject(signal.reason)
    }
    previewQueue.push(start)
    signal.addEventListener('abort', abort, { once: true })
  })
  else previewActive++
  if (signal.aborted) {
    const next = previewQueue.shift()
    if (next) next(); else previewActive--
    throw signal.reason
  }
  return () => { const next = previewQueue.shift(); if (next) next(); else previewActive-- }
}

interface Preview {
  controller: AbortController
  promise: Promise<string | null>
  waiters: number
  expires: number
  settled: boolean
}
const previews = new Map<string, Preview>()
export function invalidateLatestAnswers(sessionID?: string): void {
  for (const [key, entry] of previews) if (!sessionID || key.startsWith(`${sessionID}:`)) {
    entry.controller.abort()
    previews.delete(key)
  }
}
export async function compactLatestAnswer(sessionID: string, generation: number, signal: AbortSignal): Promise<string | null> {
  const key = `${sessionID}:${generation}`
  let entry = previews.get(key)
  if (entry && entry.expires < Date.now() && entry.settled) { previews.delete(key); entry = undefined }
  if (!entry) {
    const controller = new AbortController()
    entry = { controller, promise: Promise.resolve(null), waiters: 0, expires: Date.now() + 60_000, settled: false }
    const current = entry
    current.promise = (async () => {
      const release = await previewSlot(controller.signal)
      const timeout = setTimeout(() => controller.abort(), 30_000)
      try { return (await latestAssistantText(sessionID, controller.signal)).trim() || null }
      finally { clearTimeout(timeout); release() }
    })().finally(() => { current.settled = true })
    void current.promise.catch(() => { if (previews.get(key) === current) previews.delete(key) })
    previews.set(key, current)
    while (previews.size > 128) {
      const oldest = previews.keys().next().value!
      previews.get(oldest)?.controller.abort()
      previews.delete(oldest)
    }
  }
  const current = entry
  current.waiters++
  let abort: (() => void) | undefined
  try {
    if (signal.aborted) throw signal.reason
    return await Promise.race([
      current.promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })
    ])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    if (--current.waiters === 0 && !current.settled) {
      current.controller.abort()
      if (previews.get(key) === current) previews.delete(key)
    }
  }
}
