import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Inbox as InboxIcon,
  ShieldAlert,
  MessageCircleQuestion,
  FolderOpen,
  CheckCheck,
  ArrowUp,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  List,
  Layers,
  ArrowLeftRight,
  Hammer,
  MessageSquare
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { workStateLabels } from '@/lib/work-state'
import { MD_COMPONENTS } from '@/components/message-markdown'
import type { FinishedRun, InboxField, PendingItem, TriageEntry, WorkState } from '@shared/types'

/** Raw FormInfo.fields come across IPC untyped; normalize to InboxField[]. */
function normalizeFields(raw: unknown): InboxField[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      key: String(f.key ?? ''),
      title: typeof f.title === 'string' ? f.title : undefined,
      description: typeof f.description === 'string' ? f.description : undefined,
      type: (['string', 'number', 'integer', 'boolean', 'multiselect'].includes(String(f.type))
        ? String(f.type)
        : 'string') as InboxField['type'],
      required: typeof f.required === 'boolean' ? f.required : undefined,
      placeholder: typeof f.placeholder === 'string' ? f.placeholder : undefined,
      default: f.default,
      options: Array.isArray(f.options)
        ? (f.options as Array<Record<string, unknown>>).map((o) => ({
            value: String(o.value ?? ''),
            label: typeof o.label === 'string' ? o.label : undefined
          }))
        : undefined
    }))
    .filter((f) => f.key)
}

function useInboxQuery() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['inbox'], queryFn: () => window.revva.inbox.list() })
  // Main pushes the authoritative snapshot; keep the cache in sync.
  useEffect(() => {
    return window.revva.events.on((e) => {
      if (e.kind === 'inbox') qc.setQueryData(['inbox'], e.items)
    })
  }, [qc])
  return q
}

export function useInbox(): PendingItem[] {
  return useInboxQuery().data ?? []
}

/** Pending items stay available even if the newer finished-run feed fails to load. */
function useTriageState(): { entries: TriageEntry[]; loading: boolean; error: boolean; errorDetail: string | null; unavailable: boolean; pendingError: boolean; pendingErrorDetail: string | null; retrying: boolean; retry: () => void } {
  const qc = useQueryClient()
  const pending = useInboxQuery()
  const [retrying, setRetrying] = useState(false)
  // During development the renderer can reload before the Electron preload does.
  const unavailable = !window.revva.triage
  const q = useQuery({
    queryKey: ['triage'],
    queryFn: () => window.revva.triage.list(),
    enabled: !unavailable,
    retry: false
  })
  useEffect(() => {
    return window.revva.events.on((e) => {
      if (e.kind === 'triage') qc.setQueryData(['triage'], e.entries)
      // Any pending-item or completion change invalidates the merged feed.
      else if (e.kind === 'inbox' || e.kind === 'chat.idle' || e.kind === 'work.updated')
        void qc.invalidateQueries({ queryKey: ['triage'] })
    })
  }, [qc])
  return {
    entries: [
      ...(pending.data ?? []).map((item): TriageEntry => ({ type: 'pending', item })),
      ...(q.data ?? []).filter((entry) => entry.type === 'finished')
    ],
    loading: pending.isLoading || (!unavailable && q.isLoading),
    error: q.isError,
    errorDetail: q.isError ? errorMessage(q.error) : null,
    unavailable,
    pendingError: pending.isError,
    pendingErrorDetail: pending.isError ? errorMessage(pending.error) : null,
    retrying,
    retry: () => {
      if (retrying) return
      setRetrying(true)
      const requests = []
      if (pending.isError) requests.push(pending.refetch())
      if (!unavailable && q.isError) requests.push(q.refetch())
      void Promise.allSettled(requests).finally(() => setRetrying(false))
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) || 'Unknown error'
  } catch {
    return String(error)
  }
}

export function useTriage(): TriageEntry[] {
  return useTriageState().entries
}

/**
 * Email-style triage: cards ordered needs-you → finished-unseen. Browse without
 * dismissing an item; acting on one removes it. "All" shows the stacked list.
 */
