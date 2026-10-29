import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, Loader2, ScanEye, ShieldQuestion, Sparkles, Wrench } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { ReviewRow, WorkSummary } from '@shared/types'
import { FormCard, PermissionCard, useInbox } from './InboxView'
import { isReviewStopped, ReviewAgentActions, ReviewTranscript } from './ReviewPanel'

const roles = [
  { role: 'sol', label: 'Sol-loop', icon: ScanEye },
  { role: 'testAudit', label: 'Test audit', icon: ShieldQuestion },
  { role: 'impeccable', label: 'UI review', icon: Sparkles },
  { role: 'fixer', label: 'Fixer', icon: Wrench }
] as const

const statusTones = {
  neutral: { surface: 'hover:bg-accent', text: 'text-muted-foreground' },
  active: { surface: 'border-status-info/20 bg-status-info/5 hover:bg-status-info/10', text: 'text-status-info' },
  approved: { surface: 'border-status-success/20 bg-status-success/5 hover:bg-status-success/10', text: 'text-status-success' },
  attention: { surface: 'border-status-warning/20 bg-status-warning/5 hover:bg-status-warning/10', text: 'text-status-warning' },
  error: { surface: 'border-status-error/20 bg-status-error/5 hover:bg-status-error/10', text: 'text-status-error' }
} as const

function statusText(row: ReviewRow | undefined): string {
  if (!row) return 'Not started'
  if (isReviewStopped(row)) return 'Stopped'
  if (row.role === 'fixer' && row.status === 'running') return 'Fixing'
  if (row.role === 'fixer' && row.status === 'approved') return 'Fixes complete'
  return { pending: 'Queued', running: 'Reviewing', approved: 'Approved', changes: 'Changes requested', error: 'Needs attention', skipped: 'Not needed' }[row.status]
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}

