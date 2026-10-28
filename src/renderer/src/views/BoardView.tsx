import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Play, RefreshCw, Link2, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Ticket, WorkSummary } from '@shared/types'
import { StartWorkDialog } from './StartWorkDialog'

/**
 * Board: current-sprint assigned tickets with dependency hints.
 * Start Work opens a worktree + build session (per-run repo/mode/agent/model).
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
        <div className="flex items-center justify-between">
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

        {board.isError && (
          <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {board.error.message}
          </p>
        )}
        {board.isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
        {board.data?.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No open tickets assigned to you.
          </p>
        )}

        {board.data?.map((t) => {
          const active = activeByTicket.get(t.key)
          const parentsMissing = t.dependsOn.filter(
            (d) => !board.data.some((x) => x.key === d)
          )
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
                    <Badge variant="outline" className="text-[10px]">
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
                            {board.data.find((x) => x.key === d)?.summary ??
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
                <div className="shrink-0">
                  {active ? (
                    <Button size="sm" variant="outline" onClick={() => onStart(active.id)}>
                      <MessageSquare className="size-4" />
                      {active.state === 'BUILDING' ? 'Watching…' : active.state}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setStartTicket(t)}>
                      <Play className="size-4" /> Start work
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
