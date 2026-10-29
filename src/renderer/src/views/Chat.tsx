import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Check, ChevronRight, Copy, ImageIcon, Square, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { MD_COMPONENTS } from '@/components/message-markdown'
import type { ChatMessage, ChatToolCall, FileHit, PromptImage, PromptRefs, QueuedMessage, SkillInfo } from '@shared/types'
import { FormCard, PermissionCard, useInbox } from './InboxView'

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'
const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/* ---------- composer tokens: /skill and @file ---------- */

/** Which token the caret sits in right now (drives the autocomplete menu). */
interface ActiveToken {
  kind: 'skill' | 'file'
  query: string
  /** Index of the sigil in the input value. */
  start: number
}
function activeToken(value: string, caret: number): ActiveToken | null {
  const before = value.slice(0, caret)
  const skill = before.match(/(?:^|\s)\/([\w.:-]*)$/)
  if (skill) {
    const query = skill[1] ?? ''
    return { kind: 'skill', query, start: caret - query.length - 1 }
  }
  const file = before.match(/(?:^|\s)@([\w.~/+-]*)$/)
  if (file) {
    const query = file[1] ?? ''
    return { kind: 'file', query, start: caret - query.length - 1 }
  }
  return null
}

/** Tokenize the final text into OpenCode prompt refs (offsets are UTF-16 indices into text). */
function extractRefs(text: string, skills: SkillInfo[]): PromptRefs {
  const byToken = new Map<string, SkillInfo>()
  for (const s of skills) {
    byToken.set(s.id.toLowerCase(), s)
    if (s.name) byToken.set(s.name.toLowerCase().replace(/\s+/g, '-'), s)
  }
  const refs: PromptRefs = { skills: [], files: [] }
  for (const m of text.matchAll(/(?:^|\s)(\/[\w.:-]+)/g)) {
    const token = m[1] ?? ''
    const s = byToken.get(token.slice(1).toLowerCase())
    if (!s || refs.skills.length >= 8) continue
    const start = (m.index ?? 0) + m[0].lastIndexOf(token)
    refs.skills.push({ id: s.id, name: s.name ?? s.id, start, end: start + token.length, text: token })
  }
  for (const m of text.matchAll(/(?:^|\s)(@[\w.~/+-]+)/g)) {
    // '@foo' with no path separator is chat-speak, not a file; also cap per schema.
    const token = m[1] ?? ''
    if (!token.includes('/') && !token.includes('.')) continue
    if (refs.files.length >= 12) continue
    const start = (m.index ?? 0) + m[0].lastIndexOf(token)
    refs.files.push({ path: token.slice(1), start, end: start + token.length, text: token })
  }
  return refs
}

/** Read image File objects into base64 payloads the main process can forward to OpenCode. */
async function filesToImages(files: File[]): Promise<PromptImage[]> {
  const allowed = IMAGE_ACCEPT.split(',') as PromptImage['mime'][]
  const out: PromptImage[] = []
  for (const file of files) {
    const mime = allowed.find((m) => m === file.type)
    if (!mime) continue
    if (file.size > MAX_IMAGE_BYTES) continue
    const buf = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    out.push({ name: file.name || undefined, mime, data: btoa(binary) })
  }
  return out
}

/** Everything a transcript surface needs, so chats and ticket cockpit share one view. */
export interface TranscriptDrive {
  /** Stable cache key prefix, e.g. ['chat-messages'] or ['work-messages']. */
  queryKey: readonly unknown[]
  load(sessionId: string): Promise<ChatMessage[]>
  /** `queued` = session is busy; park the message in the inbox behind the running turn. */
  send(sessionId: string, text: string, images?: PromptImage[], queued?: boolean, refs?: PromptRefs): Promise<void>
  interrupt(sessionId: string): Promise<void>
  /**
   * Subscribe to streaming for this session. `onDelta` receives the FULL accumulated
   * text (callers normalize increment-vs-accumulate); `onDone` fires on completion.
   */
  subscribe(
    sessionId: string,
    onDelta: (accumulated: string) => void,
    onDone: () => void
  ): () => void
}