/** Ticket-specific composition: four agent launchers and the existing activity footer. */
export function WorkAgentActivity({ work }: { work: WorkSummary }): React.JSX.Element | null {
  const qc = useQueryClient()
  const busy = work.state === 'REVIEW' || work.state === 'FIXING'
  const reviews = useQuery({
    queryKey: ['reviews', work.id], queryFn: () => window.revva.work.reviews(work.id),
    refetchInterval: busy ? 5000 : false
  })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models() })
  const inbox = useInbox()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now)
  const trigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [busy])
  useEffect(() => window.revva.events.on((event) => {
    if (event.kind === 'review.updated' && event.workId === work.id) qc.setQueryData(['reviews', work.id], event.reviews)
  }), [qc, work.id])
  const stop = useMutation({
    mutationFn: () => window.revva.work.reviewStop(work.id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['works'] })
      void qc.invalidateQueries({ queryKey: ['reviews', work.id] })
    }
  })
  const rows = reviews.data ?? []
  const round = rows.reduce((latest, row) => Math.max(latest, row.round), 0)
  const current = roles.map((meta) => ({
    ...meta,
    row: rows.filter((row) => row.role === meta.role && (meta.role === 'fixer' ? row.round <= round : row.round === round)).at(-1)
  }))
  const selected = rows.find((row) => row.id === selectedId)
  const active = current.filter(({ row }) => row?.status === 'running' || row?.status === 'pending')
  const waiting = inbox.filter((item) => rows.some((row) => row.sessionId === item.sessionID))
  const latestActive = active.reduce<(typeof current)[number] | undefined>((latest, item) =>
    !latest || (item.row?.lastActivityAt ?? 0) > (latest.row?.lastActivityAt ?? 0) ? item : latest, undefined)
  const latestActivity = latestActive?.row?.activity ?? (latestActive?.row?.status === 'pending'
    ? 'Starting session…'
    : now - (latestActive?.row?.updatedAt ?? now) >= 60_000 ? 'No recent activity — open output to inspect' : 'Waiting for activity…')
  const summary = waiting.length ? `${waiting.length} request(s) waiting on you` : latestActive?.row
    ? `${latestActive.label} · ${latestActivity}`
    : busy ? 'Preparing agents…' : work.blocker ?? (work.state === 'APPROVED' ? 'All required review gates passed.' : 'Select an agent to inspect its output.')

  if (!busy && rows.length === 0 && !reviews.isError) return null
  return <section aria-label="Review and fixer activity" className="shrink-0 px-3 py-2 sm:px-6">
    <div className="mx-auto flex max-w-3xl flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{work.state === 'FIXING' ? 'Fixing' : work.state === 'BUILDING' ? 'Previous review' : 'Review'}{round ? ` · round ${round}` : ''}</Badge>
        <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={summary}>{summary}</span>
        {(busy || work.state === 'WAITING_HUMAN') && <Button type="button" size="xs" variant="ghost" disabled={stop.isPending} onClick={() => stop.mutate()}>{stop.isPending ? 'Stopping…' : 'Stop review'}</Button>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {current.map(({ role, label, icon: Icon, row }) => {
          const running = row?.status === 'running'
          const pending = inbox.some((item) => item.sessionID === row?.sessionId)
          const tone = statusTones[pending || row?.status === 'changes' ? 'attention'
            : row?.status === 'error' ? 'error' : row?.status === 'approved' ? 'approved'
              : running ? 'active' : 'neutral']
          const quietFor = now - (row?.lastActivityAt ?? row?.updatedAt ?? now)
          const detail = pending ? 'Waiting on you — open to respond' : running
            ? row?.activity ?? 'Waiting for activity…'
            : row?.error ?? row?.findings?.split('\n').find((line) => line.trim()) ?? (role === 'fixer' ? 'Runs when changes are requested' : 'Waiting for implementation')
          return <button key={role} type="button" disabled={!row} aria-label={`${label}: ${pending ? 'Waiting on you' : statusText(row)}. Open output`}
            className={cn('flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 disabled:hover:bg-transparent', tone.surface)}
            onClick={(event) => { trigger.current = event.currentTarget; setSelectedId(row?.id ?? null) }}>
            <span className="flex items-center gap-2 font-medium"><Icon className="size-3.5 shrink-0" />{label}
              {running && !pending && <Loader2 className={cn('ml-auto size-3 shrink-0 motion-safe:animate-spin', tone.text)} />}
              {(pending || row?.status === 'error') && <CircleAlert className={cn('ml-auto size-3 shrink-0', tone.text)} />}
              {row?.status === 'approved' && <CircleCheck className={cn('ml-auto size-3 shrink-0', tone.text)} />}
            </span>
            <span className={cn('truncate', tone.text)}>{pending ? 'Waiting on you' : statusText(row)}{running && row ? ` · ${duration(now - row.createdAt)}` : ''}</span>
            <span className="truncate text-foreground/65" title={detail}>{running && !pending && quietFor >= 60_000 ? `No new activity for ${duration(quietFor)}` : detail}</span>
          </button>
        })}
      </div>
      {reviews.isError && <p role="alert" className="text-xs text-destructive">Agent status unavailable. <Button size="xs" variant="ghost" onClick={() => void reviews.refetch()}>Retry</Button></p>}
      {stop.error && <p role="alert" className="text-xs text-destructive">{stop.error.message}</p>}
    </div>
    <Dialog open={selectedId !== null} onOpenChange={(open) => { if (!open) setSelectedId(null) }}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-4xl" onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus() }}>
        <DialogHeader>
          <DialogTitle>{roles.find((meta) => meta.role === selected?.role)?.label ?? 'Agent output'}{selected ? ` · round ${selected.round}` : ''}</DialogTitle>
          <DialogDescription>{statusText(selected)}{selected?.model ? ` · ${models.data?.find((model) => model.providerID === selected.model?.providerID && model.id === selected.model?.id)?.name ?? selected.model.id}` : ''}</DialogDescription>
        </DialogHeader>
        {selected?.error && <p role={isReviewStopped(selected) ? 'status' : 'alert'} className={cn('break-words text-sm', isReviewStopped(selected) ? 'text-muted-foreground' : 'text-destructive')}>{selected.error}</p>}
        {selected && <ReviewAgentActions row={selected} state={work.state} auto={work.mode === 'auto'} onRelaunched={(next) => setSelectedId(next?.id ?? null)} />}
        {selected && inbox.filter((item) => item.sessionID === selected.sessionId).length > 0 && <div className="max-h-[25vh] overflow-y-auto">
          {inbox.filter((item) => item.sessionID === selected.sessionId).map((item) => item.kind === 'form'
            ? <FormCard key={item.id} item={item} /> : <PermissionCard key={item.id} item={item} />)}
        </div>}
        {selected?.sessionId ? <ReviewTranscript key={selected.sessionId} row={selected} expanded />
          : <p className="text-sm text-muted-foreground">{selected?.findings || 'This agent has not started a session.'}</p>}
      </DialogContent>
    </Dialog>
  </section>
}
