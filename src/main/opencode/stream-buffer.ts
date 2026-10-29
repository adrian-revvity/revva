/** Bounded active prefixes repair attach/restore; incremental IPC remains visible-only. */
import type { ChatMessage, ChatToolCall, TranscriptUpdate } from '@shared/types'
import type { RawEvent } from './bus'
import { transcriptSubscriptions } from './transcript-subscriptions'
import { performanceMeter } from './performance'
import { sessionIndex } from './session-index'

const PREFIX_BUDGET = 16 * 1024 * 1024
const PREFIX_MESSAGE_BUDGET = 1024 * 1024
const PREFIX_MESSAGE_LIMIT = 128
const COMPLETED_PREFIX_TTL_MS = 30_000
interface Prefix {
  sessionId: string
  message: ChatMessage
  bytes: number
  expires?: number
}
const toolBytes = (tool: ChatToolCall): number => 128 + 2 * (tool.id.length + tool.name.length + (tool.detail?.length ?? 0) + (tool.output?.length ?? 0))
/** Detach summaries from potentially huge native strings/sliced-string parents. */
function summary(text: string, start = 0, limit = 2000): string {
  return Buffer.from(text.slice(start, start + limit), 'utf8').toString('utf8')
}
function contentSummary(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  let out = ''
  for (const part of content as Array<{ text?: unknown }>) {
    if (typeof part.text !== 'string') continue
    if (out) out += '\n'
    out += summary(part.text, 0, Math.max(0, 2000 - out.length))
    if (out.length >= 2000) break
  }
  return out || undefined
}

interface Cursor {
  text: number
  thinking: number
  known: boolean
  tools: Map<string, string>
  parts: Map<string, number>
  offsets: Map<string, number>
  createdAt: number
  completed: boolean
}
// Retained for the comment watcher transport; the shared bus now owns all detail.
export interface DeltaSource { kind: 'chat.delta' | 'work.delta' | 'review.delta'; sessionId: string; messageId: string; text: string; workId?: string }

class StreamBuffer {
  private cursors = new Map<string, Cursor>()
  private pending = new Map<string, { updates: TranscriptUpdate[]; bytes: number; receivedAt: number }>()
  private timer: NodeJS.Timeout | undefined
  private prefixes = new Map<string, Prefix>()
  private prefixBytes = 0

  private measurePrefixes(): void {
    performanceMeter.gauge('prefix.bytes', this.prefixBytes)
    performanceMeter.gauge('prefix.messages', this.prefixes.size)
  }

  private dropPrefix(key: string): void {
    const prefix = this.prefixes.get(key)
    if (!prefix) return
    this.prefixBytes -= prefix.bytes
    this.prefixes.delete(key)
    this.measurePrefixes()
  }

  private expirePrefixes(): void {
    const now = Date.now()
    for (const [key, prefix] of this.prefixes) if (prefix.expires !== undefined && prefix.expires <= now) this.dropPrefix(key)
  }

  private boundPrefixes(key: string, previousBytes: number): void {
    const prefix = this.prefixes.get(key)
    if (!prefix) return
    this.prefixBytes += prefix.bytes - previousBytes
    // Overflow/eviction never recreates a cache from a partial tail. Only a new
    // step.started establishes a complete prefix again.
    if (prefix.bytes > PREFIX_MESSAGE_BUDGET || (prefix.message.tools?.length ?? 0) > 128) {
      this.dropPrefix(key)
      performanceMeter.add('prefix.overflows')
      return
    }
    this.prefixes.delete(key)
    this.prefixes.set(key, prefix)
    while (this.prefixBytes > PREFIX_BUDGET || this.prefixes.size > PREFIX_MESSAGE_LIMIT) {
      this.dropPrefix(this.prefixes.keys().next().value!)
      performanceMeter.add('prefix.evictions')
    }
    this.measurePrefixes()
  }

