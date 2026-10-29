import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  Clock4,
  CornerUpLeft,
  ExternalLink,
  MessageSquare,
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
import { jiraStatusClasses } from '@/lib/status-colors'
import type { Ticket, WorkSummary } from '@shared/types'
import { StartWorkDialog } from './StartWorkDialog'

const ALL_STATUSES = '__all__'

/**
 * Board: current-sprint assigned tickets with dependency hints, status filter,
 * and search. Two entry points per ticket: the full pipeline (Start flow) or a
 * plain agent session linked to the ticket.
 */
export function BoardView({
  works,
  onStart
}: {
  works: WorkSummary[]
  onStart: (workId: string) => void
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chats'] })
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
              <Skeleton key={i} className="h-28" />
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
          />
        )}
      </div>

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
  onStartWork
}: {
  visible: Ticket[]
  boardData: Ticket[]
  activeByTicket: Map<string, WorkSummary>
  sessionBusy: string | null
  onSession: (key: string) => void
  onStartTicket: (t: Ticket) => void
  onStartWork: (workId: string) => void
}): React.JSX.Element {
  const liveIds = useMemo(() => visible.map((t) => t.key), [visible])
  const { zones, commit } = useCardOrder('jira', liveIds)
  const [laterOpen, setLaterOpen] = useState(false)
  const byKey = useMemo(() => new Map(visible.map((t) => [t.key, t])), [visible])

  const renderCard = (key: string): React.ReactNode => {
    const t = byKey.get(key)
    if (!t) return null
    const zone = zones.important.includes(key) ? 'important' : zones.later.includes(key) ? 'later' : 'main'
    return (
      <TicketCard
        t={t}
        boardData={boardData}
        active={activeByTicket.get(t.key)}
        sessionBusy={sessionBusy === t.key}
        zone={zone}
        onSession={() => onSession(t.key)}
        onStartTicket={() => onStartTicket(t)}
        onStartWork={onStartWork}
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
  onSession,
  onStartTicket,
  onStartWork,
  onMove
}: {
  t: Ticket
  boardData: Ticket[]
  active: WorkSummary | undefined
  sessionBusy: boolean
  zone: 'important' | 'main' | 'later'
  onSession: () => void
  onStartTicket: () => void
  onStartWork: (workId: string) => void
  onMove: (to: 'important' | 'main' | 'later') => void
}): React.JSX.Element {
  const parentsMissing = t.dependsOn.filter((d) => !boardData.some((x) => x.key === d))
  return (
    <div
      className={cn(
        'flex h-full flex-col gap-1.5 rounded-lg border p-2.5 pt-2 transition-colors',
        zone === 'important' && 'border-amber-500/40 bg-amber-500/[0.04]'
      )}
    >
      <div className="flex items-center gap-1.5 pr-5">
        <a
          href={t.url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] font-medium hover:underline"
        >
          {t.key}
          {t.url && <ExternalLink className="ml-1 inline size-2.5 opacity-60" />}
        </a>
        <Badge variant="outline" className={cn('shrink-0 text-[9px]', jiraStatusClasses(t.status, t.statusCategory))}>
          {t.status}
        </Badge>
        {t.storyPoints !== undefined && (
          <Badge variant="secondary" className="shrink-0 px-1 text-[9px]">
            {t.storyPoints}p
          </Badge>
        )}
      </div>
      <p className="line-clamp-2 min-w-0 text-[13px] leading-snug">{t.summary}</p>
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
      <div className="mt-auto flex items-center gap-1 pt-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
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
              className="text-muted-foreground"
              title={zone === 'later' ? 'Back to the list' : 'Not right now'}
              onClick={() => onMove(zone === 'later' ? 'main' : 'later')}
            >
              {zone === 'later' ? <CornerUpLeft className="size-3.5" /> : <Clock4 className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{zone === 'later' ? 'Back to the list' : 'Not right now'}</TooltipContent>
        </Tooltip>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            title="Open a plain agent session linked to this ticket (no pipeline)"
            disabled={sessionBusy}
            onClick={onSession}
          >
            <MessageSquare className="size-3.5" />
          </Button>
          {active ? (
            <Button size="xs" onClick={() => onStartWork(active.id)}>
              <Play className="size-3.5" />
              {active.state === 'BUILDING' ? 'Watching…' : active.state}
            </Button>
          ) : (
            <Button size="xs" onClick={onStartTicket}>
              <Play className="size-3.5" /> Start
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
