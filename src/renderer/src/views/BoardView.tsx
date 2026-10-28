import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, MessageSquare, Play, RefreshCw, Search, Link2 } from 'lucide-react'
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
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
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
        {board.isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
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

        {visible.map((t) => {
          const active = activeByTicket.get(t.key)
          const parentsMissing = t.dependsOn.filter((d) => !board.data?.some((x) => x.key === d))
          return (
            <div key={t.key} className="rounded-lg border p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {t.key}
                      {t.url && <ExternalLink className="ml-1 inline size-3 opacity-60" />}
                    </a>
                    <Badge variant="outline" className={cn('text-[10px]', jiraStatusClasses(t.status, t.statusCategory))}>
                      {t.status}
                    </Badge>
                    {t.storyPoints !== undefined && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t.storyPoints} pts
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm leading-snug">{t.summary}</p>
                  {t.dependsOn.length > 0 && (
                    <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Link2 className="size-3" /> depends on{' '}
                      {t.dependsOn.map((d) => (
                        <Tooltip key={d}>
                          <TooltipTrigger asChild>
                            <span className="font-mono underline decoration-dotted">{d}</span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {board.data?.find((x) => x.key === d)?.summary ??
                              'Not in your open tickets — pick its branch as base manually'}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                      {parentsMissing.length > 0 && (
                        <span className="text-amber-600 dark:text-amber-500">
                          · parent not on board
                        </span>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    title="Open a plain agent session linked to this ticket (no pipeline)"
                    disabled={sessionBusy === t.key}
                    onClick={() => {
                      setSessionBusy(t.key)
                      openSession.mutate(t.key, {
                        onSettled: () => setSessionBusy(null)
                      })
                    }}
                  >
                    <MessageSquare className="size-4" />
                    Session
                  </Button>
                  {active ? (
                    <Button size="sm" onClick={() => onStart(active.id)}>
                      <Play className="size-4" />
                      {active.state === 'BUILDING' ? 'Watching…' : active.state}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setStartTicket(t)}>
                      <Play className="size-4" /> Start flow
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
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