export function SessionIdButton({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const timer = window.setTimeout(() => setStatus('idle'), 3000)
    return () => window.clearTimeout(timer)
  }, [status])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="min-w-0 max-w-40 text-muted-foreground"
          aria-label={`Copy session ID ${sessionId}`}
          onClick={() => {
            void window.revva.session.copyId(sessionId).then(() => setStatus('copied'), () => setStatus('error'))
          }}
        >
          {status === 'copied' ? <Check /> : <Copy />}
          <span className="truncate font-mono">{status === 'copied' ? 'Copied' : status === 'error' ? 'Copy failed' : sessionId}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{status === 'error' ? 'Could not copy session ID. Try again.' : `Copy session ID: ${sessionId}`}</TooltipContent>
      <span role="status" className="sr-only">{status === 'copied' ? 'Session ID copied' : status === 'error' ? 'Could not copy session ID' : ''}</span>
    </Tooltip>
  )
}

export function TranscriptView({
  sessionId,
  drive,
  header,
  emptyHint,
  readOnly,
  onNewSession,
  hideSessionDetails
}: {
  sessionId: string
  drive: TranscriptDrive
  header: ReactNode
  emptyHint: string
  /** Hides the composer (reviewer sessions are read-only). */
  readOnly?: boolean
  /** When set, sending exactly `/new` calls this instead (chats: fresh session, same settings). */
  onNewSession?: () => void
  /** Session details are shown elsewhere for ticket transcripts. */
  hideSessionDetails?: boolean
}): React.JSX.Element {
  const qc = useQueryClient()
  const pending = useInbox().filter((item) => item.sessionID === sessionId)
  const messages = useQuery({
    queryKey: [...drive.queryKey, sessionId],
    queryFn: () => drive.load(sessionId),
    refetchInterval: (q) => (q.state.status === 'error' ? 5000 : false)
  })
  const model = useQuery({
    queryKey: ['session-model', sessionId],
    queryFn: () => window.revva.session.model(sessionId),
    refetchInterval: 10_000
  })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models() })
  const modelLabel = model.data
    ? `${model.data.providerID}/${model.data.id}${model.data.variant ? ` · ${model.data.variant}` : ''}`
    : model.isError ? 'Unavailable' : model.isPending ? 'Loading…' : 'Service default'
  const shortModelLabel = model.data
    ? models.data?.find((item) => item.providerID === model.data?.providerID && item.id === model.data?.id)?.name || model.data.id
    : modelLabel
  const queue = useQuery({
    queryKey: ['session-queue', sessionId],
    queryFn: () => window.revva.session.queue(sessionId),
    refetchInterval: 15_000
  })
  // Keep drafts in the renderer cache when a transcript unmounts or changes sessions.
  const draftKey = ['session-draft', sessionId] as const
  const { data: input } = useQuery({
    queryKey: draftKey,
    queryFn: () => '',
    initialData: '',
    enabled: false,
    gcTime: Infinity
  })

  /** Live streamed text for the in-flight assistant message (null when idle). */
  const [streamingText, setStreamingText] = useState<string | null>(null)
  /** Images staged in the composer, waiting to be sent with the next message. */
  const [pendingImages, setPendingImages] = useState<PromptImage[]>([])
  /** Token under the caret (drives the /skill @file menu) and the highlighted row. */
  const [token, setToken] = useState<ActiveToken | null>(null)
  const [tokenIndex, setTokenIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const positionedSessionRef = useRef<string | null>(null)
  const running = streamingText !== null
  const contextUsage = useQuery({
    queryKey: ['session-context-usage', sessionId],
    queryFn: () => window.revva.session.contextUsage(sessionId),
    refetchInterval: running ? 30_000 : false
  })
  const usage = contextUsage.data
  const usageLabel = usage?.limit
    ? `${Math.round(usage.tokens / usage.limit * 100)}%`
    : '—'
  const contextIndicator = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Context usage: ${usageLabel}`}
          className="shrink-0 rounded px-1 py-2 text-xs tabular-nums text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {usageLabel}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {usage ? `${usage.tokens.toLocaleString()} tokens` : contextUsage.isPending ? 'Loading…' : 'Token count unavailable'}
      </TooltipContent>
    </Tooltip>
  )

  const skills = useQuery({
    queryKey: ['skills'],
    queryFn: () => window.revva.inventory.skills(),
    staleTime: 5 * 60_000,
    enabled: !readOnly
  })
  const skillMatches = useMemo(() => {
    if (!token || token.kind !== 'skill') return []
    const q = token.query.toLowerCase()
    const list = skills.data ?? []
    return (q ? list.filter((s) => `${s.id} ${s.name ?? ''}`.toLowerCase().includes(q)) : list).slice(0, 8)
  }, [token, skills.data])
  const fileHits = useQuery({
    queryKey: ['file-find', sessionId, token?.kind === 'file' ? token.query : null],
    queryFn: () => window.revva.file.find(sessionId, token?.query ?? ''),
    enabled: token?.kind === 'file' && (token.query.length >= 1),
    staleTime: 30_000
  })
  const fileMatches: FileHit[] = fileHits.data ?? []
  /** One row in the autocomplete menu; `run` items fire an action instead of inserting. */
  interface MenuItem {
    key: string
    insert: string
    hint?: string
    run?: () => void
  }
  const menuList: MenuItem[] = useMemo(() => {
    if (!token) return []
    if (token.kind === 'file') {
      return fileMatches.map((f) => ({
        key: f.path,
        insert: `@${f.path}${f.type === 'directory' ? '/' : ''}`
      }))
    }
    const items: MenuItem[] = []
    const q = token.query.toLowerCase()
    if (onNewSession && 'new'.startsWith(q)) {
      items.push({ key: '__new', insert: '/new', hint: 'New session, same settings (fresh context)', run: onNewSession })
    }
    for (const s of skillMatches) items.push({ key: s.id, insert: `/${s.id}`, hint: s.description })
    return items.slice(0, 9)
  }, [token, skillMatches, fileMatches, onNewSession])
  const menuItems = menuList.length

  useEffect(() => {
    setStreamingText(null)
    setPendingImages([])
  }, [sessionId])

  useEffect(() => {
    return drive.subscribe(
      sessionId,
      (text) => setStreamingText(text),
      () => {
        setStreamingText(null)
        void qc.invalidateQueries({ queryKey: [...drive.queryKey, sessionId] })
        void qc.invalidateQueries({ queryKey: ['session-queue', sessionId] })
        void qc.invalidateQueries({ queryKey: ['session-model', sessionId] })
        void qc.invalidateQueries({ queryKey: ['session-context-usage', sessionId] })
      }
    )
  }, [sessionId, drive, qc])

  // Inbox/queue and model selection change from outside this window too (TUI, other clients).
  useEffect(() => {
    return window.revva.events.on((event) => {
      if (event.kind === 'session.queue' && event.sessionId === sessionId) {
        void qc.invalidateQueries({ queryKey: ['session-queue', sessionId] })
      }
      if (event.kind === 'session.model' && event.sessionId === sessionId) {
        void qc.invalidateQueries({ queryKey: ['session-model', sessionId] })
      }
      if (event.kind === 'session.activity' && event.sessionId === sessionId && !event.running) {
        void qc.invalidateQueries({ queryKey: ['session-context-usage', sessionId] })
      }
    })
  }, [sessionId, qc])

  useLayoutEffect(() => {
    positionedSessionRef.current = null
  }, [sessionId])

  useLayoutEffect(() => {
    if (!messages.data || positionedSessionRef.current === sessionId) return
    bottomRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
    positionedSessionRef.current = sessionId
  }, [sessionId, messages.data])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.data, streamingText])

  const addImages = async (files: File[]): Promise<void> => {
    const images = await filesToImages(files)
    if (images.length) setPendingImages((old) => [...old, ...images].slice(0, MAX_IMAGES))
  }

  const updateToken = (): void => {
    const el = textareaRef.current
    if (!el) return
    setToken(activeToken(el.value, el.selectionStart))
    setTokenIndex(0)
  }

  /** Replace the active token with a picked `/skill` or `@path`. */
  const acceptToken = (insert: string): void => {
    const el = textareaRef.current
    if (!token || !el) return
    const caret = el.selectionStart
    const next = input.slice(0, token.start) + insert + ' ' + input.slice(caret)
    qc.setQueryData(draftKey, next)
    const pos = token.start + insert.length + 1
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
      setToken(null)
    })
  }

  /** Accept the highlighted menu row: fire its action or insert its token. */
  const pickMenu = (item: MenuItem): void => {
    if (item.run) {
      qc.setQueryData(draftKey, '')
      setToken(null)
      item.run()
    } else {
      acceptToken(item.insert)
    }
  }

  const send = useMutation({
    mutationFn: async () => {
      const text = input.trim()
      const images = pendingImages
      // '/new' on its own is a command, not a message.
      if (text === '/new' && images.length === 0 && onNewSession) {
        qc.setQueryData(draftKey, '')
        setToken(null)
        onNewSession()
        return
      }
      if (!text && images.length === 0) return
      const refs = extractRefs(text, skills.data ?? [])
      await drive.send(sessionId, text, images.length ? images : undefined, running, refs)
      if (qc.getQueryData(draftKey) === input) qc.setQueryData(draftKey, '')
      setPendingImages((current) => current.filter((image) => !images.includes(image)))
      setToken(null)
      if (running) {
        // Queued behind the running turn — it shows up in the queue strip, not the transcript.
        void qc.invalidateQueries({ queryKey: ['session-queue', sessionId] })
      } else {
        setStreamingText((prev) => prev ?? '')
        qc.setQueryData<ChatMessage[]>([...drive.queryKey, sessionId], (old) => [
          ...(old ?? []),
          {
            id: `pending-${Date.now()}`,
            role: 'user',
            text,
            images: images.length
              ? images.map((img) => ({ name: img.name, mime: img.mime, data: `data:${img.mime};base64,${img.data}` }))
              : undefined,
            createdAt: Date.now()
          }
        ])
      }
    },
    onSettled: () => {
      // Refetch shortly after to reconcile server-side ids/order.
      setTimeout(() => void qc.invalidateQueries({ queryKey: [...drive.queryKey, sessionId] }), 400)
    }
  })

  const cancelQueued = useMutation({
    mutationFn: (inboxId: string) => window.revva.session.cancelQueued(sessionId, inboxId),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['session-queue', sessionId] })
  })

  const interrupt = useMutation({
    mutationFn: () => drive.interrupt(sessionId),
    onSettled: () => setStreamingText(null)
  })

  const rows = useMemo(() => messages.data ?? [], [messages.data])
  /** Consecutive assistant messages are steps of one agent turn — one card each. */
  const groups = useMemo(() => groupRows(rows), [rows])
  const queued = queue.data ?? []
  const canSend = (input.trim().length > 0 || pendingImages.length > 0) && !send.isPending

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">{header}</div>
        {!hideSessionDetails && (
          <>
            <SessionIdButton key={sessionId} sessionId={sessionId} />
            <Badge variant="outline" className="min-w-0 max-w-60 shrink text-[10px] font-normal" title={`Model: ${modelLabel}`}>
              <span className="truncate">Model: {shortModelLabel}</span>
            </Badge>
          </>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-5">
            {messages.isLoading && <Skeleton className="h-16 w-full" />}
            {!messages.isLoading && rows.length === 0 && !running && (
              <p className="mt-10 text-center text-sm text-muted-foreground">{emptyHint}</p>
            )}
            {groups.map((g, i) =>
              g.kind === 'user' ? (
                <MessageRow key={g.msg.id} message={g.msg} />
              ) : (
                <AssistantTurn
                  key={g.msgs[0]?.id ?? i}
                  messages={g.msgs}
                  streaming={running && i === groups.length - 1}
                  streamingText={running && i === groups.length - 1 ? streamingText : null}
                />
              )
            )}
            {running && groups[groups.length - 1]?.kind !== 'assistant' && (
              <MessageRow
                message={{ id: 'streaming', role: 'assistant', text: streamingText ?? '', createdAt: Date.now() }}
                streaming
              />
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      </div>

      {!readOnly && pending.length > 0 && (
        <section aria-label="Waiting on you" className="max-h-[40vh] shrink-0 overflow-y-auto border-t bg-muted/30 px-3 py-3 sm:px-6">
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">Waiting on you ({pending.length})</p>
            {pending.map((item) =>
              item.kind === 'form' ? (
                <FormCard key={`${item.kind}:${item.id}`} item={item} />
              ) : (
                <PermissionCard key={`${item.kind}:${item.id}`} item={item} />
              )
            )}
          </div>
        </section>
      )}

      {!readOnly && (
        <div className="shrink-0 border-t px-3 py-3 sm:px-6">
          {queued.length > 0 && (
            <div className="mx-auto mb-2 flex max-w-3xl flex-col gap-1">
              {queued.map((q, i) => (
                <QueuedRow key={q.id} item={q} position={i + 1} onCancel={() => cancelQueued.mutate(q.id)} />
              ))}
            </div>
          )}
          {send.error instanceof Error && (
            <p role="alert" className="mx-auto mb-2 max-w-3xl text-xs text-destructive">{send.error.message}</p>
          )}
          <form
            className="relative mx-auto max-w-3xl"
            onSubmit={(e) => {
              e.preventDefault()
              send.mutate()
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files)
              if (files.some((f) => f.type.startsWith('image/'))) {
                e.preventDefault()
                void addImages(files)
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void addImages(Array.from(e.dataTransfer.files))
            }}
          >
            {token && menuItems > 0 && (
              <div className="absolute bottom-full left-0 z-10 mb-2 flex w-80 max-w-full flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
                <div className="border-b px-2.5 py-1 text-[10px] text-muted-foreground">
                  {token.kind === 'skill' ? 'Commands — Enter/Tab to insert' : 'Files — Enter/Tab to insert'}
                </div>
                {menuList.map((item, i) => (
                  <button
                    key={item.key}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickMenu(item)}
                    className={cn(
                      'flex items-baseline gap-2 px-2.5 py-1.5 text-left text-xs',
                      i === tokenIndex && 'bg-muted'
                    )}
                  >
                    <span className="shrink-0 font-mono font-medium">{item.insert}</span>
                    {item.hint && <span className="truncate text-muted-foreground">{item.hint}</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-col rounded-xl border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
              {pendingImages.length > 0 && (
                <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto px-3 pt-3">
                  {pendingImages.map((img, i) => (
                    <div key={i} className="relative shrink-0">
                      <img
                        src={`data:${img.mime};base64,${img.data}`}
                        alt={img.name ?? 'attachment'}
                        className="size-16 rounded-md border bg-muted object-contain"
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${img.name || `image ${i + 1}`}`}
                        onClick={() => setPendingImages((old) => old.filter((_, j) => j !== i))}
                        className="absolute right-0.5 top-0.5 rounded-sm bg-background p-1 text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  qc.setQueryData(draftKey, e.target.value)
                  updateToken()
                }}
                onSelect={updateToken}
                onBlur={() => setToken(null)}
                onKeyDown={(e) => {
                  if (token && menuItems > 0) {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      setTokenIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % menuItems : (i - 1 + menuItems) % menuItems))
                      return
                    }
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                      e.preventDefault()
                      const pick = menuList[tokenIndex]
                      if (pick) pickMenu(pick)
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setToken(null)
                      return
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send.mutate()
                  }
                }}
                placeholder={
                  running
                    ? 'Running — send to queue your message…'
                    : 'Message…'
                }
                aria-label="Message"
                aria-describedby="composer-hint"
                rows={2}
                className="max-h-48 min-h-16 resize-none rounded-none border-0 bg-transparent px-4 pb-2 pt-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
              <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={IMAGE_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void addImages(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Attach images"
                  title="Attach, paste or drop images"
                  disabled={pendingImages.length >= MAX_IMAGES}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageIcon />
                </Button>
                <span id="composer-hint" className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
                  Enter to send · Shift+Enter for a new line
                </span>
                {contextIndicator}
                {running && (
                  <Button type="button" size="icon-sm" variant="outline" aria-label="Stop response" title="Stop response" onClick={() => interrupt.mutate()}>
                    <Square />
                  </Button>
                )}
                <Button type="submit" size="icon-sm" aria-label={running ? 'Queue message' : 'Send message'} title={running ? 'Queue message' : 'Send message'} disabled={!canSend}>
                  <ArrowUp />
                </Button>
              </div>
            </div>
          </form>
        </div>
      )}
      {readOnly && <div className="shrink-0 border-t px-6 py-1 text-right">{contextIndicator}</div>}
    </div>
  )
}

