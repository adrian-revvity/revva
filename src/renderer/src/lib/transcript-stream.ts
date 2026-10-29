import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import type { ChatMessage, ChatToolCall, ReviewRow, PushEvent, TranscriptAttachment } from '@shared/types'

export const streamKey = (sessionId: string): readonly string[] => ['session-stream', sessionId]
export type LiveTranscript = Record<string, ChatMessage>
export const EMPTY_STREAM: LiveTranscript = Object.freeze({})

const windowVisible = (): boolean => document.visibilityState === 'visible'
function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
export function useTranscriptVisibility(): boolean {
  return useSyncExternalStore(subscribeVisibility, windowVisible, () => false)
}

function olderTool(previous: ChatToolCall | undefined, next: ChatToolCall): boolean {
  if (!previous) return false
  const rank = (tool: ChatToolCall): number => tool.state === 'streaming' ? 0 : tool.state === 'running' ? 1 : 2
  return rank(previous) > rank(next) || (previous.state === 'streaming' && next.state === 'streaming' && (previous.inputLength ?? 0) >= (next.inputLength ?? 0))
}
function sameTools(a: ChatMessage['tools'], b: ChatMessage['tools']): boolean {
  if (a === b) return true
  return (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((tool, i) => {
    const other = b?.[i]
    return other && tool.id === other.id && tool.name === other.name && tool.state === other.state && tool.detail === other.detail && tool.output === other.output && tool.inputLength === other.inputLength
  })
}

/** Merge a newest-page response without discarding previously loaded history. */
export function mergeHistory(history: ChatMessage[], updates: ChatMessage[]): ChatMessage[] {
  const byId = new Map(history.filter((row) => !row.id.startsWith('pending-')).map((row) => [row.id, row]))
  for (const row of updates) byId.set(row.id, row)
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200)
}

/** History and live text describe the same messages, not two separate bubbles. */
export function mergeTranscript(history: ChatMessage[], live: LiveTranscript): ChatMessage[] {
  const ids = new Set<string>()
  const rows = history.map((saved) => {
    ids.add(saved.id)
    const message = live[saved.id]
    if (!message) return saved
    // Keep memoized historical bubbles stable; only the changed live tail renders.
    if (message === saved || (message.text === saved.text && message.thinking === saved.thinking && sameTools(message.tools, saved.tools))) return saved
    const grow = (persisted: string, streamed: string): string => streamed.length >= persisted.length && streamed.startsWith(persisted) ? streamed : persisted
    const text = grow(saved.text, message.text)
    const thinking = grow(saved.thinking ?? '', message.thinking ?? '')
    const tools = new Map(saved.tools?.map((tool) => [tool.id, tool]))
    for (const tool of message.tools ?? []) {
      const previous = tools.get(tool.id)
      if (previous?.state === 'completed' || previous?.state === 'error') continue
      if (olderTool(previous, tool)) continue
      tools.set(tool.id, { ...previous, ...tool, detail: tool.detail ?? previous?.detail, output: tool.output ?? previous?.output })
    }
    return {
      ...saved, text, thinking: thinking || undefined,
      tools: tools.size ? [...tools.values()] : undefined,
      streamLengths: {
        text: text.length,
        thinking: thinking.length
      }
    }
  })
  const extra = Object.values(live).filter((message) => !ids.has(message.id)).sort((a, b) => a.createdAt - b.createdAt)
  // History is already ordered; only the small unsaved tail needs sorting.
  const merged: ChatMessage[] = []
  let i = 0
  let j = 0
  while (i < rows.length || j < extra.length) {
    if (j >= extra.length || (i < rows.length && rows[i]!.createdAt <= extra[j]!.createdAt)) merged.push(rows[i++]!)
    else merged.push(extra[j++]!)
  }
  return merged
}

type Batch = Extract<PushEvent, { kind: 'transcript.batch' }>
interface Displayed {
  token: string
  refs: number
  ready: Promise<void>
  attachment?: TranscriptAttachment
  loading: boolean
  pending: Batch[]
  bytes: number
  forceReset: boolean
  awaiting: Set<string>
}
const displayed = new Map<string, Displayed>()

/** Unique ownership token shared by simultaneous surfaces of the same session. */
export function displayTranscript(qc: QueryClient, sessionId: string): { ready: Promise<void>; release: () => void } {
  let state = displayed.get(sessionId)
  if (!state) {
    state = { token: crypto.randomUUID(), refs: 0, ready: Promise.resolve(), loading: true, pending: [], bytes: 0, forceReset: true, awaiting: new Set() }
    const current = state
    displayed.set(sessionId, current)
    qc.setQueryData(streamKey(sessionId), EMPTY_STREAM)
    current.ready = window.revva.session.subscribe(sessionId, current.token).then((attachment) => {
      if (displayed.get(sessionId) !== current) return
      // A reset pushed during subscribe already validates subsequent batches.
      // Only replay sequence bookkeeping for batches received before any epoch.
      if (!current.attachment) {
        current.attachment = attachment
        for (const event of current.pending) {
          if (event.epoch !== attachment.epoch) continue
          if (event.sequence !== current.attachment.sequence + 1) current.forceReset = true
          current.attachment.sequence = event.sequence
        }
      }
    })
    // Cleanup can win the subscribe acknowledgement; keep rejected abandoned
    // attachments handled while allowing the query awaiting ready to report it.
    void current.ready.catch(() => undefined)
  }
  state.refs++
  const current = state
  let released = false
  return { ready: current.ready, release: () => {
    if (released) return
    released = true
    if (--current.refs > 0) return
    if (displayed.get(sessionId) === current) displayed.delete(sessionId)
    qc.setQueryData(streamKey(sessionId), EMPTY_STREAM)
    void window.revva.session.unsubscribe(current.token).catch(() => undefined)
  } }
}

