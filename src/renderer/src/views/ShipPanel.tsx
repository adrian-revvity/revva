import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleX, ExternalLink, Rocket } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import type { ShipCheck, WorkSummary } from '@shared/types'

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

function ShipDialog({ work, open, onClose }: { work: WorkSummary; open: boolean; onClose: () => void }): React.JSX.Element {
  const checks = useQuery({
    queryKey: ['ship-checks', work.id],
    queryFn: () => window.revva.work.shipCheck(work.id),
    enabled: open
  })
  const ship = useMutation({ mutationFn: () => window.revva.work.ship(work.id) })

  const allOk = (checks.data ?? []).every((c) => c.ok || c.fatal === false)

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
                <p className="truncate text-[11px] text-muted-foreground" title={c.detail}>{c.detail}</p>
              </div>
            </div>
          ))}
          {ship.error instanceof Error && <p className="text-xs text-destructive">{ship.error.message}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={ship.isPending}>
            Cancel
          </Button>
          <Button onClick={() => ship.mutate()} disabled={!allOk || checks.isLoading || ship.isPending}>
            {ship.isPending ? 'Shipping…' : 'Push + create PR'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
