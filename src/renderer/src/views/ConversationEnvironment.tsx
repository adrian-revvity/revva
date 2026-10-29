import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleAlert, Info, Loader2, ScanEye } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import type { WorkSummary } from '@shared/types'
import { workStateLabels } from '@/lib/work-state'
import { ReviewPanel } from './ReviewPanel'
import { ShipDialog, shipBlockReason } from './ShipPanel'
import { CommentsStrip } from './CommentsStrip'

/** The same utilities for started runs, Jira links and PR links. */
export function ConversationEnvironment({ work, children }: { work?: WorkSummary; children: ReactNode }): React.JSX.Element {
  const qc = useQueryClient()
  useEffect(() => {
    if (!work?.unread) return
    void window.revva.triage.markRead('work', work.id).then(() => qc.invalidateQueries({ queryKey: ['works'] }))
  }, [qc, work?.id, work?.unread])
  useEffect(() => {
    if (!work) return
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
  }, [qc, work?.id])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {work && <CommentsStrip workId={work.id} />}
      {children}
    </div>
  )
}

export function ConversationActions({ work }: { work: WorkSummary }): React.JSX.Element {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [shipOpen, setShipOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const reviews = useQuery({ queryKey: ['reviews', work.id], queryFn: () => window.revva.work.reviews(work.id) })
  useEffect(() => window.revva.events.on((event) => {
    if (event.kind === 'review.updated' && event.workId === work.id) qc.setQueryData(['reviews', work.id], event.reviews)
  }), [qc, work.id])
  const round = (reviews.data ?? []).reduce((latest, row) => Math.max(latest, row.round), 0)
  const latest = [...new Map((reviews.data ?? []).filter((row) => row.round === round && row.role !== 'fixer').map((row) => [row.role, row])).values()]
  const required = latest.filter((row) => row.status !== 'skipped')
  const approved = required.filter((row) => row.status === 'approved').length
  const running = work.state === 'REVIEW' || work.state === 'FIXING'
  const shippingBlocker = shipBlockReason(work)
  return <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger ref={trigger} render={<Button variant="outline" size="sm" className="shrink-0" />}>
        {running ? <Loader2 data-icon="inline-start" className="animate-spin" /> : work.state === 'WAITING_HUMAN' ? <CircleAlert data-icon="inline-start" /> : <ScanEye data-icon="inline-start" />}
        <span className="hidden md:inline">Workflow · </span>{workStateLabels[work.state]}
        <ChevronDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[80vh] w-[min(48rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto p-4">
        <PopoverHeader>
          <div className="flex items-center justify-between gap-2">
            <PopoverTitle>Review &amp; delivery</PopoverTitle>
            {work.mode === 'auto' && <Badge variant="secondary">Auto</Badge>}
          </div>
          <PopoverDescription>{workStateLabels[work.state]}{round ? ` · round ${round}` : ''}</PopoverDescription>
        </PopoverHeader>
        {work.blocker && <p role="alert" className="break-words text-sm">{work.blocker}</p>}
        <p className="text-sm text-muted-foreground">
          {reviews.isError ? 'Review status unavailable. Reopen Workflow to retry.' : required.length ? `Round ${round}: ${approved} of ${required.length} review gates approved.` : 'Reviews start after implementation is complete.'}
        </p>
        <ReviewPanel workId={work.id} state={work.state} auto={work.mode === 'auto'} />
        <Separator />
        <div className="flex flex-wrap items-center gap-2">
          {!work.prUrl && <Button size="sm" disabled={!!shippingBlocker} onClick={() => { setOpen(false); setShipOpen(true) }}>{work.state === 'APPROVED' ? 'Ship…' : 'Push / PR…'}</Button>}
          {work.prUrl && <span className="text-xs text-muted-foreground">Push and PR actions are in the PR menu.</span>}
        </div>
        {shippingBlocker && <p className="text-xs text-muted-foreground">{shippingBlocker}</p>}
      </PopoverContent>
    </Popover>
    <ShipDialog work={work} open={shipOpen} onClose={() => { setShipOpen(false); trigger.current?.focus() }} />
  </>
}

/** Secondary metadata lives here instead of competing with the conversation title. */
export function ConversationDetails({ sessionId, directory, work, children }: {
  sessionId: string; directory?: string; work?: WorkSummary; children: ReactNode
}): React.JSX.Element {
  const qc = useQueryClient()
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const model = useQuery({ queryKey: ['session-model', sessionId], queryFn: () => window.revva.session.model(sessionId), enabled: open })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models(), enabled: open })
  const modelName = model.data ? models.data?.find((item) => item.providerID === model.data?.providerID && item.id === model.data?.id)?.name || model.data.id : model.isError ? 'Unavailable' : model.isPending ? 'Loading…' : 'Service default'
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button size="sm" variant="ghost" className="shrink-0" />}>
      <Info data-icon="inline-start" /><span className="hidden sm:inline">Details</span><span className="sr-only sm:hidden">Conversation details</span>
    </PopoverTrigger>
    <PopoverContent ref={popup} initialFocus={popup} align="end" className="max-h-[75vh] w-80 max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto p-4">
      <PopoverTitle>Conversation details</PopoverTitle>
      <dl className="flex flex-col gap-3 text-sm">
        <div><dt className="text-muted-foreground">Model</dt><dd className="break-words">{modelName}{model.data?.variant ? ` · ${model.data.variant}` : ''}</dd></div>
        {work && <div><dt className="text-muted-foreground">Branch</dt><dd className="break-all">{work.branch || 'Not selected'}</dd></div>}
        <div><dt className="text-muted-foreground">{work ? 'Review folder' : 'Folder'}</dt><dd className="break-all font-mono text-xs">{work?.worktreeDir ?? directory ?? 'Unavailable'}</dd></div>
        <div><dt className="text-muted-foreground">Session</dt><dd>{children}</dd></div>
      </dl>
      {work && <Button size="sm" variant="outline" disabled={choosing || work.state === 'REVIEW' || work.state === 'FIXING' || work.state === 'SHIPPED'} onClick={async () => {
        setChoosing(true)
        setError(null)
        try {
          const folder = await window.revva.workspace.pickFolder()
          if (folder) {
            await window.revva.work.conversationContext(sessionId, folder)
            await qc.invalidateQueries({ queryKey: ['works'] })
          }
        } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
        finally { setChoosing(false) }
      }}>{choosing ? 'Choosing folder…' : 'Change review folder'}</Button>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </PopoverContent>
  </Popover>
}