export function InboxView({
  onOpenChat,
  onOpenWork
}: {
  onOpenChat: (sessionId: string) => void
  onOpenWork: (workId: string) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const { entries, loading, error, errorDetail, unavailable, pendingError, pendingErrorDetail, retrying, retry } = useTriageState()
  // App owns the activity subscription; these observers share its live cache.
  const activity = useQuery({ queryKey: ['session-activity'], queryFn: () => window.revva.session.active(), enabled: false })
  const service = useQuery({ queryKey: ['service-status'], queryFn: () => window.revva.service.status(), enabled: false })
  // The sidebar keeps these fresh; we only read its cache for the thinking meter.
  const works = useQuery({ queryKey: ['works'], queryFn: () => window.revva.work.list(), enabled: false })
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list(), enabled: false })
  const activityReady = service.data?.state === 'connected' && !activity.isError && !!activity.data
  const thinking = useMemo<ThinkingSession[]>(() => {
    if (!activityReady) return []
    const active = new Set(activity.data ?? [])
    const sessions: ThinkingSession[] = []
    for (const w of works.data ?? []) {
      if (!w.sessionId || !active.has(w.sessionId)) continue
      if (w.state === 'ABANDONED' || w.state === 'SHIPPED') continue
      sessions.push({ kind: 'work', id: w.id, label: w.ticketKey, state: w.state })
    }
    for (const c of chats.data ?? []) {
      if (active.has(c.sessionId)) sessions.push({ kind: 'chat', id: c.sessionId, label: c.title })
    }
    return sessions
  }, [activityReady, activity.data, works.data, chats.data])
  const [focusMode, setFocusMode] = useState(true)
  const [selection, setSelection] = useState<{ key: string; index: number } | null>(null)
  const selectedIndex = selection ? entries.findIndex((entry) => entryKey(entry) === selection.key) : -1
  const index = selectedIndex >= 0 ? selectedIndex : Math.min(selection?.index ?? 0, Math.max(entries.length - 1, 0))
  const current = entries[index]

  useEffect(() => {
    if (selectedIndex < 0 || !selection || selectedIndex === selection.index) return
    setSelection({ key: selection.key, index: selectedIndex })
  }, [selectedIndex, selection])

  const select = (nextIndex: number): void => {
    const entry = entries[nextIndex]
    if (entry) setSelection({ key: entryKey(entry), index: nextIndex })
  }

  const markRead = (entry: TriageEntry): void => {
    if (entry.type !== 'finished') return
    void window.revva.triage.markRead(entry.item.source, entry.item.workId ?? entry.item.sessionID).then(() => {
      void qc.invalidateQueries({ queryKey: ['triage'] })
      void qc.invalidateQueries({ queryKey: ['chats'], refetchType: 'all' })
    })
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
        {activityReady && (
          <div className="pointer-events-none sticky top-2 z-10 flex h-0 items-start justify-end pr-1">
            <ThinkingMeter sessions={thinking} onOpenWork={onOpenWork} onOpenChat={onOpenChat} />
          </div>
        )}
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <InboxIcon className="size-5" /> Inbox
              {entries.length > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {entries.length}
                </Badge>
              )}
            </h2>
            <p className="text-xs text-muted-foreground">
              Questions, permissions, and finished runs you haven’t seen.
            </p>
          </div>
        </header>

        {(error || unavailable || pendingError || retrying) && (
          <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
            <div className="flex items-center justify-between gap-3">
              <span>
                {retrying && !pendingError && !error && !unavailable && 'Retrying inbox…'}
                {pendingError && 'Couldn’t load pending questions. '}
                {unavailable
                  ? 'Finished runs are unavailable. Restart Revva to load the latest app update.'
                  : error ? 'Couldn’t load finished runs.' : null}
              </span>
              {(pendingError || error || retrying) && (
                <Button size="sm" variant="outline" onClick={retry} disabled={retrying}>{retrying ? 'Retrying…' : 'Retry'}</Button>
              )}
            </div>
            {(errorDetail || pendingErrorDetail) && (
              <details className="mt-2">
                <summary className="cursor-pointer font-medium">Technical details</summary>
                <div className="mt-2 flex flex-col gap-2">
                  {pendingErrorDetail && <pre className="overflow-x-auto whitespace-pre-wrap break-all">Pending questions: {pendingErrorDetail}</pre>}
                  {errorDetail && <pre className="overflow-x-auto whitespace-pre-wrap break-all">Finished runs: {errorDetail}</pre>}
                  {errorDetail?.includes('No handler registered') && (
                    <p>Quit and restart Revva completely to load the current main process.</p>
                  )}
                </div>
              </details>
            )}
          </div>
        )}

        {entries.length === 0 && loading && (
          <p className="py-14 text-center text-sm text-muted-foreground">Loading inbox…</p>
        )}
        {entries.length === 0 && !loading && !error && !unavailable && !pendingError && (
          <p className="py-14 text-center text-sm text-muted-foreground">Nothing waiting on you.</p>
        )}

        {entries.length > 1 && (
          <nav aria-label="Inbox items" className="flex items-center justify-between gap-3">
            <p aria-live="polite" className="text-sm font-medium">
              {focusMode && current
                ? `${interactionLabel(current)} ${index + 1} of ${entries.length}`
                : `${entries.length} waiting`}
            </p>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={() => setFocusMode((f) => !f)}>
                    {focusMode ? <List className="size-3.5" /> : <Layers className="size-3.5" />}
                    {focusMode ? 'All' : 'Focus'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {focusMode ? 'Show every card at once' : 'One card at a time'}
                </TooltipContent>
              </Tooltip>
              {focusMode && (
                <>
                  <Button variant="outline" size="sm" disabled={index === 0} onClick={() => select(index - 1)}>
                    <ChevronLeft data-icon="inline-start" /> Previous
                  </Button>
                  <Button variant="outline" size="sm" disabled={index === entries.length - 1} onClick={() => select(index + 1)}>
                    Next <ChevronRight data-icon="inline-end" />
                  </Button>
                </>
              )}
            </div>
          </nav>
        )}
        {entries.map((entry, entryIndex) => (
          <div key={entryKey(entry)} hidden={focusMode && entryIndex !== index}>
            <TriageCard
              entry={entry}
              visible={!focusMode || entryIndex === index}
              activity={service.data?.state !== 'connected' || activity.isError ? 'Unavailable'
                : entries.some((other) => other.type === 'pending' && other.item.sessionID === entry.item.sessionID) ? 'Needs you'
                : !activity.data ? 'Checking…'
                : activity.data.includes(entry.item.sessionID) ? 'Thinking' : 'Ready'}
              onOpenChat={onOpenChat}
              onOpenWork={onOpenWork}
              onMarkRead={markRead}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function interactionLabel(entry: TriageEntry): string {
  if (entry.type === 'finished') return entry.item.source === 'chat' ? 'Message ready' : 'Work update'
  return entry.item.kind === 'form' ? 'Question' : 'Permission request'
}

/** Floating top-right card: live view of the sessions working right now. */
type ThinkingSession =
  | { kind: 'work'; id: string; label: string; state: WorkState }
  | { kind: 'chat'; id: string; label: string }

/** Same hue language as the top-bar work chips: phase reads at a glance. */
const THINKING_STATE_STYLES: Partial<Record<WorkState, string>> = {
  BUILDING: 'text-sky-700 dark:text-sky-400',
  REVIEW: 'text-violet-700 dark:text-violet-400',
  FIXING: 'text-orange-700 dark:text-orange-400',
  REWORK: 'text-pink-700 dark:text-pink-400'
}

const THINKING_LIST_LIMIT = 4

function ThinkingMeter({
  sessions,
  onOpenWork,
  onOpenChat
}: {
  sessions: ThinkingSession[]
  onOpenWork: (workId: string) => void
  onOpenChat: (sessionId: string) => void
}): React.JSX.Element {
  const active = sessions.length > 0
  const shown = sessions.slice(0, THINKING_LIST_LIMIT)
  const rest = sessions.length - shown.length
  return (
    <div className="group/meter pointer-events-auto w-60 overflow-hidden rounded-xl border bg-background/95 shadow-lg shadow-black/10 backdrop-blur-sm transition-shadow duration-200 group-hover/meter:shadow-xl group-focus-within/meter:shadow-xl dark:shadow-black/40">
      <div className="flex items-center gap-2.5 px-3 py-2" role="status">
        {active ? (
          <span aria-hidden="true" className="flex h-3.5 shrink-0 items-end gap-[3px]">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="thinking-bar h-full w-[3px] origin-bottom rounded-full bg-sky-500"
                style={{ animationDelay: `${i * 0.16}s` }}
              />
            ))}
          </span>
        ) : (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-muted-foreground/50" />
        )}
        <span className="text-[13px] font-semibold tabular-nums">
          {active ? (
            <>{sessions.length} <span className="font-medium text-muted-foreground">thinking</span></>
          ) : (
            <span className="font-medium text-muted-foreground">All quiet</span>
          )}
        </span>
      </div>
      {active && (
        <nav
          aria-label="Thinking sessions"
          className="max-h-0 overflow-hidden border-x border-b border-transparent opacity-0 transition-[max-height,opacity,border-color] duration-200 ease-out group-hover/meter:max-h-64 group-hover/meter:border-border group-hover/meter:opacity-100 group-focus-within/meter:max-h-64 group-focus-within/meter:border-border group-focus-within/meter:opacity-100 motion-reduce:transition-none"
        >
          <div className="px-1.5 py-1">
            {shown.map((s) => (
              <button
                key={`${s.kind}:${s.id}`}
                type="button"
                onClick={() => (s.kind === 'work' ? onOpenWork(s.id) : onOpenChat(s.id))}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring hover:bg-accent"
              >
                {s.kind === 'work' ? (
                  <Hammer className={cn('size-3.5 shrink-0 text-muted-foreground', s.state === 'BUILDING' && 'motion-safe:animate-pulse text-sky-500')} />
                ) : (
                  <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                {s.kind === 'work' && (
                  <span className={cn('shrink-0 text-[10px]', THINKING_STATE_STYLES[s.state] ?? 'text-muted-foreground')}>
                    {workStateLabels[s.state].toLowerCase()}
                  </span>
                )}
              </button>
            ))}
            {rest > 0 && (
              <p className="px-1.5 py-1 text-[10px] text-muted-foreground">+{rest} more</p>
            )}
          </div>
        </nav>
      )}
    </div>
  )
}

function entryKey(entry: TriageEntry): string {
  return entry.type === 'pending'
    ? `pending:${entry.item.kind}:${entry.item.id}`
    : `finished:${entry.item.source}:${entry.item.sessionID}`
}

/** One card in the feed: a pending question/permission or a finished-unseen run. */
function TriageCard({
  entry,
  visible,
  activity,
  onOpenChat,
  onOpenWork,
  onMarkRead
}: {
  entry: TriageEntry
  visible: boolean
  activity: 'Thinking' | 'Ready' | 'Needs you' | 'Checking…' | 'Unavailable'
  onOpenChat: (sessionId: string) => void
  onOpenWork: (workId: string) => void
  onMarkRead: (entry: TriageEntry) => void
}): React.JSX.Element {
  if (entry.type === 'pending') {
    return entry.item.kind === 'form' ? <FormCard item={entry.item} /> : <PermissionCard item={entry.item} />
  }
  return (
    <FinishedRunCard
      item={entry.item}
      visible={visible}
      activity={activity}
      onOpenChat={onOpenChat}
      onOpenWork={onOpenWork}
      onMarkRead={() => onMarkRead(entry)}
    />
  )
}

function FinishedRunCard({
  item,
  visible,
  activity,
  onOpenChat,
  onOpenWork,
  onMarkRead
}: {
  item: FinishedRun
  visible: boolean
  activity: 'Thinking' | 'Ready' | 'Needs you' | 'Checking…' | 'Unavailable'
  onOpenChat: (sessionId: string) => void
  onOpenWork: (workId: string) => void
  onMarkRead: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const message = useQuery({
    queryKey: ['triage-message', item.source, item.sessionID, item.updatedAt],
    queryFn: () => item.source === 'chat'
      ? window.revva.chat.messages(item.sessionID)
      : window.revva.work.messages(item.sessionID),
    enabled: visible,
    staleTime: Infinity,
    select: ({ messages }) => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message?.role === 'assistant' && message.text.trim()) return message.text
      }
      return null
    }
  })
  const reply = useMutation({
    mutationFn: (text: string) => window.revva.chat.prompt(item.sessionID, text),
    onSuccess: () => {
      setDraft('')
      onMarkRead()
    }
  })
  const open = (): void => {
    if (item.source === 'work' && item.workId) onOpenWork(item.workId)
    else onOpenChat(item.sessionID)
    onMarkRead()
  }
  return (
    <div className="rounded-lg border p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <ArrowLeftRight className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="min-w-0 truncate text-sm font-medium">
              {item.source === 'work' ? `${item.owner} finished` : item.owner}
            </span>
            <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" disabled={reply.isPending} onClick={open}>
              {item.source === 'work' ? 'Open cockpit' : 'Open chat'} <ArrowUpRight data-icon="inline-end" />
            </Button>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <FolderOpen className="size-3" />
            <span className="truncate font-mono">{item.directory}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Badge variant="secondary" className="text-[10px]">{item.source === 'chat' ? 'message ready' : 'work update'}</Badge>
          {item.source === 'chat' && (
            <Badge variant="outline" role="status" className={cn('text-[10px]', activity === 'Thinking' && 'border-sky-500/40 text-sky-700 dark:text-sky-400', activity === 'Needs you' && 'border-amber-500/40 text-amber-700 dark:text-amber-400')}>
              <span aria-hidden="true" className={cn('size-1.5 rounded-full bg-current', activity === 'Thinking' && 'motion-safe:animate-pulse')} />
              {activity === 'Thinking' ? 'Thinking…' : activity}
            </Badge>
          )}
          {item.workState && <Badge variant="outline" className="text-[10px]">{item.workState.toLowerCase()}</Badge>}
        </div>
      </div>
      {message.isLoading && <Skeleton className="mt-4 h-16 w-full" />}
      {message.isError && (
        <div role="alert" className="mt-4 flex items-center justify-between gap-2 text-xs text-destructive">
          <span>Couldn’t load the latest assistant message.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void message.refetch()}>Retry</Button>
        </div>
      )}
      {!message.isError && message.data && <FinishedMessage key={item.updatedAt} text={message.data} />}
      {message.isSuccess && !message.data && (
        <p className="mt-4 text-xs text-muted-foreground">No assistant message is available in the recent conversation.</p>
      )}
      {item.source === 'chat' && (
        <form
          className="mt-4 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (draft.trim() && !reply.isPending) reply.mutate(draft.trim())
          }}
        >
          {reply.error instanceof Error && <p role="alert" className="text-xs text-destructive">{reply.error.message}</p>}
          <div className="flex flex-col rounded-xl border border-input bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
            <Textarea
              aria-label={`Reply to ${item.owner}`}
              placeholder="Continue this conversation…"
              rows={2}
              value={draft}
              disabled={reply.isPending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              className="max-h-48 min-h-16 resize-none rounded-none border-0 bg-transparent px-4 pb-2 pt-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex flex-wrap items-center justify-end gap-1 px-2 pb-2">
              <span className="mr-auto px-1 text-xs text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
              <Button type="button" size="sm" variant="ghost" disabled={reply.isPending} onClick={onMarkRead}>
                <CheckCheck data-icon="inline-start" /> Mark read
              </Button>
              <Button type="submit" size="sm" disabled={!draft.trim() || reply.isPending}>
                <ArrowUp data-icon="inline-start" /> {reply.isPending ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </div>
        </form>
      )}
      {item.source === 'work' && (
        <div className="mt-3 flex justify-end">
          <Button type="button" size="sm" variant="ghost" onClick={onMarkRead}>
            <CheckCheck data-icon="inline-start" /> Mark read
          </Button>
        </div>
      )}
    </div>
  )
}