  private remember(sessionId: string, update: TranscriptUpdate): void {
    const key = `${sessionId}:${update.messageId}`
    const prefix = this.prefixes.get(key)
    if (!prefix) return
    const previousBytes = prefix.bytes
    if (update.field === 'text' || update.field === 'thinking') {
      const saved = prefix.message[update.field] ?? ''
      if (update.offset === undefined || update.offset > saved.length) { this.dropPrefix(key); return }
      const append = (update.text ?? '').slice(Math.max(0, saved.length - update.offset))
      prefix.message[update.field] = saved + append
      prefix.bytes += append.length * 2
    } else {
      const tools = prefix.message.tools ?? []
      const index = tools.findIndex((tool) => tool.id === update.partId)
      const previous = tools[index]
      let tool: ChatToolCall | undefined
      if (update.tool) tool = {
        ...previous, ...update.tool,
        detail: update.tool.detail ?? previous?.detail,
        output: update.tool.output ?? previous?.output
      }
      else if (previous?.state === 'streaming' && update.offset !== undefined) {
        const length = previous.inputLength ?? 0
        if (update.offset > length) { this.dropPrefix(key); return }
        const text = update.text ?? ''
        const skip = Math.max(0, length - update.offset)
        const detail = previous.detail ?? ''
        tool = { ...previous, detail: detail + summary(text, skip, Math.max(0, 2000 - detail.length)), inputLength: length + Math.max(0, text.length - skip) }
      }
      if (!tool) return
      prefix.bytes += toolBytes(tool) - (previous ? toolBytes(previous) : 0)
      if (index < 0) tools.push(tool)
      else tools[index] = tool
      prefix.message.tools = tools
    }
    prefix.message.streamLengths = { text: prefix.message.text.length, thinking: prefix.message.thinking?.length ?? 0 }
    this.boundPrefixes(key, previousBytes)
  }

  /** Called only for displayed full snapshots, never for background fan-out. */
  snapshot(sessionId: string): ChatMessage[] {
    this.expirePrefixes()
    return [...this.prefixes.values()].filter((prefix) => prefix.sessionId === sessionId)
      .map(({ message }) => ({ ...message, tools: message.tools?.map((tool) => ({ ...tool })), streamLengths: message.streamLengths ? { ...message.streamLengths } : undefined }))
      .filter((message) => message.text || message.thinking || message.tools?.length)
  }

  /** Native completion is authoritative, including blank or failed responses. */
  persisted(sessionId: string, messageId: string): void { this.dropPrefix(`${sessionId}:${messageId}`) }

  /** Avoid a reset/refetch loop when no complete attach prefix is available. */
  missingPrefixes(sessionId: string, messages: ChatMessage[], authoritative: Set<string>): string[] {
    const rows = new Map(messages.map((message) => [message.id, message]))
    const missing: string[] = []
    for (const [key, cursor] of this.cursors) {
      if (!key.startsWith(`${sessionId}:`) || cursor.completed || this.prefixes.has(key)) continue
      const id = key.slice(sessionId.length + 1)
      if (authoritative.has(id)) continue
      const row = rows.get(id)
      const toolGap = [...cursor.parts].some(([part, length]) => {
        if (!part.startsWith('tool:')) return false
        const tool = row?.tools?.find((tool) => tool.id === part.slice(5))
        return !tool || (tool.state === 'streaming' && (tool.inputLength ?? 0) < length)
      })
      if (!cursor.known || (row?.text.length ?? 0) < cursor.text || (row?.thinking?.length ?? 0) < cursor.thinking || toolGap) missing.push(id)
    }
    return missing.slice(-200)
  }

  push(_source: DeltaSource): void { /* Native text events are handled once in onEvent. */ }

