import type { QueryClient } from '@tanstack/react-query'
import type { ChatMessage } from '@shared/types'

export const streamKey = (sessionId: string): readonly string[] => ['session-stream', sessionId]
export type LiveTranscript = Record<string, ChatMessage>
export const EMPTY_STREAM: LiveTranscript = Object.freeze({})

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
    if (!message || message.text.length <= saved.text.length) return saved
    const text = message.text.trimStart()
    return text.length > saved.text.length && text.startsWith(saved.text) ? { ...saved, text } : saved
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

/** App-lifetime listener: switching/unmounting transcripts must not drop deltas. */
export function subscribeTranscripts(qc: QueryClient): () => void {
  qc.setQueryDefaults(['session-stream'], { structuralSharing: false })
  const refreshIds = new Set<string>()
  let refreshAll = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    timer = undefined
    for (const prefix of ['chat-messages', 'work-messages', 'review-messages']) {
      if (refreshAll) void qc.invalidateQueries({ queryKey: [prefix] })
      else for (const id of refreshIds) void qc.invalidateQueries({ queryKey: [prefix, id] })
    }
    refreshAll = false
    refreshIds.clear()
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
      .filter((query) => ['chat-messages', 'work-messages', 'review-messages'].includes(String(query.queryKey[0])))
      .map((query) => String(query.queryKey[1]))
    for (const id of new Set(ids)) {
      qc.setQueryData<number>(['transcript-reset', id], (old = 0) => old + 1)
      qc.setQueryData(streamKey(id), EMPTY_STREAM)
    }
    refresh(sessionId)
  }
  const unsubscribe = window.revva.events.on((event) => {
    if (event.kind === 'session.throughput') {
      // Keep the final measurement even when another conversation is on screen.
      for (const item of event.items) qc.setQueryData(['session-throughput', item.sessionId], item)
      return
    }
    if (event.kind === 'chat.delta' || event.kind === 'work.delta' || event.kind === 'review.delta') {
      if (!event.messageId) return
      qc.setQueryData<LiveTranscript>(streamKey(event.sessionId), (old = EMPTY_STREAM) => {
        const saved = old[event.messageId]
        if (saved?.text === event.text) return old
        const message: ChatMessage = {
          id: event.messageId,
          role: 'assistant',
          text: event.text,
          createdAt: saved?.createdAt ?? Date.now()
        }
        const next = { ...old, [message.id]: message }
        if (!saved) {
          // Match the history window; background runs must not accumulate an
          // unbounded number of live steps while their transcript is unmounted.
          const ids = Object.keys(next)
          for (let i = 0; i < ids.length - 200; i++) delete next[ids[i]!]
        }
        return next
      })
    } else if (event.kind === 'session.activity' && !event.running) {
      // Keep live text until history has caught up, including the final flush.
      refresh(event.sessionId)
    } else if (event.kind === 'chat.idle') {
      if (event.sessionId === '*') reset()
      else refresh(event.sessionId)
    } else if (event.kind === 'session.transcript') {
      reset(event.sessionId)
    } else if (event.kind === 'chat.tool' || event.kind === 'session.queue') {
      refresh(event.sessionId)
    } else if (event.kind === 'review.updated' || event.kind === 'work.updated') {
      refresh()
    } else if (event.kind === 'service' && event.status.state === 'connected') {
      reset()
    }
  })
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}
