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
  ArrowLeftRight
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
import { MD_COMPONENTS } from '@/components/message-markdown'
import type { FinishedRun, InboxField, PendingItem, TriageEntry } from '@shared/types'

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
          {entries.length > 1 && (
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
          )}
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

        {focusMode && current && (
          <nav aria-label="Inbox items" className="flex items-center justify-between gap-3">
            <p aria-live="polite" className="text-sm font-medium">
              {interactionLabel(current)} {index + 1} of {entries.length}
            </p>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={index === 0} onClick={() => select(index - 1)}>
                <ChevronLeft data-icon="inline-start" /> Previous
              </Button>
              <Button variant="outline" size="sm" disabled={index === entries.length - 1} onClick={() => select(index + 1)}>
                Next <ChevronRight data-icon="inline-end" />
              </Button>
            </div>
          </nav>
        )}
        {entries.map((entry, entryIndex) => (
          <div key={entryKey(entry)} hidden={focusMode && entryIndex !== index}>
            <TriageCard entry={entry} onOpenChat={onOpenChat} onOpenWork={onOpenWork} onMarkRead={markRead} />
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

function entryKey(entry: TriageEntry): string {
  return entry.type === 'pending'
    ? `pending:${entry.item.kind}:${entry.item.id}`
    : `finished:${entry.item.source}:${entry.item.sessionID}`
}

/** One card in the feed: a pending question/permission or a finished-unseen run. */
function TriageCard({
  entry,
  onOpenChat,
  onOpenWork,
  onMarkRead
}: {
  entry: TriageEntry
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
      onOpenChat={onOpenChat}
      onOpenWork={onOpenWork}
      onMarkRead={() => onMarkRead(entry)}
    />
  )
}

function FinishedRunCard({
  item,
  onOpenChat,
  onOpenWork,
  onMarkRead
}: {
  item: FinishedRun
  onOpenChat: (sessionId: string) => void
  onOpenWork: (workId: string) => void
  onMarkRead: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
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
          {item.workState && <Badge variant="outline" className="text-[10px]">{item.workState.toLowerCase()}</Badge>}
        </div>
      </div>
      {item.preview && <FinishedMessage text={item.preview} />}
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
