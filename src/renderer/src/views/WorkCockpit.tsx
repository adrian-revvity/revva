import { useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CircleDot, GitBranch, FolderGit2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { PushEvent, WorkSummary } from '@shared/types'
import { TranscriptView, type TranscriptDrive } from './Chat'
import { FormCard, PermissionCard, useInbox } from './InboxView'
import { ReviewPanel, ReviewRerunButton } from './ReviewPanel'
import { ShipPanel } from './ShipPanel'
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
  const allPending = useInbox()
  const pending = allPending.filter((p) => p.sessionID === sessionId)
  const qc = useQueryClient()

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
      send: (id, text) => window.revva.work.prompt(id, text),
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
      <ReviewPanel workId={work.id} />
      <ShipPanel work={work} />
      <CommentsStrip workId={work.id} />
      {pending.length > 0 && (
        <div className="max-h-64 shrink-0 space-y-2 overflow-y-auto border-b bg-amber-500/5 p-3">
          <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
            Waiting on you ({pending.length})
          </p>
          {pending.map((p) =>
            p.kind === 'form' ? <FormCard key={p.id} item={p} /> : <PermissionCard key={p.id} item={p} />
          )}
        </div>
      )}
      <TranscriptView
      sessionId={sessionId}
      drive={drive}
      emptyHint="The build session is spinning up — output appears here live."
      header={
        <>
          <span className="font-mono text-[13px] font-semibold">{work.ticketKey}</span>
          <span className="truncate text-[13px] text-muted-foreground">{work.ticketSummary}</span>
          <Badge variant="outline" className={`text-[10px] ${stateClasses[work.state] ?? ''}`}>
            <CircleDot className="mr-1 size-3" />
            {work.state}
          </Badge>
          {work.mode === 'auto' && (
            <Badge className="text-[10px]">AUTO</Badge>
          )}
          {(work.state === 'APPROVED' || work.state === 'WAITING_HUMAN') && (
            <ReviewRerunButton workId={work.id} />
          )}
          <Badge variant="outline" className="ml-auto max-w-56 truncate font-mono text-[10px] font-normal">
            <GitBranch className="mr-1 inline size-3" />
            {work.branch}
          </Badge>
          <Badge variant="outline" className="max-w-52 truncate font-mono text-[10px] font-normal">
            <FolderGit2 className="mr-1 inline size-3" />
            {work.worktreeDir.split('/').filter(Boolean).pop()}
          </Badge>
        </>
      }
    />
    </div>
  )
}