  onEvent(event: RawEvent): void {
    const data = event.data ?? {}
    const sessionId = data.sessionID
    if (typeof sessionId !== 'string') return
    if (event.type === 'session.deleted') { this.reset(sessionId); return }
    if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.idle'].includes(event.type)) {
      for (const prefix of this.prefixes.values()) if (prefix.sessionId === sessionId) prefix.expires ??= Date.now() + COMPLETED_PREFIX_TTL_MS
      for (const [key, cursor] of this.cursors) if (key.startsWith(`${sessionId}:`)) cursor.completed = true
      return
    }
    const messageId = data.assistantMessageID
    if (typeof messageId !== 'string') return
    const key = `${sessionId}:${messageId}`
    if (event.type === 'session.step.started') {
      const createdAt = typeof data.started === 'number' ? data.started : Date.now()
      this.cursors.set(key, { text: 0, thinking: 0, known: true, tools: new Map(), parts: new Map(), offsets: new Map(), createdAt, completed: false })
      while (this.cursors.size > 2000) {
        const oldest = this.cursors.keys().next().value!
        this.dropPrefix(oldest)
        this.cursors.delete(oldest)
      }
      this.expirePrefixes()
      this.dropPrefix(key)
      if (sessionIndex.kindOf(sessionId)) {
        const message: ChatMessage = { id: messageId, role: 'assistant', text: '', createdAt }
        this.prefixes.set(key, { sessionId, message, bytes: 512 })
        this.boundPrefixes(key, 0)
      }
      return
    }
    if (event.type === 'session.step.ended' || event.type === 'session.step.failed') {
      const prefix = this.prefixes.get(key)
      if (prefix) prefix.expires = Date.now() + COMPLETED_PREFIX_TTL_MS
      const cursor = this.cursors.get(key)
      if (cursor) cursor.completed = true
      return
    }
    if (!/^(session\.(text|reasoning|tool)\.)/.test(event.type)) return
    let cursor = this.cursors.get(key)
    if (!cursor) {
      this.dropPrefix(key)
      cursor = { text: 0, thinking: 0, known: false, tools: new Map(), parts: new Map(), offsets: new Map(), createdAt: typeof event.created === 'number' ? event.created : Date.now(), completed: false }
      this.cursors.set(key, cursor)
      while (this.cursors.size > 2000) {
        const oldest = this.cursors.keys().next().value!
        this.dropPrefix(oldest)
        this.cursors.delete(oldest)
      }
    }
    const field = event.type.startsWith('session.text.') ? 'text' : 'thinking'
    const partId = `${field}:${String(data.ordinal)}`
    if (event.type === 'session.text.delta' || event.type === 'session.reasoning.delta') {
      if (typeof data.delta !== 'string') return
      const offset = cursor[field]
      if (!cursor.offsets.has(partId)) cursor.offsets.set(partId, offset)
      cursor[field] += data.delta.length
      cursor.parts.set(partId, (cursor.parts.get(partId) ?? 0) + data.delta.length)
      if (cursor.parts.size > 512 || cursor.offsets.size > 512) { cursor.known = false; cursor.parts.clear(); cursor.offsets.clear(); this.dropPrefix(key) }
      // After a live-only gap we cannot infer a prefix from a partial tail.
      if (cursor.known) this.queue(sessionId, {
        messageId, partId, field, offset,
        text: data.delta, createdAt: cursor.createdAt
      })
      return
    }
    if (event.type === 'session.text.ended' || event.type === 'session.reasoning.ended') {
      if (cursor.known && typeof data.text === 'string') {
        const received = cursor.parts.get(partId) ?? 0
        const prefix = this.prefixes.get(key)
        const start = cursor.offsets.get(partId) ?? cursor[field]
        const saved = prefix?.message[field] ?? ''
        if (prefix && saved.slice(start, start + received) !== data.text.slice(0, received)) {
          // Ended parts are authoritative and may correct streamed content. A
          // single reset repairs the renderer; never repeatedly send full prefixes.
          const previousBytes = prefix.bytes
          prefix.message[field] = saved.slice(0, start) + data.text + saved.slice(start + received)
          prefix.bytes += (data.text.length - received) * 2
          cursor[field] += data.text.length - received
          cursor.parts.set(partId, data.text.length)
          for (const [id, offset] of cursor.offsets) if (id.startsWith(`${field}:`) && offset > start) cursor.offsets.set(id, offset + data.text.length - received)
          prefix.message.streamLengths = { text: prefix.message.text.length, thinking: prefix.message.thinking?.length ?? 0 }
          this.boundPrefixes(key, previousBytes)
          this.pending.delete(sessionId)
          transcriptSubscriptions.reset(sessionId)
          return
        }
        if (data.text.length < received) { cursor.known = false; this.dropPrefix(key) }
        else if (data.text.length > received) {
          this.queue(sessionId, { messageId, partId, field, offset: cursor[field], text: data.text.slice(received), createdAt: cursor.createdAt })
          cursor[field] += data.text.length - received
          cursor.parts.set(partId, data.text.length)
        }
      }
      if (!cursor.known && transcriptSubscriptions.observed(sessionId)) transcriptSubscriptions.reset(sessionId)
      return
    }
    if (!event.type.startsWith('session.tool.') || typeof data.id !== 'string') return
    const id = data.id
    const inputPart = `tool:${id}`
    if (typeof data.name === 'string') {
      cursor.tools.set(id, data.name)
      while (cursor.tools.size > 256) cursor.tools.delete(cursor.tools.keys().next().value!)
    }
    if (event.type === 'session.tool.input.started') cursor.parts.set(inputPart, 0)
    while (cursor.parts.size > 512) {
      const oldest = cursor.parts.keys().next().value!
      cursor.parts.delete(oldest)
      cursor.offsets.delete(oldest)
      cursor.known = false
      this.dropPrefix(key)
    }
    const inputOffset = cursor.parts.get(inputPart)
    if (event.type === 'session.tool.input.delta' && typeof data.delta === 'string' && inputOffset !== undefined) cursor.parts.set(inputPart, inputOffset + data.delta.length)
    let tool: ChatToolCall | undefined
    const name = cursor.tools.get(id) ?? 'tool'
    if (event.type === 'session.tool.input.started') tool = { id, name, state: 'streaming', detail: '', inputLength: 0 }
    else if (event.type === 'session.tool.called') {
      const input = data.input as Record<string, unknown> | undefined
      const detail = input ? ['command', 'cmd', 'path', 'filePath', 'pattern', 'query', 'url', 'prompt', 'description']
        .map((key) => input[key]).find((value) => typeof value === 'string') : undefined
      tool = { id, name, state: 'running', detail: typeof detail === 'string' ? summary(detail) : undefined }
    } else if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
      const error = data.error as { message?: string; type?: string } | undefined
      const output = error?.message ?? error?.type ?? contentSummary(data.content)
      tool = { id, name, state: event.type.endsWith('success') ? 'completed' : 'error', output: output === undefined ? undefined : summary(output) }
    }
    if (tool) {
      this.queue(sessionId, { messageId, partId: id, field: 'tool', tool, createdAt: cursor.createdAt })
      this.flush(sessionId)
    } else if (event.type === 'session.tool.input.delta' && typeof data.delta === 'string' && inputOffset !== undefined) {
      this.queue(sessionId, { messageId, partId: id, field: 'tool', offset: inputOffset, text: data.delta, createdAt: cursor.createdAt })
    } else if (event.type === 'session.tool.input.ended' && typeof data.text === 'string' && inputOffset !== undefined && data.text.length > inputOffset) {
      this.queue(sessionId, { messageId, partId: id, field: 'tool', offset: inputOffset, text: data.text.slice(inputOffset), createdAt: cursor.createdAt })
      cursor.parts.set(inputPart, data.text.length)
    }
  }

  private queue(sessionId: string, update: TranscriptUpdate): void {
    this.remember(sessionId, update)
    if (!transcriptSubscriptions.observed(sessionId)) return
    const entry = this.pending.get(sessionId) ?? { updates: [], bytes: 0, receivedAt: performance.now() }
    const previous = entry.updates.at(-1)
    if (previous && !previous.tool && !update.tool && previous.messageId === update.messageId && previous.partId === update.partId && previous.field === update.field && update.offset === (previous.offset ?? 0) + (previous.text?.length ?? 0)) {
      previous.text = (previous.text ?? '') + (update.text ?? '')
    } else entry.updates.push(update)
    entry.bytes += (update.text?.length ?? 0) * 2 + 256
    this.pending.set(sessionId, entry)
    if (entry.bytes > 1024 * 1024 || entry.updates.length > 512) {
      this.pending.delete(sessionId)
      transcriptSubscriptions.reset(sessionId)
      return
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      for (const id of this.pending.keys()) this.flush(id)
    }, 50)
  }

  flush(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      performanceMeter.add('stream.delay.ms', performance.now() - entry.receivedAt)
      performanceMeter.add('stream.batches')
      transcriptSubscriptions.detail(sessionId, entry.updates)
      this.pending.delete(sessionId)
    }
    if (!this.pending.size && this.timer) { clearTimeout(this.timer); this.timer = undefined }
  }

  reset(sessionId?: string): void {
    if (sessionId) {
      this.pending.delete(sessionId)
      for (const key of this.cursors.keys()) if (key.startsWith(`${sessionId}:`)) this.cursors.delete(key)
      for (const key of this.prefixes.keys()) if (key.startsWith(`${sessionId}:`)) this.dropPrefix(key)
    } else {
      this.pending.clear()
      this.cursors.clear()
      this.prefixes.clear()
      this.prefixBytes = 0
      this.measurePrefixes()
    }
    if (!this.pending.size && this.timer) { clearTimeout(this.timer); this.timer = undefined }
    transcriptSubscriptions.reset(sessionId)
  }
}
export const streamBuffer = new StreamBuffer()
