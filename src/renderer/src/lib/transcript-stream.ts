import type { QueryClient } from '@tanstack/react-query'
import type { ChatMessage } from '@shared/types'

export const streamKey = (sessionId: string): readonly string[] => ['session-stream', sessionId]

/** History and live text describe the same messages, not two separate bubbles. */
export function mergeTranscript(history: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const rows = new Map(history.map((message) => [message.id, message]))
  for (const message of live) {
    const saved = rows.get(message.id)
    const text = message.text.trimStart()
    // A snapshot may be newer than a coalesced push. Never shorten it, or replace
    // it with a suffix accumulated after an SSE reconnect.
    if (!saved) rows.set(message.id, message)
    else if (text.startsWith(saved.text) && text.length > saved.text.length) {
      rows.set(message.id, { ...saved, text })
    }
  }
  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt)
}

/** App-lifetime listener: switching/unmounting transcripts must not drop deltas. */
export function subscribeTranscripts(qc: QueryClient): () => void {
  const refresh = (sessionId?: string): void => {
    for (const prefix of ['chat-messages', 'work-messages', 'review-messages']) {
      void qc.invalidateQueries({ queryKey: sessionId ? [prefix, sessionId] : [prefix] })
    }
  }
  return window.revva.events.on((event) => {
    if (event.kind === 'session.throughput') {
      // Keep the final measurement even when another conversation is on screen.
      qc.setQueryData(['session-throughput', event.sessionId], event)
      return
    }
    if (event.kind === 'chat.delta' || event.kind === 'work.delta' || event.kind === 'review.delta') {
      if (!event.messageId) return
      qc.setQueryData<ChatMessage[]>(streamKey(event.sessionId), (old = []) => {
        const saved = old.find((message) => message.id === event.messageId)
        const message: ChatMessage = {
          id: event.messageId,
          role: 'assistant',
          text: event.text,
          createdAt: saved?.createdAt ?? Date.now()
        }
        return saved ? old.map((row) => row.id === message.id ? message : row) : [...old, message]
      })
    } else if (event.kind === 'session.activity' && !event.running) {
      // Keep live text until history has caught up, including the final flush.
      refresh(event.sessionId)
    } else if (event.kind === 'chat.idle') {
      refresh(event.sessionId === '*' ? undefined : event.sessionId)
    } else if (event.kind === 'chat.tool' || event.kind === 'session.queue') {
      refresh(event.sessionId)
    } else if (event.kind === 'review.updated' || event.kind === 'work.updated') {
      refresh()
    } else if (event.kind === 'service' && event.status.state === 'connected') {
      refresh()
    }
  })
}