export function transcriptReady(sessionId: string): Promise<void> {
  const state = displayed.get(sessionId)
  return state ? state.ready : Promise.reject(new Error('Transcript is no longer displayed.'))
}

export function beginTranscriptSnapshot(sessionId: string): boolean {
  const state = displayed.get(sessionId)
  if (!state) return true
  state.loading = true
  return state.forceReset
}

function applyBatch(qc: QueryClient, event: Batch): boolean {
  let gap = false
  qc.setQueryData<LiveTranscript>(streamKey(event.sessionId), (old = EMPTY_STREAM) => {
    const next = { ...old }
    for (const update of event.updates) {
      if (displayed.get(event.sessionId)?.awaiting.has(update.messageId) && !update.tool) continue
      const saved = next[update.messageId]
      const message: ChatMessage = saved ? { ...saved } : { id: update.messageId, role: 'assistant', text: '', createdAt: update.createdAt }
      if (update.field === 'text' || update.field === 'thinking') {
        const field = update.field
        const length = message.streamLengths?.[field] ?? (message[field]?.length ?? 0)
        if (update.offset === undefined || update.offset > length) { gap = true; continue }
        const skip = Math.max(0, length - update.offset)
        const append = (update.text ?? '').slice(skip)
        if (!append) continue
        message[field] = (message[field] ?? '') + append
        message.streamLengths = { text: message.streamLengths?.text ?? message.text.length, thinking: message.streamLengths?.thinking ?? (message.thinking?.length ?? 0), [field]: length + append.length }
      } else {
        const tools = new Map(message.tools?.map((tool) => [tool.id, tool]))
        const previous = tools.get(update.partId)
        if (update.tool) {
          const tool = update.tool
          if (olderTool(previous, tool)) continue
          tools.set(tool.id, { ...previous, ...tool, name: tool.name === 'tool' ? previous?.name ?? tool.name : tool.name, detail: tool.detail ?? previous?.detail, output: tool.output ?? previous?.output })
        } else if (previous?.state === 'streaming') {
          const length = previous.inputLength ?? 0
          if (update.offset === undefined) continue
          if (update.offset > length) { gap = true; continue }
          const append = (update.text ?? '').slice(Math.max(0, length - update.offset))
          tools.set(previous.id, { ...previous, detail: ((previous.detail ?? '') + append).slice(0, 2000), inputLength: length + append.length })
        } else if (!update.tool) {
          continue
        }
        message.tools = tools.size ? [...tools.values()] : undefined
      }
      next[message.id] = message
    }
    const ids = Object.keys(next)
    for (let i = 0; i < ids.length - 200; i++) delete next[ids[i]!]
    return next
  })
  return !gap
}

export function finishTranscriptSnapshot(qc: QueryClient, sessionId: string, history: ChatMessage[], missingPrefixes: string[] = []): boolean {
  const state = displayed.get(sessionId)
  if (!state?.attachment) return false
  state.awaiting = new Set(missingPrefixes)
  const old = state.forceReset ? EMPTY_STREAM : qc.getQueryData<LiveTranscript>(streamKey(sessionId)) ?? EMPTY_STREAM
  const merged = mergeTranscript(history, old)
  qc.setQueryData(streamKey(sessionId), Object.fromEntries(merged.filter((row) => row.role === 'assistant').map((row) => [row.id, row])))
  state.loading = false
  state.forceReset = false
  const pending = state.pending
  state.pending = []; state.bytes = 0
  for (const event of pending) if (event.epoch === state.attachment.epoch && !applyBatch(qc, event)) {
    state.forceReset = true
    return false
  }
  return true
}

