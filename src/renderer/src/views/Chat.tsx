import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@shared/types'

export function ChatView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const qc = useQueryClient()
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list() })
  const chat = chats.data?.find((c) => c.sessionId === sessionId)

  const messages = useQuery({
    queryKey: ['chat-messages', sessionId],
    queryFn: () => window.revva.chat.messages(sessionId),
    refetchInterval: (q) => (q.state.status === 'error' ? 5000 : false)
  })

  /** Live streamed text for the in-flight assistant message (null when idle). */
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const running = streamingText !== null

  useEffect(() => {
    setStreamingText(null)
  }, [sessionId])

  useEffect(() => {
    return window.revva.events.on((event) => {
      if (event.kind === 'chat.delta' && event.sessionId === sessionId) {
        setStreamingText(event.text)
      } else if (event.kind === 'chat.idle' && (event.sessionId === sessionId || event.sessionId === '*')) {
        setStreamingText(null)
        void qc.invalidateQueries({ queryKey: ['chat-messages', sessionId] })
      }
    })
  }, [sessionId, qc])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.data, streamingText])

  const send = useMutation({
    mutationFn: async () => {
      const text = input.trim()
      if (!text) return
      setInput('')
      await window.revva.chat.prompt(sessionId, text)
      // optimistic: show a placeholder user row, then live history from OpenCode
      setStreamingText((prev) => prev ?? '')
      qc.setQueryData<ChatMessage[]>(['chat-messages', sessionId], (old) => [
        ...(old ?? []),
        { id: `pending-${Date.now()}`, role: 'user', text, createdAt: Date.now() }
      ])
    },
    onSettled: () => {
      // Fetch full history shortly after to reconcile server-side ids/order.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['chat-messages', sessionId] }), 400)
    }
  })

  const interrupt = useMutation({
    mutationFn: () => window.revva.chat.interrupt(sessionId),
    onSettled: () => setStreamingText(null)
  })

  const rows = useMemo(() => messages.data ?? [], [messages.data])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <span className="truncate text-[13px] font-medium">{chat?.title ?? 'Chat'}</span>
        {chat && (
          <Badge variant="outline" className="max-w-72 truncate font-mono text-[10px] font-normal">
            {chat.directory}
          </Badge>
        )}
        {running && (
          <Badge variant="secondary" className="ml-auto animate-pulse text-[10px]">
            running…
          </Badge>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-5">
          {messages.isLoading && <Skeleton className="h-16 w-full" />}
          {!messages.isLoading && rows.length === 0 && !running && (
            <p className="mt-10 text-center text-sm text-muted-foreground">
              Ask anything about this project — this chat is not attached to a ticket.
            </p>
          )}
          {rows.map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
          {running && (
            <MessageRow
              message={{ id: 'streaming', role: 'assistant', text: streamingText ?? '', createdAt: Date.now() }}
              streaming
            />
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t px-6 py-3">
        <form
          className="mx-auto flex max-w-3xl items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!running) send.mutate()
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!running) send.mutate()
              }
            }}
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            rows={2}
            className="min-h-[44px] resize-y"
          />
          {running ? (
            <Button type="button" size="icon" variant="outline" onClick={() => interrupt.mutate()}>
              <Square className="size-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!input.trim() || send.isPending}>
              <ArrowUp className="size-4" />
            </Button>
          )}
        </form>
      </div>
    </div>
  )
}

function MessageRow({ message, streaming }: { message: ChatMessage; streaming?: boolean }): React.JSX.Element {
  const isUser = message.role === 'user'
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted',
          streaming && message.text === '' && 'italic text-muted-foreground'
        )}
      >
        {message.text === '' && streaming ? 'Thinking…' : message.text}
        {streaming && message.text !== '' && <span className="animate-pulse">▍</span>}
      </div>
    </div>
  )
}
