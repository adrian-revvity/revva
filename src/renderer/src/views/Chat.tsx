import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, ChevronRight, ImageIcon, Square, X } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { ChatMessage, ChatToolCall, FileHit, PromptImage, PromptRefs, QueuedMessage, SkillInfo } from '@shared/types'

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

export function TranscriptView({
  sessionId,
  drive,
  header,
  emptyHint,
  readOnly
}: {
  sessionId: string
  drive: TranscriptDrive
  header: ReactNode
  emptyHint: string
  /** Hides the composer (reviewer sessions are read-only). */
  readOnly?: boolean
}): React.JSX.Element {
  const qc = useQueryClient()
  const messages = useQuery({
    queryKey: [...drive.queryKey, sessionId],
    queryFn: () => drive.load(sessionId),
    refetchInterval: (q) => (q.state.status === 'error' ? 5000 : false)
  })
  const model = useQuery({
    queryKey: ['session-model', sessionId],
    queryFn: () => window.revva.session.model(sessionId)
  })
  const modelLabel = model.data
    ? `${model.data.providerID}/${model.data.id}${model.data.variant ? ` · ${model.data.variant}` : ''}`
    : model.isError ? 'Unavailable' : model.isPending ? 'Loading…' : 'Service default'
  const queue = useQuery({
    queryKey: ['session-queue', sessionId],
    queryFn: () => window.revva.session.queue(sessionId)
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
  const running = streamingText !== null

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
  const menuItems = token?.kind === 'skill' ? skillMatches.length : fileMatches.length

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
      }
    )
  }, [sessionId, drive, qc])

  // Main pushes queue/model changes for every session (bus forwards all sessions, so
  // the TUI and other clients are covered); these pushes are the update channel.
  useEffect(() => {
    return window.revva.events.on((event) => {
      if (event.kind === 'session.queue' && event.sessionId === sessionId) {
        void qc.invalidateQueries({ queryKey: ['session-queue', sessionId] })
      }
      if (event.kind === 'session.model' && event.sessionId === sessionId) {
        void qc.invalidateQueries({ queryKey: ['session-model', sessionId] })
      }
    })
  }, [sessionId, qc])

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

  const send = useMutation({
    mutationFn: async () => {
      const text = input.trim()
      const images = pendingImages
      if (!text && images.length === 0) return
      const refs = extractRefs(text, skills.data ?? [])
      qc.setQueryData(draftKey, '')
      setPendingImages([])
      setToken(null)
      await drive.send(sessionId, text, images.length ? images : undefined, running, refs)
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
  const queued = queue.data ?? []
  const canSend = (input.trim().length > 0 || pendingImages.length > 0) && !send.isPending

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-4">
        {header}
        <Badge variant="outline" className="ml-auto min-w-0 max-w-60 shrink text-[10px] font-normal" title={`Model: ${modelLabel}`}>
          <span className="truncate">Model: {modelLabel}</span>
        </Badge>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-5">
          {messages.isLoading && <Skeleton className="h-16 w-full" />}
          {!messages.isLoading && rows.length === 0 && !running && (
            <p className="mt-10 text-center text-sm text-muted-foreground">{emptyHint}</p>
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

      {!readOnly && (
        <div className="shrink-0 border-t px-6 py-3">
          {queued.length > 0 && (
            <div className="mx-auto mb-2 flex max-w-3xl flex-col gap-1">
              {queued.map((q, i) => (
                <QueuedRow key={q.id} item={q} position={i + 1} onCancel={() => cancelQueued.mutate(q.id)} />
              ))}
            </div>
          )}
          <form
            className="mx-auto flex max-w-3xl items-end gap-2"
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
            <div className="relative flex min-w-0 flex-1 flex-col gap-2">
              {token && menuItems > 0 && (
                <div className="absolute bottom-full left-0 z-10 mb-2 flex w-80 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
                  <div className="border-b px-2.5 py-1 text-[10px] text-muted-foreground">
                    {token.kind === 'skill' ? 'Skills — Enter/Tab to insert' : 'Files — Enter/Tab to insert'}
                  </div>
                  {(token.kind === 'skill' ? skillMatches : fileMatches).map((item, i) => (
                    <button
                      key={token.kind === 'skill' ? (item as SkillInfo).id : (item as FileHit).path}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() =>
                        acceptToken(
                          token.kind === 'skill'
                            ? `/${(item as SkillInfo).id}`
                            : `@${(item as FileHit).path}${(item as FileHit).type === 'directory' ? '/' : ''}`
                        )
                      }
                      className={cn(
                        'flex items-baseline gap-2 px-2.5 py-1.5 text-left text-xs',
                        i === tokenIndex && 'bg-muted'
                      )}
                    >
                      <span className="shrink-0 font-mono font-medium">
                        {token.kind === 'skill' ? `/${(item as SkillInfo).id}` : `@${(item as FileHit).path}`}
                      </span>
                      {token.kind === 'skill' && (item as SkillInfo).description && (
                        <span className="truncate text-muted-foreground">{(item as SkillInfo).description}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {pendingImages.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {pendingImages.map((img, i) => (
                    <div key={i} className="group relative">
                      <img
                        src={`data:${img.mime};base64,${img.data}`}
                        alt={img.name ?? 'attachment'}
                        className="size-14 rounded-md border object-cover"
                      />
                      <button
                        type="button"
                        aria-label="Remove image"
                        onClick={() => setPendingImages((old) => old.filter((_, j) => j !== i))}
                        className="absolute -right-1.5 -top-1.5 hidden rounded-full border bg-background p-0.5 shadow group-hover:block"
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
                      const pick =
                        token.kind === 'skill'
                          ? `/${skillMatches[tokenIndex]?.id ?? skillMatches[tokenIndex]?.name ?? ''}`
                          : `@${fileMatches[tokenIndex]?.path ?? ''}`
                      acceptToken(pick)
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
                    : 'Message… (Enter to send, Shift+Enter for newline, paste or drop images)'
                }
                rows={2}
                className="min-h-[44px] resize-y"
              />
            </div>
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
              size="icon"
              variant="ghost"
              aria-label="Attach images"
              disabled={pendingImages.length >= MAX_IMAGES}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon className="size-4" />
            </Button>
            {running && (
              <Button type="button" size="icon" variant="outline" onClick={() => interrupt.mutate()}>
                <Square className="size-4" />
              </Button>
            )}
            <Button type="submit" size="icon" disabled={!canSend}>
              <ArrowUp className="size-4" />
            </Button>
          </form>
        </div>
      )}
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

/**
 * Markdown rendering for assistant messages. react-markdown passes an extra
 * `node` prop, so every renderer destructures it out before spreading onto DOM.
 */
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      className="cursor-pointer text-blue-600 underline underline-offset-2 dark:text-blue-400"
      onClick={(e) => {
        e.preventDefault()
        if (props.href) void window.revva.shell.openExternal(props.href)
      }}
    />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="overflow-x-auto rounded-md border border-black/10 bg-black/[0.04] px-3 py-2 text-xs leading-relaxed dark:border-white/10 dark:bg-white/[0.06] [&_code]:bg-transparent [&_code]:p-0"
    />
  ),
  code: ({ node: _node, ...props }) => (
    <code {...props} className="rounded bg-black/10 px-1 py-0.5 font-mono text-[11px] dark:bg-white/10" />
  ),
  table: ({ node: _node, ...props }) => <table className="my-2 w-full border-collapse text-xs" {...props} />,
  th: ({ node: _node, ...props }) => (
    <th className="border border-black/15 px-2 py-1 text-left font-medium dark:border-white/15" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border border-black/15 px-2 py-1 align-top dark:border-white/15" {...props} />
  ),
  // Tight spacing: bubbles are compact, so markdown's default margins are too wide.
  p: ({ node: _node, ...props }) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4" {...props} />,
  li: ({ node: _node, ...props }) => <li className="pl-0.5" {...props} />,
  h1: ({ node: _node, ...props }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-1.5 border-l-2 border-black/20 pl-3 italic opacity-80 dark:border-white/25" {...props} />
  ),
  hr: () => <hr className="my-3 border-black/10 dark:border-white/15" />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold" {...props} />,
  // GFM task lists render a disabled checkbox.
  input: ({ node: _node, ...props }) => (
    <input type="checkbox" disabled className="mr-1.5 size-3 translate-y-0.5 accent-primary" {...props} />
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

export function ChatView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list() })
  const chat = chats.data?.find((c) => c.sessionId === sessionId)
  return (
    <TranscriptView
      sessionId={sessionId}
      drive={chatDrive}
      emptyHint="Ask anything about this project — this chat is not attached to a ticket."
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
