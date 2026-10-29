import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleX, ExternalLink, Rocket, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ShipCheck, WorkSummary } from '@shared/types'

/** States revva can push/PR from; running sessions must finish first, READY/ABANDONED have nothing to ship. */
const SHIPPABLE_STATES = new Set(['APPROVED', 'WAITING_HUMAN', 'REWORK', 'SHIPPED'])
const RUNNING_STATES = new Set(['BUILDING', 'REVIEW', 'FIXING'])

/** Why the ship action is unavailable for this work, or undefined when it can run. Shared with the PR menu. */
export function shipBlockReason(work: WorkSummary): string | undefined {
  if (RUNNING_STATES.has(work.state)) return 'Shipping waits until the running session finishes.'
  if (!SHIPPABLE_STATES.has(work.state)) return 'Nothing to ship until the build produces commits.'
  return undefined
}

/**
 * Cockpit-header button, PR-less runs only: Push/PR when the run is at rest
 * (even without green gates — the dialog warns), disabled with a reason while
 * a session is running. Once a PR exists these actions live in the PR menu,
 * so this button steps aside.
 */
export function ShipHeaderButton({ work }: { work: WorkSummary }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (work.state === 'ABANDONED' || work.state === 'READY') return null
  if (work.prUrl) return null
  if (RUNNING_STATES.has(work.state)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" disabled>
              <Rocket className="size-3" /> Push / PR
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Shipping waits until the running session finishes.</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant={SHIPPABLE_STATES.has(work.state) ? 'default' : 'outline'}
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={!SHIPPABLE_STATES.has(work.state)}
            onClick={() => setOpen(true)}
          >
            <Rocket className="size-3" />
            {work.state === 'SHIPPED' ? 'Push + PR' : 'Push / PR'}
          </Button>
        </TooltipTrigger>
        {!SHIPPABLE_STATES.has(work.state) && (
          <TooltipContent>Nothing to ship until the build produces commits.</TooltipContent>
        )}
      </Tooltip>
      <ShipDialog work={work} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/**
 * Ship strip: appears when reviews approve (interactive mode; AUTO ships by itself).
 * Runs pre-flight checks, then pushes + opens the PR via gh and syncs Jira.
 */
export function ShipPanel({ work }: { work: WorkSummary }): React.JSX.Element | null {
  const [dialogOpen, setDialogOpen] = useState(false)

  if (work.state === 'SHIPPED' && work.prUrl) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b bg-emerald-500/10 px-3 py-2 text-xs">
        <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
        <span className="font-medium text-emerald-700 dark:text-emerald-400">Shipped</span>
        <a
          href={work.prUrl}
          target="_blank"
          rel="noreferrer"
          className="truncate font-mono text-[11px] text-muted-foreground hover:underline"
          title={work.prUrl}
        >
          {work.prUrl}
        </a>
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-2" onClick={() => window.open(work.prUrl, '_blank')}>
          <ExternalLink className="mr-1 size-3" /> Open PR
        </Button>
      </div>
    )
  }
  if (work.state !== 'APPROVED') return null
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-emerald-500/5 px-3 py-2 text-xs">
      <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
      <span>All review gates approved — ready to ship.</span>
      <Button size="sm" className="ml-auto" onClick={() => setDialogOpen(true)}>
        <Rocket className="mr-1 size-3.5" /> Ship…
      </Button>
      <ShipDialog work={work} open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  )
}

/** Gated push → PR → Jira dialog; also opened from the PR menu's "Push changes". */
export function ShipDialog({ work, open, onClose }: { work: WorkSummary; open: boolean; onClose: () => void }): React.JSX.Element {
  const checks = useQuery({
    queryKey: ['ship-checks', work.id],
    queryFn: () => window.revva.work.shipCheck(work.id),
    enabled: open
  })
  const ship = useMutation({ mutationFn: () => window.revva.work.ship(work.id) })

  const allOk = !!checks.data && !checks.isError && checks.data.every((c) => c.ok || c.fatal === false)
  const unreviewed = (checks.data ?? []).some((c) => !c.ok && c.name === 'Reviewed commit')
  const blockers = (checks.data ?? []).filter((c) => !c.ok && c.fatal !== false)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !ship.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ship {work.ticketKey}</DialogTitle>
          <DialogDescription className="font-mono text-[11px]">
            push {work.branch} → PR → Jira sync. revva never merges or force-pushes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          {checks.isLoading && <p className="text-xs text-muted-foreground">Checking…</p>}
          {checks.isError && (
            <div role="alert" className="text-xs text-destructive">
              <p>Could not run shipping checks: {checks.error instanceof Error ? checks.error.message : String(checks.error)}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => void checks.refetch()}>Retry checks</Button>
            </div>
          )}
          {(checks.data ?? []).map((c: ShipCheck) => (
            <div key={c.name} className="flex items-start gap-2 text-xs">
              {c.ok ? (
                <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <CircleX className={cn('mt-0.5 size-3.5 shrink-0', c.fatal === false ? 'text-amber-500' : 'text-destructive')} />
              )}
              <div className="min-w-0">
                <span className="font-medium">{c.name}</span>
                {!c.ok && c.fatal === false && <Badge variant="outline" className="ml-1.5 text-[9px]">optional</Badge>}
                <p className="break-words text-[11px] text-muted-foreground">{c.detail}</p>
              </div>
            </div>
          ))}
          {ship.error instanceof Error && <p className="text-xs text-destructive">{ship.error.message}</p>}
        </div>
        {unreviewed && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>This commit has not passed the review gates. Shipping pushes it as-is and records the choice in Revva.</span>
          </div>
        )}
        {blockers.length > 0 && <p role="status" className="text-xs text-destructive">Resolve {blockers.map((c) => c.name).join(', ')} before shipping. Ship anyway only bypasses review gates.</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={ship.isPending}>
            Cancel
          </Button>
          <Button variant={unreviewed ? 'destructive' : 'default'} onClick={() => ship.mutate()} disabled={!allOk || checks.isFetching || ship.isPending}>
            {ship.isPending ? 'Shipping…' : work.prUrl ? 'Push to PR' : unreviewed ? 'Ship anyway' : 'Push + create PR'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