function FinishedMessage({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (expanded) return
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return
    const measure = (): void => setOverflowing(content.scrollHeight > container.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(content)
    return () => observer.disconnect()
  }, [expanded, text])

  return (
    <div className="mt-4 min-w-0">
      <div
        id={id}
        ref={containerRef}
        role={overflowing && !expanded ? 'region' : undefined}
        aria-label={overflowing && !expanded ? 'Message' : undefined}
        tabIndex={overflowing && !expanded ? 0 : undefined}
        className={cn('min-w-0', !expanded && 'max-h-72 overflow-y-auto')}
      >
        <div ref={contentRef} className="overflow-x-auto break-words text-sm leading-relaxed text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{text}</ReactMarkdown>
        </div>
      </div>
      {(overflowing || expanded) && (
        <Button type="button" variant="ghost" size="sm" className="mt-2" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show full message'}
        </Button>
      )}
    </div>
  )
}

export function FormCard({ item }: { item: PendingItem }): React.JSX.Element {
  const fields = useMemo(() => normalizeFields(item.fields), [item.fields])
  const [answers, setAnswers] = useState<Record<string, string | number | boolean | string[]>>(() => {
    const init: Record<string, string | number | boolean | string[]> = {}
    for (const f of fields) if (f.default !== undefined) init[f.key] = f.default as never
    return init
  })
  const reply = useMutation({
    mutationFn: () => window.revva.inbox.replyForm(item.sessionID, item.id, answers),
    onError: (e: Error) => console.error('form reply failed', e)
  })
  const ready = fields.every((f) => !f.required || answers[f.key] !== undefined)

  return (
    <div className="rounded-lg border p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-sky-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{item.title}</div>
          <OwnerLine item={item} />
          <LastMessageLine item={item} />
        </div>
        <Badge variant="secondary" className="text-[10px]">question</Badge>
      </div>

      <div className="mt-3 space-y-3">
        {fields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            value={answers[f.key]}
            onChange={(v) => setAnswers((a) => ({ ...a, [f.key]: v }))}
          />
        ))}
      </div>

      <div className="mt-4 flex justify-end">
        <Button size="sm" disabled={!ready || reply.isPending} onClick={() => reply.mutate()}>
          {reply.isPending ? 'Sending…' : 'Answer & continue'}
        </Button>
      </div>
      {reply.error instanceof Error && <p role="alert" className="mt-2 text-xs text-destructive">{reply.error.message}</p>}
    </div>
  )
}

