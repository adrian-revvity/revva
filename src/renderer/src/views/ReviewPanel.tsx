import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, CirclePause, Loader2, ScanEye, ShieldQuestion, Sparkles, Wrench, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { SessionIdButton, TranscriptView, type TranscriptDrive } from './Chat'
import type { PipelineRole, PushEvent, ReviewRow, WorkState } from '@shared/types'

const roleMeta: Partial<Record<PipelineRole, { label: string; icon: React.JSX.Element }>> = {
  sol: { label: 'Sol-loop', icon: <ScanEye className="size-3.5" /> },
  testAudit: { label: 'Test audit', icon: <ShieldQuestion className="size-3.5" /> },
  impeccable: { label: 'UI review', icon: <Sparkles className="size-3.5" /> },
  fixer: { label: 'Fixer', icon: <Wrench className="size-3.5" /> }
}

const statusMeta: Record<string, { cls: string; text: string }> = {
  pending: { cls: 'text-muted-foreground', text: 'queued' },
  running: { cls: 'text-sky-600 dark:text-sky-400', text: 'reviewing…' },
  approved: { cls: 'text-emerald-600 dark:text-emerald-400', text: 'approved' },
  changes: { cls: 'text-amber-600 dark:text-amber-400', text: 'changes requested' },
  error: { cls: 'text-destructive', text: 'error' },
  skipped: { cls: 'text-muted-foreground', text: 'skipped' }
}

/** A deliberate stop is not a provider failure, even though it blocks approval. */
export function isReviewStopped(row: ReviewRow): boolean {
  return row.status === 'error' && /stopped by you|was interrupted|^cancelled$/i.test(row.error ?? '')
}

/**
 * Review ledger strip under the cockpit header: one card per reviewer of the latest round
 * (fixer when one is running), expandable to its live transcript. Reviewers run concurrently.
 */
