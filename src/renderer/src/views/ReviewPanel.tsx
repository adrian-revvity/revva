import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, Loader2, ScanEye, ShieldQuestion, Sparkles, Wrench, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { TranscriptView, type TranscriptDrive } from './Chat'
import type { PipelineRole, PushEvent, ReviewRow } from '@shared/types'

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

/**
 * Review ledger strip under the cockpit header: one card per reviewer of the latest round
 * (fixer when one is running), expandable to its live transcript. Reviewers run concurrently.
 */
export function ReviewPanel({ workId }: { workId: string }): React.JSX.Element | null {
  const qc = useQueryClient()
  const reviews = useQuery({ queryKey: ['reviews', workId], queryFn: () => window.revva.work.reviews(workId) })
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    return window.revva.events.on((e: PushEvent) => {
      if (e.kind === 'review.updated' && e.workId === workId) qc.setQueryData(['reviews', workId], e.reviews)
    })
  }, [qc, workId])

  const rows = reviews.data ?? []
  const round = rows.reduce((m, r) => (r.role === 'fixer' ? m : Math.max(m, r.round)), 0)
  const current = rows.filter((r) => r.round === round)
  const fixer = rows.filter((r) => r.role === 'fixer' && r.round === round - 1).at(-1)
  const visible = fixer && current.every((r) => r.status === 'pending') ? [fixer, ...current] : current
  if (round === 0 && !fixer) return null

  return (
    <div className="shrink-0 space-y-1 border-b bg-muted/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-medium text-muted-foreground">
          Review · round {round || '—'}
        </span>
        {visible.map((r) => (
          <ReviewChip key={r.id} row={r} active={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} />
        ))}
      </div>
      {open !== null && visible.some((r) => r.id === open) && visible.find((r) => r.id === open)?.sessionId && (
        <ReviewTranscript row={visible.find((r) => r.id === open)!} onClose={() => setOpen(null)} />
      )}
    </div>
  )
}

function ReviewChip({
  row,
  active,
  onClick
}: {
  row: ReviewRow
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const meta = roleMeta[row.role] ?? { label: row.role, icon: <ScanEye className="size-3.5" /> }
  const st: { cls: string; text: string } = statusMeta[row.status] ?? { cls: 'text-muted-foreground', text: row.status }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[11px] transition-colors hover:bg-accent',
            active && 'border-foreground/40 bg-accent',
            row.status === 'running' && 'border-sky-500/40'
          )}
        >
          {meta.icon}
          <span className="font-medium">{meta.label}</span>
          {row.status === 'running' ? (
            <Loader2 className={cn('size-3 animate-spin', st.cls)} />
          ) : row.status === 'approved' ? (
            <CircleCheck className={cn('size-3', st.cls)} />
          ) : row.status === 'changes' ? (
            <CircleAlert className={cn('size-3', st.cls)} />
          ) : row.status === 'error' ? (
            <XCircle className={cn('size-3', st.cls)} />
          ) : null}
          <span className={st.cls}>{st.text}</span>
          {row.agentID && <span className="text-muted-foreground">· {row.agentID}</span>}
          {row.model && <span className="text-muted-foreground">· {row.model.id}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-[11px]">
        {row.error ?? row.findings?.slice(0, 400) ?? `${meta.label} reviewer (read-only)`}
      </TooltipContent>
    </Tooltip>
  )
}

/** Read-only live transcript of one reviewer/fixer session. */
function ReviewTranscript({ row, onClose }: { row: ReviewRow; onClose: () => void }): React.JSX.Element | null {
  const qc = useQueryClient()
  const sessionId = row.sessionId
  const running = row.status === 'running' || row.status === 'pending'

  const drive = useMemo<TranscriptDrive>(() => {
    let buffer = ''
    let currentMessage = ''
    return {
      queryKey: ['review-messages'],
      load: (id) => window.revva.work.messages(id),
      send: async () => {
        throw new Error('Reviews are read-only.')
      },
      interrupt: (id) => window.revva.work.interrupt(id),
      subscribe: (_id, onDelta, onDone) =>
        window.revva.events.on((event: PushEvent) => {
          if (event.kind === 'review.delta' && event.sessionId === _id) {
            if (event.messageId !== currentMessage) {
              currentMessage = event.messageId
              buffer = ''
            }
            buffer += event.text
            onDelta(buffer)
          } else if (event.kind === 'review.updated') {
            const fresh = (qc.getQueryData<ReviewRow[]>(['reviews', event.workId]) ?? []).find((r) => r.id === row.id)
            if (fresh && fresh.status !== 'running' && fresh.status !== 'pending') {
              buffer = ''
              currentMessage = ''
              onDone()
            }
          }
        })
    }
  }, [qc, row.id])

  if (!sessionId) return <p className="px-1 py-2 text-[11px] text-muted-foreground">No session yet.</p>
  return (
    <div className="flex max-h-72 min-h-0 flex-col overflow-hidden rounded-md border bg-background">
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
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onClose}>
              close
            </Button>
          </>
        }
        readOnly
      />
    </div>
  )
}

/** "Re-run review" — manual round trigger after resolving a blocker by hand. */
export function ReviewRerunButton({ workId, disabled }: { workId: string; disabled?: boolean }): React.JSX.Element {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || disabled}
      onClick={() => {
        setBusy(true)
        void window.revva.work
          .reviewStart(workId)
          .catch((err) => console.error(err))
          .finally(() => setBusy(false))
          .then(() => qc.invalidateQueries({ queryKey: ['reviews', workId] }))
      }}
    >
      Re-run review
    </Button>
  )
}