function FieldInput({
  field,
  value,
  onChange
}: {
  field: InboxField
  value: string | number | boolean | string[] | undefined
  onChange: (v: string | number | boolean | string[]) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">
        {field.title ?? field.key}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
      </div>
      {field.description && <p className="text-[11px] text-muted-foreground">{field.description}</p>}

      {field.type === 'boolean' ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={value === true} onCheckedChange={(c) => onChange(c === true)} />
          {field.title ?? field.key}
        </label>
      ) : field.type === 'multiselect' ? (
        <div className="flex flex-wrap gap-2">
          {(field.options ?? []).map((o) => {
            const list = Array.isArray(value) ? value : []
            const on = list.includes(o.value)
            return (
              <Button
                type="button"
                key={o.value}
                size="sm"
                variant={on ? 'default' : 'outline'}
                onClick={() =>
                  onChange(on ? list.filter((x) => x !== o.value) : [...list, o.value])
                }
              >
                {o.label ?? o.value}
              </Button>
            )
          })}
        </div>
      ) : field.options && field.options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {field.options.map((o) => (
            <Button
              type="button"
              key={o.value}
              size="sm"
              variant={value === o.value ? 'default' : 'outline'}
              onClick={() => onChange(o.value)}
            >
              {o.label ?? o.value}
            </Button>
          ))}
          {(field.type === 'string' || !field.required) && (
            <Input
              placeholder="or type your own…"
              className="h-8 w-44 text-xs"
              value={typeof value === 'string' && !(field.options ?? []).some((o) => o.value === value) ? value : ''}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      ) : field.type === 'string' ? (
        <Textarea
          rows={2}
          placeholder={field.placeholder}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
          value={value === undefined ? '' : String(value)}
          onChange={(e) =>
            onChange(field.type === 'boolean' ? e.target.value === 'true' : e.target.value)
          }
        />
      )}
    </div>
  )
}