/** App-lifetime listener; only mounted transcript surfaces accept detail. */
export function subscribeTranscripts(qc: QueryClient): () => void {
  qc.setQueryDefaults(['session-stream'], { structuralSharing: false })
  const refreshIds = new Set<string>()
  let refreshAll = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    timer = undefined
    // Global completion/status remains live while hidden, but history does not.
    // Main emits a new attach epoch and authoritative reset when the window returns.
    if (!windowVisible()) { refreshIds.clear(); refreshAll = false; return }
    const again = new Set<string>()
    for (const prefix of ['chat-messages']) {
      for (const id of refreshAll ? displayed.keys() : refreshIds) {
        if (!displayed.has(id)) continue
        if (qc.getQueryState([prefix, id])?.fetchStatus === 'fetching') again.add(id)
        else void qc.invalidateQueries({ queryKey: [prefix, id] }, { cancelRefetch: false })
      }
    }
    refreshAll = false
    refreshIds.clear()
    for (const id of again) refreshIds.add(id)
    if (again.size) timer = setTimeout(flush, 250)
  }
  const refresh = (sessionId?: string): void => {
    if (sessionId) refreshIds.add(sessionId)
    else refreshAll = true
    // One shared trailing coalescer, not a timer per conversation or tool.
    timer ??= setTimeout(flush, 250)
  }
  const reset = (sessionId?: string): void => {
    // A gap in the event stream or an edit/revert needs an authoritative snapshot,
    // not just the tail. The generation also survives an in-flight fetch.
    const ids = sessionId ? [sessionId] : qc.getQueryCache().getAll()
      .filter((query) => query.queryKey[0] === 'chat-messages')
      .map((query) => String(query.queryKey[1]))
    for (const id of new Set(ids)) {
      const state = displayed.get(id)
      if (state) { state.forceReset = true; state.loading = true; state.pending = []; state.bytes = 0 }
      qc.setQueryData<number>(['transcript-reset', id], (old = 0) => old + 1)
      qc.setQueryData(streamKey(id), EMPTY_STREAM)
    }
    refresh(sessionId)
  }
  const unsubscribe = window.revva.events.on((event) => {
    if (event.kind === 'inventory.models') {
      void qc.invalidateQueries({ queryKey: ['models'] }, { cancelRefetch: false })
      for (const id of displayed.keys()) {
        void qc.invalidateQueries({ queryKey: ['session-model', id] }, { cancelRefetch: false })
        void qc.invalidateQueries({ queryKey: ['session-context-usage', id] }, { cancelRefetch: false })
      }
      return
    }
    if (event.kind === 'transcript.reset') {
      const state = displayed.get(event.sessionId)
      if (!state) return
      state.attachment = { epoch: event.epoch, sequence: 0 }
      reset(event.sessionId)
      qc.setQueryData(['session-context-usage', event.sessionId], null)
      void qc.invalidateQueries({ queryKey: ['session-context-usage', event.sessionId] })
      return
    }
    if (event.kind === 'transcript.batch') {
      const received = event.diagnostic ? performance.now() : 0
      const state = displayed.get(event.sessionId)
      if (!state) return
      if (state.attachment && event.epoch !== state.attachment.epoch) return
      if (state.attachment && event.sequence !== state.attachment.sequence + 1) { reset(event.sessionId); state.attachment.sequence = event.sequence; return }
      if (state.attachment) state.attachment.sequence = event.sequence
      if (state.loading || !state.attachment) {
        state.pending.push(event)
        state.bytes += event.updates.reduce((total, update) => total + (update.text?.length ?? 0) * 2 + 256, 0)
        if (state.bytes > 1024 * 1024 || state.pending.length > 512) reset(event.sessionId)
      } else if (!applyBatch(qc, event)) reset(event.sessionId)
      if (event.diagnostic) {
        requestAnimationFrame(() => { void window.revva.session.performanceFrame(performance.now() - received).catch(() => undefined) })
      }
      return
    }
    if (event.kind === 'session.metrics') {
      qc.setQueryData(['session-context-usage', event.sessionId], null)
      void qc.invalidateQueries({ queryKey: ['session-context-usage', event.sessionId] })
      return
    }
    if (event.kind === 'session.throughput') {
      // Keep the final measurement even when another conversation is on screen.
      for (const item of event.items) qc.setQueryData(['session-throughput', item.sessionId], item)
      return
    }
    if (event.kind === 'work.queue') {
      void qc.invalidateQueries({ queryKey: ['work-queue', event.workId] })
      void qc.invalidateQueries({ queryKey: ['ship-checks', event.workId] })
      return
    }
    if (event.kind === 'session.activity' && !event.running) {
      // Keep live text until history has caught up, including the final flush.
      refresh(event.sessionId)
    } else if (event.kind === 'chat.idle') {
      if (event.sessionId === '*') reset()
      else refresh(event.sessionId)
    } else if (event.kind === 'session.transcript') {
      if (event.reset === false) refresh(event.sessionId)
      else reset(event.sessionId)
    } else if (event.kind === 'chat.tool') {
      refresh(event.sessionId)
    } else if (event.kind === 'review.updated') {
      const previous = new Map((qc.getQueryData<ReviewRow[]>(['reviews', event.workId]) ?? []).map((row) => [row.id, row.status]))
      qc.setQueryData(['reviews', event.workId], event.reviews)
      // Activity-only pushes should not refetch every transcript each second.
      for (const row of event.reviews) if (row.sessionId && row.status !== 'running' && row.status !== 'pending' && previous.get(row.id) !== row.status) refresh(row.sessionId)
    } else if (event.kind === 'service' && event.status.state === 'connected') {
      reset()
    }
  })
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}