export function ReviewPanel({ workId, state, auto }: { workId: string; state: WorkState; auto: boolean }): React.JSX.Element | null {
  const qc = useQueryClient()
  const reviews = useQuery({ queryKey: ['reviews', workId], queryFn: () => window.revva.work.reviews(workId) })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models() })
  const [open, setOpen] = useState<number | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)

  useEffect(() => {
    return window.revva.events.on((e: PushEvent) => {
      if (e.kind === 'review.updated' && e.workId === workId) qc.setQueryData(['reviews', workId], e.reviews)
    })
  }, [qc, workId])

  const rows = reviews.data ?? []
  const round = rows.reduce((m, r) => (r.role === 'fixer' ? m : Math.max(m, r.round)), 0)
  const current = [...new Map(rows.filter((r) => r.round === round).map((r) => [r.role, r])).values()]
  const fixer = rows.filter((r) => r.role === 'fixer' && r.round === round - 1).at(-1)
  const visible = fixer && current.every((r) => r.status === 'pending') ? [fixer, ...current] : current
  if (round === 0 && !fixer) return (
    <div className="flex flex-col gap-4 text-sm">
      <dl className="divide-y">
        {(['sol', 'testAudit', 'impeccable', 'fixer'] as const).map((role) => (
          <div key={role} className="flex items-center justify-between gap-3 py-3">
            <dt className="flex items-center gap-2">{roleMeta[role]?.icon}{roleMeta[role]?.label}</dt>
            <dd className="text-muted-foreground">Not started</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground">Reviews wait for completed implementation. UI review runs only for UI changes; the fixer runs only when changes are requested.</p>
    </div>
  )

  const selected = visible.find((r) => r.id === open)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {state === 'BUILDING' ? 'Previous review' : 'Review'} · round {round || '—'}
        </span>
        {(state === 'REVIEW' || state === 'FIXING' || state === 'WAITING_HUMAN') && (
          <Button
            size="sm"
            variant="outline"
            disabled={stopping}
            title="Interrupt this ticket’s reviewers and fixer, including sessions left running after a restart. Keep all files and transcripts."
            onClick={async () => {
              setStopping(true)
              setStopError(null)
              try {
                await window.revva.work.reviewStop(workId)
              } catch (err) {
                setStopError(err instanceof Error ? err.message : String(err))
              } finally {
                setStopping(false)
                void qc.invalidateQueries({ queryKey: ['reviews', workId] })
                void qc.invalidateQueries({ queryKey: ['works'] })
              }
            }}
          >
            {stopping ? 'Stopping review…' : 'Stop review'}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {visible.map((r) => (
          <ReviewChip key={r.id} row={r}
            modelName={models.data?.find((m) => m.providerID === r.model?.providerID && m.id === r.model?.id)?.name}
            active={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} />
        ))}
      </div>
      {stopError && <p role="alert" className="text-xs text-destructive">{stopError}</p>}
      {state === 'WAITING_HUMAN' && !selected && (
        <p className="text-sm text-muted-foreground">Select an agent for its findings, transcript and retry action.</p>
      )}
      {selected && (
        <ReviewDetail
          key={selected.id}
          row={selected}
          state={state}
          auto={auto}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

function ReviewChip({
  row,
  modelName,
  active,
  onClick
}: {
  row: ReviewRow
  modelName?: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const meta = roleMeta[row.role] ?? { label: row.role, icon: <ScanEye className="size-3.5" /> }
  const stopped = isReviewStopped(row)
  const st: { cls: string; text: string } = stopped ? { cls: 'text-muted-foreground', text: 'stopped' } : statusMeta[row.status] ?? { cls: 'text-muted-foreground', text: row.status }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-expanded={active}
          className={cn(
            'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring',
            active && 'bg-accent'
          )}
        >
          {meta.icon}
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{meta.label}</span>
            {(row.agentID || row.model) && <span className="block truncate text-xs text-muted-foreground">{[row.agentID, row.model ? modelName || row.model.id : undefined].filter(Boolean).join(' · ')}</span>}
          </span>
          {stopped ? <CirclePause className="size-3 text-muted-foreground" /> : row.status === 'running' ? (
            <Loader2 className={cn('size-3 animate-spin', st.cls)} />
          ) : row.status === 'approved' ? (
            <CircleCheck className={cn('size-3', st.cls)} />
          ) : row.status === 'changes' ? (
            <CircleAlert className={cn('size-3', st.cls)} />
          ) : row.status === 'error' ? (
            <XCircle className={cn('size-3', st.cls)} />
          ) : null}
          <span className={cn('shrink-0 text-xs', st.cls)}>{st.text}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-[11px]">
        {row.model && <div>Model: {row.model.providerID}/{row.model.id}</div>}
        <div>{row.error ?? row.findings?.slice(0, 400) ?? `${meta.label} reviewer (read-only)`}</div>
      </TooltipContent>
    </Tooltip>
  )
}

function ReviewDetail({ row, state, auto, onClose }: {
  row: ReviewRow
  state: WorkState
  auto: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 text-sm">
      {row.error && <p className={isReviewStopped(row) ? 'text-muted-foreground' : 'text-destructive'}>{row.error}</p>}
      {!row.sessionId && !row.error && <p className="text-muted-foreground">{row.findings || 'No session was started.'}</p>}
      <ReviewAgentActions row={row} state={state} auto={auto} onRelaunched={onClose} />
      {row.sessionId && <ReviewTranscript row={row} onClose={onClose} />}
      {!row.sessionId && <Button size="sm" variant="ghost" className="self-start" onClick={onClose}>Close</Button>}
    </div>
  )
}

/** The same recovery controls in the workflow panel and each agent's dialog. */
export function ReviewAgentActions({ row, state, auto, onRelaunched }: {
  row: ReviewRow; state: WorkState; auto: boolean; onRelaunched: (next?: ReviewRow) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const reviews = useQuery({ queryKey: ['reviews', row.workId], queryFn: () => window.revva.work.reviews(row.workId) })
  const queue = useQuery({ queryKey: ['work-queue', row.workId], queryFn: () => window.revva.work.queue(row.workId) })
  const rows = reviews.data ?? []
  const round = rows.reduce((latest, item) => Math.max(latest, item.round), 0)
  const latest = rows.filter((item) => item.round === round && item.role === row.role).at(-1)
  const running = row.status === 'running' || row.status === 'pending' || state === 'REVIEW' || state === 'FIXING'
  const reason = reviews.isPending || queue.isPending ? 'Checking agent state…'
    : reviews.isError || queue.isError ? 'Agent or saved-message status could not be checked. Reopen this dialog to retry.'
    : latest?.id !== row.id ? row.role === 'fixer'
      ? 'This fixer belongs to an earlier review round. Re-run review to request further fixes.'
      : 'This is an earlier attempt. Open the latest agent output to relaunch it.'
    : running ? 'The review is still running. Stop review before relaunching an agent.'
    : row.status === 'skipped' ? 'This review was not needed. Run a new review after changing the working folder or code.'
    : row.role === 'fixer' && row.status !== 'error' ? 'Fixes are complete. Re-run review to identify any remaining changes.'
    : queue.data?.length ? 'Send or remove saved follow-ups before relaunching an agent.'
    : state === 'BUILDING' ? 'Implementation is still running in the main conversation. Stop that run or wait for it to finish before relaunching this agent.'
    : !['READY', 'WAITING_HUMAN', 'APPROVED'].includes(state) ? 'Wait for the current work to settle before relaunching this agent.'
    : undefined
  const label = roleMeta[row.role]?.label ?? row.role
  const action = useMutation({
    mutationFn: (kind: 'retry' | 'stop') => kind === 'stop'
      ? window.revva.work.reviewStop(row.workId) : window.revva.work.reviewRetry(row.workId, row.id),
    onSuccess: async (_result, kind) => {
      if (kind === 'retry') {
        const fresh = await reviews.refetch()
        onRelaunched(fresh.data?.filter((item) => item.role === row.role).at(-1))
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['reviews', row.workId] })
      void qc.invalidateQueries({ queryKey: ['works'] })
      void qc.invalidateQueries({ queryKey: ['session-activity'] })
    }
  })
  return <div className="flex shrink-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={!!reason || action.isPending} onClick={() => action.mutate('retry')}>
        {action.isPending && action.variables === 'retry' ? 'Starting…' : row.role === 'fixer' && row.status === 'error' ? 'Resume fixer' : `${row.status === 'error' ? 'Retry' : 'Relaunch'} ${label}`}
      </Button>
      {(running || state === 'WAITING_HUMAN') && <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => action.mutate('stop')}>
        {action.isPending && action.variables === 'stop' ? 'Stopping…' : 'Stop review'}
      </Button>}
    </div>
    <p className="text-xs text-muted-foreground">{reason ?? (row.role === 'fixer'
      ? 'Keeps partial changes and reuses the original session when available. Nothing is reset or discarded.'
      : auto ? 'Other reviewer results are kept; AUTO continues when the gates pass.' : 'Relaunches only this reviewer if the reviewed checkout is unchanged.')}</p>
    {action.error && <p role="alert" className="break-words text-sm text-destructive">{action.error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')}</p>}
  </div>
}

/** Read-only live transcript of one reviewer/fixer session. */
export function ReviewTranscript({ row, onClose, expanded = false }: { row: ReviewRow; onClose?: () => void; expanded?: boolean }): React.JSX.Element | null {
  const sessionId = row.sessionId
  const running = row.status === 'running' || row.status === 'pending'

  const drive = useMemo<TranscriptDrive>(() => {
    return {
      queryKey: ['chat-messages'],
      load: (id, since, requestId) => window.revva.work.messages(id, since, requestId),
      send: async () => {
        throw new Error('Reviews are read-only.')
      },
      interrupt: (id) => window.revva.work.interrupt(id)
    }
  }, [])

  if (!sessionId) return <p className="px-1 py-2 text-[11px] text-muted-foreground">No session yet.</p>
  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-md border bg-background', expanded ? 'h-[55vh]' : 'max-h-72')}>
      <TranscriptView
        key={sessionId}
        sessionId={sessionId}
        drive={drive}
        emptyHint={running ? 'Reviewer is reading the diff…' : 'Finished — see findings.'}
        header={
          <>
            <Badge variant="outline" className="text-[10px]">
              {roleMeta[row.role]?.label ?? row.role}
            </Badge>
            <SessionIdButton key={sessionId} sessionId={sessionId} />
            {onClose && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onClose}>
              close
            </Button>}
          </>
        }
        readOnly
        hideSessionDetails
      />
    </div>
  )
}

/** Manual fresh round of the full review team, not an individual-agent retry. */
export function ReviewRerunButton({ workId, disabled }: { workId: string; disabled?: boolean }): React.JSX.Element {
  const qc = useQueryClient()
  const reviews = useQuery({ queryKey: ['reviews', workId], queryFn: () => window.revva.work.reviews(workId) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
    <Button
      size="sm"
      variant="default"
      disabled={busy || disabled}
      onClick={() => {
        setBusy(true)
        setError(null)
        void window.revva.work
          .reviewStart(workId)
          .catch((err) => setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : String(err)))
          .finally(() => {
            setBusy(false)
            void qc.invalidateQueries({ queryKey: ['reviews', workId] })
            void qc.invalidateQueries({ queryKey: ['works'] })
          })
      }}
    >
      {busy ? 'Starting reviews…' : reviews.data?.length ? 'Re-run all reviews' : 'Start reviews'}
    </Button>
    {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </>
  )
}