export function PermissionCard({ item }: { item: PendingItem }): React.JSX.Element {
  const reply = useMutation({
    mutationFn: (d: 'once' | 'always' | 'reject') =>
      window.revva.inbox.replyPermission(item.sessionID, item.id, d)
  })
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{item.title}</div>
          <OwnerLine item={item} />
          {item.resources && item.resources.length > 0 && (
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {item.action}: {item.resources.slice(0, 3).join(', ')}
              {item.resources.length > 3 ? ` +${item.resources.length - 3}` : ''}
            </p>
          )}
          <LastMessageLine item={item} />
        </div>
        <Badge variant="outline" className="border-amber-500/40 text-[10px]">permission</Badge>
      </div>
      <div className={cn('mt-3 flex justify-end gap-2')}>
        <Button size="sm" variant="outline" disabled={reply.isPending} onClick={() => reply.mutate('reject')}>
          Reject
        </Button>
        <Button size="sm" variant="secondary" disabled={reply.isPending} onClick={() => reply.mutate('once')}>
          Allow once
        </Button>
        <Button size="sm" disabled={reply.isPending} onClick={() => reply.mutate('always')}>
          Always allow
        </Button>
      </div>
      {reply.error instanceof Error && <p role="alert" className="mt-2 text-xs text-destructive">{reply.error.message}</p>}
    </div>
  )
}

function OwnerLine({ item }: { item: PendingItem }): React.JSX.Element {
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium">{item.owner ?? 'session'}</span>
      <Separator orientation="vertical" className="h-3" />
      <FolderOpen className="size-3" />
      <span className="truncate font-mono">{item.directory}</span>
    </div>
  )
}

/** What the agent was saying when it blocked — tail of its last message. */
function LastMessageLine({ item }: { item: PendingItem }): React.JSX.Element | null {
  if (!item.lastMessage) return null
  return (
    <p className="mt-2 line-clamp-3 border-l-2 border-muted-foreground/30 pl-2 text-[11px] italic leading-relaxed text-muted-foreground">
      {item.lastMessage}
    </p>
  )
}