/** One waiting inbox message with its position and a cancel affordance. */
function QueuedRow({ item, position, onCancel }: { item: QueuedMessage; position: number; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="shrink-0 font-medium">#{position} queued</span>
      <span className="truncate">{item.text || (item.imageCount > 0 ? `${item.imageCount} image(s)` : '(empty)')}</span>
      <button type="button" aria-label="Remove queued message" className="ml-auto shrink-0 rounded p-0.5 hover:bg-black/10 hover:text-foreground dark:hover:bg-white/10" onClick={onCancel}>
        <X className="size-3" />
      </button>
    </div>
  )
}

/* ---------- turn grouping ---------- */

type TranscriptGroup = { kind: 'user'; msg: ChatMessage } | { kind: 'assistant'; msgs: ChatMessage[] }

/** Collapse consecutive assistant messages (one per agent-loop step) into a single
 *  turn group, so a chain of tool calls reads as one thought process, not N bubbles. */
function groupRows(rows: ChatMessage[]): TranscriptGroup[] {
  const out: TranscriptGroup[] = []
  for (const m of rows) {
    if (m.role === 'user') out.push({ kind: 'user', msg: m })
    else {
      const last = out[out.length - 1]
      if (last?.kind === 'assistant') last.msgs.push(m)
      else out.push({ kind: 'assistant', msgs: [m] })
    }
  }
  return out
}

