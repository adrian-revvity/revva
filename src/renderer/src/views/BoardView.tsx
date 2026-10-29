import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  Clock4,
  CornerDownRight,
  CornerUpLeft,
  ExternalLink,
  ListChecks,
  Loader2,
  MessageSquareText,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Search,
  Link2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CardBoard, CardZone, moveToZone } from '@/components/CardBoard'
import { useCardOrder } from '@/lib/use-card-order'
import { cn } from '@/lib/utils'
import { jiraStatusClasses, jiraTypeClasses } from '@/lib/status-colors'
import type { Ticket, WorkSummary } from '@shared/types'
import { StartWorkDialog } from './StartWorkDialog'

const ALL_STATUSES = '__all__'

/**
 * Board: current-sprint assigned tickets with dependency hints, status filter,
 * and search. Two entry points per ticket: the full pipeline (Start flow) or a
 * chat opened with the ticket in context.
 */
export function BoardView({
  works,
  onStart,
  onOpenChat
}: {
  works: WorkSummary[]
  onStart: (workId: string) => void
  onOpenChat: (sessionId: string) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const jira = useQuery({ queryKey: ['jira-status'], queryFn: () => window.revva.jira.status() })
  const board = useQuery({
    queryKey: ['board'],
    queryFn: () => window.revva.jira.board(),
    enabled: !!jira.data?.connected,
    staleTime: 30_000
  })
  const [startTicket, setStartTicket] = useState<Ticket | null>(null)
  const [detailsTicket, setDetailsTicket] = useState<Ticket | null>(null)
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES)
  const [search, setSearch] = useState('')
  const [sessionBusy, setSessionBusy] = useState<string | null>(null)

  const tickets = board.data ?? []
  const statuses = useMemo(
    () => [...new Set(tickets.map((t) => t.status))].sort((a, b) => a.localeCompare(b)),
    [tickets]
  )
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tickets.filter(
      (t) =>
        (statusFilter === ALL_STATUSES || t.status === statusFilter) &&
        (!q || t.key.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q))
    )
  }, [tickets, statusFilter, search])

  const openSession = useMutation({
    mutationFn: (key: string) => window.revva.task.ticketSession({ ticketKey: key }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['chats'] })
      onOpenChat(res.sessionId)
    }
  })

  const activeByTicket = new Map(
    works
      .filter((w) => w.state !== 'ABANDONED' && w.state !== 'SHIPPED')
      .map((w) => [w.ticketKey, w])
  )

  if (!jira.data) return <Skeleton className="m-6 h-24" />

  if (!jira.data.connected) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16 text-center">
        <h2 className="text-lg font-semibold">Connect Jira to see your sprint</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Revva signs in to Atlassian with its own OAuth connection (read/write Jira work). Nothing
          is shared with other apps' tokens.
        </p>
        <Button
          className="mt-5"
          onClick={() =>
            window.revva.jira
              .connect()
              .then(() => qc.invalidateQueries({ queryKey: ['jira-status'] }))
              .catch((e: Error) => alert(e.message))
          }
        >
          Connect Jira
        </Button>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1600px] space-y-4 px-6 py-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Sprint board</h2>
            <p className="text-xs text-muted-foreground">
              Open tickets assigned to you · openSprints() JQL
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={board.isFetching}
            onClick={() => board.refetch()}
          >
            <RefreshCw className={cn('size-4', board.isFetching && 'animate-spin')} /> Refresh
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search key or summary…"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? ALL_STATUSES)}>
            <SelectTrigger size="sm" className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
              {statuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {board.isError && (
          <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {board.error.message}
          </p>
        )}
        {openSession.error instanceof Error && (
          <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {openSession.error.message} (a workspace folder or prior work on this repo helps revva pick the directory)
          </p>
        )}
        {board.isLoading && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        )}
        {board.data?.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No open tickets assigned to you.
          </p>
        )}
        {board.data && board.data.length > 0 && visible.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No tickets match the filter ({tickets.length} hidden).
          </p>
        )}

        {visible.length > 0 && (
          <TicketBoard
            visible={visible}
            boardData={board.data ?? []}
            activeByTicket={activeByTicket}
            sessionBusy={sessionBusy}
            onSession={(key) => {
              setSessionBusy(key)
              openSession.mutate(key, { onSettled: () => setSessionBusy(null) })
            }}
            onStartTicket={setStartTicket}
            onStartWork={onStart}
            onDetails={setDetailsTicket}
          />
        )}
      </div>

      {detailsTicket && (
        <TicketSubtasksDialog
          ticket={detailsTicket}
          activeByTicket={activeByTicket}
          onClose={() => setDetailsTicket(null)}
          onStartSubtask={(sub) => {
            setDetailsTicket(null)
            setStartTicket(sub)
          }}
          onStartWork={(workId) => {
            setDetailsTicket(null)
            onStart(workId)
          }}
        />
      )}

      {startTicket && (
        <StartWorkDialog
          ticket={startTicket}
          works={works}
          onClose={() => setStartTicket(null)}
          onStarted={(work) => {
            setStartTicket(null)
            qc.invalidateQueries({ queryKey: ['works'] })
            onStart(work.id)
          }}
        />
      )}
    </div>
  )
}

