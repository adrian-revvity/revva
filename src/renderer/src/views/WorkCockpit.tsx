import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleDot } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { PushEvent, WorkSummary } from '@shared/types'
import { SessionIdButton, TranscriptView, type TranscriptDrive } from './Chat'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { workStateLabels } from '@/lib/work-state'
import { ReviewPanel, ReviewRerunButton } from './ReviewPanel'
import { ShipHeaderButton, ShipPanel } from './ShipPanel'
import { CommentsStrip } from './CommentsStrip'

const stateClasses: Record<string, string> = {
  BUILDING: 'bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30',
  REVIEW: 'bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30',
  FIXING: 'bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30',
  APPROVED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  WAITING_HUMAN: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  REWORK: 'bg-pink-500/15 text-pink-700 dark:text-pink-400 border-pink-500/30',
  SHIPPED: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 border-emerald-600/30',
  ABANDONED: 'text-muted-foreground'
}

/**
 * Cockpit for one ticket run: live build transcript + follow-up composer.
 * (Review fan-out and ship actions land in M4/M5 and attach to this same view.)
 */
export function WorkCockpit({ work }: { work: WorkSummary }): React.JSX.Element {
  const sessionId = work.sessionId
  const qc = useQueryClient()

  // Opening the cockpit counts as "seen": clears the inbox finished-unread card
  // and the unread flag on the work.
  useEffect(() => {
    if (!work.unread) return
    void window.revva.triage.markRead('work', work.id).then(() => {
      void qc.invalidateQueries({ queryKey: ['works'] })
    })
  }, [work.unread, work.id, qc])

  // Orca lesson: push events alone go stale (e.g. the agent commits while the window
  // is hidden). Refetch the panels' data whenever the window regains focus too.
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState !== 'visible') return
      void qc.invalidateQueries({ queryKey: ['reviews', work.id] })
      void qc.invalidateQueries({ queryKey: ['ship-checks', work.id] })
      void qc.invalidateQueries({ queryKey: ['comments'] })
      void qc.invalidateQueries({ queryKey: ['work-messages'] })
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [qc, work.id])

  // work.delta carries per-token increments; accumulate per message for the shared transcript.
  const drive = useMemo<TranscriptDrive>(() => {
    let buffer = ''
    let currentMessage = ''
    return {
      queryKey: ['work-messages'],
      load: (id) => window.revva.work.messages(id),
      send: (id, text, images, queued, refs) => window.revva.work.prompt(id, text, images, queued, refs),
      interrupt: (id) => window.revva.work.interrupt(id),
      subscribe: (_id, onDelta, onDone) =>
        window.revva.events.on((event: PushEvent) => {
          if (event.kind === 'work.delta' && event.workId === work.id) {
            if (event.messageId !== currentMessage) {
              currentMessage = event.messageId
              buffer = ''
            }
            buffer += event.text
            onDelta(buffer)
          } else if (event.kind === 'work.updated' && event.workId === work.id) {
            if (event.state !== 'BUILDING' && event.state !== 'REWORK') {
              buffer = ''
              currentMessage = ''
              onDone()
            }
          }
        })
    }
  }, [work.id])

  if (!sessionId) {
    return <div className="p-8 text-sm text-muted-foreground">This work has no session.</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReviewPanel workId={work.id} state={work.state} auto={work.mode === 'auto'} />
      <ShipPanel work={work} />
      {work.blocker && (
        <div role="alert" className="shrink-0 border-b bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {work.blocker}
        </div>
      )}
      <CommentsStrip workId={work.id} />
      <TranscriptView
      sessionId={sessionId}
      drive={drive}
      emptyHint="The build session is spinning up — output appears here live."
      hideSessionDetails
      header={
        <>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={work.ticketSummary}>{work.ticketSummary}</span>
          <Badge variant="outline" className={`text-[10px] ${stateClasses[work.state] ?? ''}`}>
            <CircleDot className="mr-1 size-3" />
            {workStateLabels[work.state]}
          </Badge>
          {work.mode === 'auto' && (
            <Badge className="text-[10px]">AUTO</Badge>
          )}
          {(work.state === 'APPROVED' || work.state === 'WAITING_HUMAN') && (
            <ReviewRerunButton workId={work.id} />
          )}
          <ShipHeaderButton work={work} />
        </>
      }
    />
    </div>
  )
}

export function WorkDetailsPopover({ work }: { work: WorkSummary }): React.JSX.Element {
  const model = useQuery({
    queryKey: ['session-model', work.sessionId],
    queryFn: () => window.revva.session.model(work.sessionId!),
    enabled: !!work.sessionId,
    refetchInterval: 10_000
  })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models() })
  const fullModel = model.data
    ? `${model.data.providerID}/${model.data.id}${model.data.variant ? ` · ${model.data.variant}` : ''}`
    : model.isError ? 'Unavailable' : model.isPending && work.sessionId ? 'Loading…' : 'Service default'
  const shortModel = model.data
    ? models.data?.find((item) => item.providerID === model.data?.providerID && item.id === model.data?.id)?.name || model.data.id
    : fullModel

  return (
    <Popover key={work.id}>
      <PopoverTrigger className="no-drag shrink-0 rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        Details
      </PopoverTrigger>
      <PopoverContent align="end" className="gap-3 p-3">
        <PopoverTitle>Conversation details</PopoverTitle>
        <dl className="flex flex-col gap-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="break-all font-mono">{work.branch}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Worktree</dt>
            <dd className="break-all font-mono">{work.worktreeDir}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Model</dt>
            <dd title={fullModel}>{shortModel}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Session</dt>
            <dd>{work.sessionId ? <SessionIdButton key={work.sessionId} sessionId={work.sessionId} /> : 'Unavailable'}</dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  )
}