/** One agent turn as a single card: thoughts and tool steps collapsed inside,
 *  the answer(s) visible. Auto-collapses the step list once the turn is done. */
function AssistantTurn({
  messages,
  streaming,
  streamingText
}: {
  messages: ChatMessage[]
  streaming: boolean
  streamingText: string | null
}): React.JSX.Element {
  const tools = messages.flatMap((m) => m.tools ?? [])
  const thinking = messages.map((m) => m.thinking).filter(Boolean).join('\n\n')
  const texts = messages.map((m) => m.text).filter((t) => t.trim() !== '')
  const shown = streaming && streamingText !== null ? [...texts, streamingText] : texts
  const busy = streaming || tools.some((t) => t.state === 'running' || t.state === 'streaming')

  const [stepsOpen, setStepsOpen] = useState(true)
  useEffect(() => {
    setStepsOpen(busy)
  }, [busy])

  const nothingYet = shown.length === 0 && tools.length === 0 && !thinking
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] flex-col gap-1.5 rounded-lg bg-muted px-3.5 py-2.5 text-[13px] leading-relaxed">
        {thinking && <ThinkingBlock text={thinking} />}
        {tools.length > 0 && (
          <Collapsible open={stepsOpen} onOpenChange={setStepsOpen} className="group/collapsible">
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3 shrink-0 transition-transform group-data-[open]/collapsible:rotate-90" />
              <span>
                Worked through {tools.length} step{tools.length === 1 ? '' : 's'}
              </span>
              {busy && <span className="animate-pulse italic">running…</span>}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 flex flex-col">
                {tools.map((t) => (
                  <ToolCallRow key={t.id} tool={t} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
        {nothingYet ? (
          <span className="italic text-muted-foreground">{busy ? 'Thinking…' : '…'}</span>
        ) : (
          shown.map((text, i) => (
            <div key={i} className="min-w-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {text}
              </ReactMarkdown>
              {streaming && i === shown.length - 1 && <span className="animate-pulse">▍</span>}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function MessageRow({ message, streaming }: { message: ChatMessage; streaming?: boolean }): React.JSX.Element {
  const isUser = message.role === 'user'
  const empty = message.text === ''
  const images = message.images ?? []
  const tools = message.tools ?? []
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'flex max-w-[85%] flex-col gap-2 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed',
          isUser ? 'bg-primary whitespace-pre-wrap text-primary-foreground' : 'bg-muted',
          streaming && empty && 'italic text-muted-foreground'
        )}
      >
        {images.length > 0 && (
          <div className={cn('flex flex-wrap gap-1.5', tools.length === 0 && images.length === 1 && 'max-w-80')}>
            {images.map((img, i) => (
              <img
                key={i}
                src={img.data}
                alt={img.name ?? 'attachment'}
                className={cn(
                  'rounded-md border border-black/10 object-cover dark:border-white/10',
                  images.length === 1 ? 'max-h-64 max-w-full' : 'size-24'
                )}
              />
            ))}
          </div>
        )}
        {empty && streaming ? (
          'Thinking…'
        ) : isUser ? (
          message.text
        ) : (
          <div className="min-w-0">
            {message.thinking && <ThinkingBlock text={message.thinking} />}
            {tools.map((t) => (
              <ToolCallRow key={t.id} tool={t} />
            ))}
            {!empty && (
              <>
                {tools.length > 0 && <div className="mt-1" />}
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                  {message.text}
                </ReactMarkdown>
              </>
            )}
            {streaming && <span className="animate-pulse">▍</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Faded collapsible for the model's reasoning text. */
function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  return (
    <Collapsible className="group/collapsible mb-1.5 text-xs">
      <CollapsibleTrigger className="flex items-center gap-1 italic text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-data-[open]/collapsible:rotate-90" />
        Thought for a moment
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap border-l border-black/15 pl-2.5 italic text-muted-foreground dark:border-white/15">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

const toolStateLabel: Record<ChatToolCall['state'], string> = {
  streaming: 'preparing…',
  running: 'running…',
  completed: '',
  error: 'failed'
}

/** One tool call as a compact collapsible step: name + input on the trigger, output inside. */
function ToolCallRow({ tool }: { tool: ChatToolCall }): React.JSX.Element {
  const status = toolStateLabel[tool.state]
  return (
    <Collapsible className="group/collapsible not-prose my-1 rounded-md border border-black/10 bg-black/[0.03] text-xs dark:border-white/10 dark:bg-white/[0.04]">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[open]/collapsible:rotate-90" />
        <span className="shrink-0 font-mono font-medium">{tool.name}</span>
        {tool.detail && (
          <span className="truncate font-mono text-muted-foreground" title={tool.detail}>
            {tool.detail.split('\n')[0]}
          </span>
        )}
        {status && (
          <span className={cn('ml-auto shrink-0 italic', tool.state === 'error' ? 'text-destructive' : 'text-muted-foreground', tool.state !== 'completed' && tool.state !== 'error' && 'animate-pulse')}>
            {status}
          </span>
        )}
      </CollapsibleTrigger>
      {tool.output && (
        <CollapsibleContent>
          <pre
            className={cn(
              'max-h-56 overflow-auto border-t border-black/10 px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap dark:border-white/10',
              tool.state === 'error' && 'text-destructive'
            )}
          >
            {tool.output}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

export function RunningBadge({ running }: { running: boolean }): React.JSX.Element | null {
  if (!running) return null
  return (
    <Badge variant="secondary" className="ml-auto animate-pulse text-[10px]">
      running…
    </Badge>
  )
}

/* ---------- Concrete drives ---------- */

export const chatDrive: TranscriptDrive = {
  queryKey: ['chat-messages'],
  load: (id) => window.revva.chat.messages(id),
  send: (id, text, images, queued, refs) => window.revva.chat.prompt(id, text, images, queued, refs),
  interrupt: (id) => window.revva.chat.interrupt(id),
  subscribe: (id, onDelta, onDone) =>
    window.revva.events.on((event) => {
      if (event.kind === 'chat.delta' && event.sessionId === id) onDelta(event.text)
      else if (event.kind === 'chat.idle' && (event.sessionId === id || event.sessionId === '*')) onDone()
    })
}

export function ChatView({ sessionId, onOpenChat }: { sessionId: string; onOpenChat?: (sessionId: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list() })
  const chat = chats.data?.find((c) => c.sessionId === sessionId)
  /** `/new` — fresh context: a new session with this chat's directory/agent/model/links. */
  const newSession = (): void => {
    if (!chat || !onOpenChat) return
    void window.revva.chat
      .create({
        directory: chat.directory,
        agentID: chat.agentID,
        model: chat.providerID && chat.modelID ? { providerID: chat.providerID, id: chat.modelID } : undefined,
        ticketKey: chat.ticketKey,
        prUrl: chat.prUrl
      })
      .then((created) => {
        void qc.invalidateQueries({ queryKey: ['chats'] })
        onOpenChat(created.sessionId)
      })
      .catch((err) => console.error('[chat] /new failed:', err))
  }
  return (
    <TranscriptView
      sessionId={sessionId}
      drive={chatDrive}
      emptyHint="Ask anything about this project — this chat is not attached to a ticket."
      onNewSession={onOpenChat && chat ? newSession : undefined}
      header={
        <>
          <span className="truncate text-[13px] font-medium">{chat?.title ?? 'Chat'}</span>
          {chat && (
            <Badge variant="outline" className="max-w-72 truncate font-mono text-[10px] font-normal">
              {chat.directory}
            </Badge>
          )}
        </>
      }
    />
  )
}