/**
 * Three drag-and-drop zones: Important (pinned), the sprint list, and a
 * collapsible "Not right now" shelf. Dropping a card into a zone pins/parks
 * it; the grip or a double-click-free drag is the only gesture needed.
 */
function TicketBoard({
  visible,
  boardData,
  activeByTicket,
  sessionBusy,
  onSession,
  onStartTicket,
  onStartWork,
  onDetails
}: {
  visible: Ticket[]
  boardData: Ticket[]
  activeByTicket: Map<string, WorkSummary>
  sessionBusy: string | null
  onSession: (key: string) => void
  onStartTicket: (t: Ticket) => void
  onStartWork: (workId: string) => void
  onDetails: (t: Ticket) => void
}): React.JSX.Element {
  const liveIds = useMemo(() => visible.map((t) => t.key), [visible])
  const { zones, commit } = useCardOrder('jira', liveIds)
  const [laterOpen, setLaterOpen] = useState(false)
  const byKey = useMemo(() => new Map(visible.map((t) => [t.key, t])), [visible])
  /**
   * Parent ↔ sub-task chain per ticket, keyed on the chain's root (the parent
   * card's own key), so the parent and its sub-tasks light up together on hover
   * — the same trick as the PR board's stack chains. Chains walk up through
   * parents that are themselves visible (custom hierarchies); a member filtered
   * out of the visible set just isn't part of the chain.
   */
  const chains = useMemo(() => {
    const rootOf = (t: Ticket): string => {
      let key = t.parentKey ?? t.key
      const seen = new Set([t.key])
      while (!seen.has(key)) {
        seen.add(key)
        const next = byKey.get(key)?.parentKey
        if (!next) break
        key = next
      }
      return key
    }
    const keys = new Map<string, string>()
    for (const t of visible) keys.set(t.key, rootOf(t))
    const size = new Map<string, number>()
    for (const k of keys.values()) size.set(k, (size.get(k) ?? 0) + 1)
    return { keys, size }
  }, [visible, byKey])
  const [hoveredChain, setHoveredChain] = useState<string | null>(null)
  /** Parent-badge click: scroll to that card and pulse it (like the PR alert jump). */
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const jumpToCard = (key: string): void => {
    if (zones.later.includes(key)) setLaterOpen(true)
    const scroll = (tries: number): void => {
      const el = document.querySelector(`[data-ticket-key="${CSS.escape(key)}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Filters and zone moves re-render first — retry while the list settles.
      else if (tries > 0) setTimeout(() => scroll(tries - 1), 350)
    }
    requestAnimationFrame(() => scroll(6))
    clearTimeout(flashTimer.current)
    setFlashKey(key)
    flashTimer.current = setTimeout(() => setFlashKey(null), 2200)
  }

  const renderCard = (key: string): React.ReactNode => {
    const t = byKey.get(key)
    if (!t) return null
    const zone = zones.important.includes(key) ? 'important' : zones.later.includes(key) ? 'later' : 'main'
    const chain = chains.keys.get(key)
    return (
      <TicketCard
        t={t}
        boardData={boardData}
        active={activeByTicket.get(t.key)}
        sessionBusy={sessionBusy === t.key}
        zone={zone}
        chainKey={chain}
        chainHighlighted={!!chain && (chains.size.get(chain) ?? 0) > 1 && hoveredChain === chain}
        onChainHover={setHoveredChain}
        flash={flashKey === key}
        onJumpToParent={
          t.parentKey && byKey.has(t.parentKey) && t.parentKey !== t.key
            ? () => jumpToCard(t.parentKey!)
            : undefined
        }
        onSession={() => onSession(t.key)}
        onStartTicket={() => onStartTicket(t)}
        onStartWork={onStartWork}
        onDetails={() => onDetails(t)}
        onMove={(to) => commit(moveToZone(zones, t.key, to))}
      />
    )
  }

  return (
    <CardBoard zones={zones} onReorder={commit} renderCard={renderCard}>
      {zones.important.length > 0 && (
        <section aria-label="Important tickets" className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-600 dark:text-amber-400">
            <Pin className="size-3.5" /> Important
          </h3>
          <CardZone id="important" />
        </section>
      )}

      <CardZone
        id="main"
        emptyHint={
          zones.later.length > 0 || zones.important.length > 0
            ? 'Nothing here — drag a card back, or un-park it below.'
            : undefined
        }
      />

      <section aria-label="Not right now" className="pt-1">
        <button
          type="button"
          onClick={() => setLaterOpen((v) => !v)}
          aria-expanded={laterOpen}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', !laterOpen && '-rotate-90')} />
          Not right now
          <Badge variant="secondary" className="text-[10px]">
            {zones.later.length}
          </Badge>
          <span className="ml-auto text-[11px] font-normal text-muted-foreground/70">
            {laterOpen ? 'Collapse' : 'Expand'}
          </span>
        </button>
        <CardZone
          id="later"
          collapsed={!laterOpen}
          emptyHint="Drop tickets here to get them out of the way."
          collapsedContent={
            <div className="col-span-full flex h-7 items-center justify-center rounded border border-dashed border-border/60 text-[10px] text-muted-foreground/60">
              {zones.later.length ? `${zones.later.length} parked — drop here to add` : 'Drop tickets here to park them'}
            </div>
          }
        />
      </section>
    </CardBoard>
  )
}

/** Compact ticket card: min-width grid cell, three-zone friendly. */
function TicketCard({
  t,
  boardData,
  active,
  sessionBusy,
  zone,
  chainKey,
  chainHighlighted,
  onChainHover,
  flash,
  onJumpToParent,
  onSession,
  onStartTicket,
  onStartWork,
  onDetails,
  onMove
}: {
  t: Ticket
  boardData: Ticket[]
  /** Parent/sub-task chain identity (the chain root's key); own key when unrelated. */
  chainKey?: string
  /** Another card of the same chain is hovered — light this one up. */
  chainHighlighted: boolean
  onChainHover: (chain: string | null) => void
  /** A chain jump landed on this card — pulse it. */
  flash: boolean
  /** Jump to the parent card; absent when the parent is not on the board. */
  onJumpToParent?: () => void
  active: WorkSummary | undefined
  sessionBusy: boolean
  zone: 'important' | 'main' | 'later'
  onSession: () => void
  onStartTicket: () => void
  onStartWork: (workId: string) => void
  onDetails: () => void
  onMove: (to: 'important' | 'main' | 'later') => void
}): React.JSX.Element {
  const parentsMissing = t.dependsOn.filter((d) => !boardData.some((x) => x.key === d))
  const parentSummary = t.parentKey ? boardData.find((x) => x.key === t.parentKey)?.summary : undefined
  return (
    <div
      data-ticket-key={t.key}
      className={cn('relative flex h-full flex-col transition-shadow', (chainHighlighted || flash) && 'z-10')}
      onMouseEnter={() => onChainHover(chainKey ?? null)}
      onMouseLeave={() => onChainHover(null)}
    >
    <div
      className={cn(
        'relative flex min-h-0 flex-1 flex-col gap-1.5 rounded-lg border bg-card p-2.5 transition-colors',
        zone === 'important' && 'border-amber-500/40 bg-amber-500/[0.04]',
        zone === 'later' && 'opacity-80',
        chainHighlighted && 'border-violet-500/50 ring-1 ring-violet-500/30',
        flash && 'border-amber-500/70 ring-2 ring-amber-500/40 animate-pulse'
      )}
    >
      <div className="min-w-0 pr-5">
        <button
          type="button"
          title="Ticket details"
          onClick={onDetails}
          className="line-clamp-2 text-left text-[13px] font-medium leading-snug hover:underline"
        >
          {t.summary}
        </button>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
          {t.key}
          {t.storyPoints !== undefined ? ` · ${t.storyPoints} points` : ''}
        </p>
      </div>

      <div className="flex min-h-4 flex-wrap items-center gap-1">
        <Badge variant="outline" className={cn('shrink-0 text-[9px]', jiraStatusClasses(t.status, t.statusCategory))}>
          {t.status}
        </Badge>
        {t.issueTypeName && (
          <Badge variant="outline" className={cn('shrink-0 text-[9px]', jiraTypeClasses(t.issueTypeName))}>
            {t.issueTypeName}
          </Badge>
        )}
        {(t.subtaskCount ?? 0) > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="shrink-0" onClick={onDetails}>
                <Badge
                  variant="secondary"
                  className="cursor-pointer gap-0.5 border-transparent text-[9px] text-muted-foreground hover:bg-muted"
                >
                  <ListChecks className="size-2.5" />
                  {t.subtaskCount} sub-task{t.subtaskCount === 1 ? '' : 's'}
                </Badge>
              </button>
            </TooltipTrigger>
            <TooltipContent>Sub-tasks with a Start button on each</TooltipContent>
          </Tooltip>
        )}
        {t.parentKey && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="shrink-0 disabled:cursor-default"
                disabled={!onJumpToParent}
                onClick={onJumpToParent}
              >
                <Badge
                  variant="outline"
                  className={cn(
                    'shrink-0 gap-0.5 border-violet-500/40 text-[9px] text-violet-600 dark:text-violet-400',
                    onJumpToParent && 'cursor-pointer hover:bg-violet-500/10'
                  )}
                >
                  <CornerDownRight className="size-2.5" />
                  <span className="max-w-28 truncate">on {t.parentKey}</span>
                </Badge>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {onJumpToParent
                ? `Child of ${t.parentKey}${parentSummary ? ` — ${parentSummary}` : ''} · click to jump to it`
                : `Child of ${t.parentKey} — not in your open tickets`}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {t.dependsOn.length > 0 && (
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Link2 className="size-2.5 shrink-0" /> depends on{' '}
          {t.dependsOn.map((d) => (
            <Tooltip key={d}>
              <TooltipTrigger asChild>
                <span className="font-mono underline decoration-dotted">{d}</span>
              </TooltipTrigger>
              <TooltipContent>
                {boardData.find((x) => x.key === d)?.summary ??
                  'Not in your open tickets — pick its branch as base manually'}
              </TooltipContent>
            </Tooltip>
          ))}
          {parentsMissing.length > 0 && (
            <span className="text-amber-600 dark:text-amber-500">· parent not on board</span>
          )}
        </p>
      )}

      <div className="mt-auto space-y-1.5 border-t pt-1.5">
        <Button
          size="sm"
          variant={active ? 'default' : 'outline'}
          className={cn('h-7 w-full gap-1.5 text-xs', !active && 'border-primary/40 hover:border-primary/70')}
          onClick={active ? () => onStartWork(active.id) : onStartTicket}
        >
          <Play className="size-3.5" />
          {active ? (active.state === 'BUILDING' ? 'Watching…' : active.state) : 'Start'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-full gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          disabled={sessionBusy}
          onClick={onSession}
        >
          {sessionBusy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <MessageSquareText className="size-3.5" />
          )}
          {sessionBusy ? 'Opening chat…' : 'Chat with this ticket'}
        </Button>
        <div className="flex flex-wrap items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                className="h-6 px-1.5 text-muted-foreground"
                title={zone === 'important' ? 'Unpin' : 'Pin to Important'}
                onClick={() => onMove(zone === 'important' ? 'main' : 'important')}
              >
                {zone === 'important' ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{zone === 'important' ? 'Unpin' : 'Pin to Important'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                className="h-6 px-1.5 text-muted-foreground"
                title={zone === 'later' ? 'Back to the list' : 'Not right now'}
                onClick={() => onMove(zone === 'later' ? 'main' : 'later')}
              >
                {zone === 'later' ? <CornerUpLeft className="size-3.5" /> : <Clock4 className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{zone === 'later' ? 'Back to the list' : 'Not right now'}</TooltipContent>
          </Tooltip>
          {t.url && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="ml-auto"
                  title="Open on Jira"
                  onClick={() => void window.revva.shell.openExternal(t.url!)}
                >
                  <ExternalLink className="size-3" />
                  <span className="sr-only">Open on Jira</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open on Jira</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
    </div>
  )
}

/**
 * Ticket details: the parent card opened from the board, listing its sub-tasks
 * with a Start button on each — starting a sub-task opens the same Start flow
 * as starting the ticket itself, scoped to that sub-task.
 */
function TicketSubtasksDialog({
  ticket,
  activeByTicket,
  onClose,
  onStartSubtask,
  onStartWork
}: {
  ticket: Ticket
  activeByTicket: Map<string, WorkSummary>
  onClose: () => void
  onStartSubtask: (sub: Ticket) => void
  onStartWork: (workId: string) => void
}): React.JSX.Element {
  const subtasks = useQuery({
    queryKey: ['subtasks', ticket.key],
    queryFn: () => window.revva.jira.subtasks(ticket.key),
    // Every deliberate open refetches: sub-task status changes server-side, and
    // a cached (possibly empty) answer must not shadow the truth.
    staleTime: 0
  })
  // Open work first, done at the bottom — a long list opens with what you can start.
  const items = useMemo(() => {
    const list = subtasks.data ?? []
    const isDone = (t: Ticket): boolean => t.statusCategory.toLowerCase() === 'done'
    return [...list.filter((t) => !isDone(t)), ...list.filter(isDone)]
  }, [subtasks.data])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Wide (sub-task summaries are long) and flex-column: header pinned, only the list scrolls. */}
      <DialogContent className="flex max-h-[calc(100vh-4rem)] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle className="flex items-center gap-2">
            <a
              href={ticket.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono hover:underline"
            >
              {ticket.key}
            </a>
            {ticket.issueTypeName && (
              <Badge variant="outline" className={cn('text-[10px]', jiraTypeClasses(ticket.issueTypeName))}>
                {ticket.issueTypeName}
              </Badge>
            )}
            <Badge variant="outline" className={cn('text-[10px]', jiraStatusClasses(ticket.status, ticket.statusCategory))}>
              {ticket.status}
            </Badge>
          </DialogTitle>
          <DialogDescription>{ticket.summary}</DialogDescription>
        </DialogHeader>

        <h3 className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <ListChecks className="size-3.5" /> Sub-tasks
          {subtasks.data && (
            <Badge variant="secondary" className="text-[10px]">
              {items.length}
            </Badge>
          )}
        </h3>
        <div className="-mx-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-1">
          {subtasks.isLoading && (
            <div className="space-y-1.5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          )}
          {subtasks.isError && (
            <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
              {subtasks.error.message}
            </p>
          )}
          {subtasks.data && items.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
              This ticket has no sub-tasks.
            </p>
          )}
          {items.map((sub) => {
            const active = activeByTicket.get(sub.key)
            const done = sub.statusCategory.toLowerCase() === 'done'
            return (
              <div
                key={sub.key}
                className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
              >
                <a
                  href={sub.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 font-mono text-[11px] font-medium hover:underline"
                >
                  {sub.key}
                </a>
                <Badge variant="outline" className={cn('shrink-0 text-[9px]', jiraStatusClasses(sub.status, sub.statusCategory))}>
                  {sub.status}
                </Badge>
                {sub.issueTypeName && (
                  <Badge variant="outline" className={cn('shrink-0 text-[9px]', jiraTypeClasses(sub.issueTypeName))}>
                    {sub.issueTypeName}
                  </Badge>
                )}
                <p
                  title={sub.summary}
                  className={cn('min-w-0 flex-1 truncate text-[12px]', done && 'text-muted-foreground line-through')}
                >
                  {sub.summary}
                </p>
                {active ? (
                  <Button size="xs" className="shrink-0" onClick={() => onStartWork(active.id)}>
                    <Play className="size-3.5" />
                    {active.state === 'BUILDING' ? 'Watching…' : active.state}
                  </Button>
                ) : (
                  <Button size="xs" className="shrink-0" disabled={done} title={done ? 'Already done' : undefined} onClick={() => onStartSubtask(sub)}>
                    <Play className="size-3.5" /> Start
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
