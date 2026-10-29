import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleAlert, Info, Loader2, ScanEye } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import type { WorkSummary } from '@shared/types'
import { workStateLabels } from '@/lib/work-state'
import { ReviewPanel, ReviewRerunButton } from './ReviewPanel'
import { ShipDialog, shipBlockReason } from './ShipPanel'
import { CommentsStrip } from './CommentsStrip'

// Ready means ready to review, not approved: reserve green for passed/delivered work.
const workflowVariants = {
  READY: 'info', BUILDING: 'info', REVIEW: 'info',
  FIXING: 'warning', REWORK: 'warning', WAITING_HUMAN: 'warning',
  APPROVED: 'success', SHIPPED: 'success', ABANDONED: 'outline'
} as const

/** Revva's own lists are pickers, so "leave this alone" needs an option value of its own. */
const NONE = '__keep__'

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
  const popup = useRef<HTMLDivElement>(null)
  const reviews = useQuery({ queryKey: ['reviews', work.id], queryFn: () => window.revva.work.reviews(work.id) })
  useEffect(() => window.revva.events.on((event) => {
    if (event.kind === 'review.updated' && event.workId === work.id) qc.setQueryData(['reviews', work.id], event.reviews)
  }), [qc, work.id])
  const round = (reviews.data ?? []).reduce((latest, row) => Math.max(latest, row.round), 0)
  const latest = [...new Map((reviews.data ?? []).filter((row) => row.round === round && row.role !== 'fixer').map((row) => [row.role, row])).values()]
  const required = latest.filter((row) => row.status !== 'skipped')
  const approved = required.filter((row) => row.status === 'approved').length
  const running = work.state === 'REVIEW' || work.state === 'FIXING'
  const reviewBlocker = work.state === 'BUILDING' ? 'Wait for the main implementation run to finish before starting review.'
    : work.state === 'REWORK' ? 'Wait for rework to finish before starting review.'
    : running ? 'Stop the current review before starting another round.'
    : work.state === 'SHIPPED' ? 'Send a follow-up to begin a new change before reviewing shipped work.'
    : work.state === 'ABANDONED' ? 'This work was abandoned.'
    : undefined
  const shippingBlocker = shipBlockReason(work)
  return <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger ref={trigger} render={<Button variant={workflowVariants[work.state]} size="sm" className="shrink-0" />}>
        {running ? <Loader2 data-icon="inline-start" className="animate-spin" /> : work.state === 'WAITING_HUMAN' ? <CircleAlert data-icon="inline-start" /> : <ScanEye data-icon="inline-start" />}
        <span className="hidden md:inline">Workflow · </span>{workStateLabels[work.state]}
        <ChevronDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent ref={popup} initialFocus={popup} align="end" className="max-h-[80vh] w-[min(26rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto p-4">
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
          <ReviewRerunButton workId={work.id} disabled={!!reviewBlocker} />
          {!work.prUrl && <Button size="sm" disabled={!!shippingBlocker} onClick={() => { setOpen(false); setShipOpen(true) }}>{work.state === 'APPROVED' ? 'Ship…' : 'Push / PR…'}</Button>}
          {work.prUrl && <span className="text-xs text-muted-foreground">Push and PR actions are in the PR menu.</span>}
        </div>
        {reviewBlocker && <p className="text-xs text-muted-foreground">{reviewBlocker}</p>}
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [worktree, setWorktree] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const model = useQuery({ queryKey: ['session-model', sessionId], queryFn: () => window.revva.session.model(sessionId), enabled: open })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models(), enabled: open })
  const modelName = model.data ? models.data?.find((item) => item.providerID === model.data?.providerID && item.id === model.data?.id)?.name || model.data.id : model.isError ? 'Unavailable' : model.isPending ? 'Loading…' : 'Service default'
  // Revva's own list, main checkouts included: a conversation may work in one. Cleanup
  // asks without them so that dialog can never offer the repository itself.
  const worktrees = useQuery({
    queryKey: ['worktrees', 'conversations'],
    queryFn: () => window.revva.worktrees.list({ includeMainCheckouts: true }),
    enabled: open
  })
  const here = work?.worktreeDir ?? directory ?? ''
  const picked = worktree ?? (here || null)
  const branches = useQuery({
    queryKey: ['worktree-branches', picked],
    queryFn: () => window.revva.worktrees.branches({ directory: picked ?? here }),
    enabled: open && !!picked
  })
  const repoRoot = branches.data?.repoDir
  const shown = (worktrees.data ?? []).filter((wt) => !repoRoot || wt.repoDir === repoRoot)
  const listed = shown.some((wt) => wt.directory === picked)
  const busy = work?.state === 'BUILDING' || work?.state === 'REVIEW' || work?.state === 'FIXING' || work?.state === 'SHIPPED'
  const chooseWorktree = (value: string): void => {
    setWorktree(value === NONE ? null : value)
    setBranch(null)
    setError(null)
    setNote(null)
  }
  const apply = async (input: { directory?: string; branch?: string }): Promise<void> => {
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const result = await window.revva.work.setCheckout(sessionId, input)
      setNote(result.note)
      setWorktree(null)
      setBranch(null)
      // The folder moved with the session, so anything anchored on it is stale.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['chats'] }),
        qc.invalidateQueries({ queryKey: ['works'] }),
        qc.invalidateQueries({ queryKey: ['worktrees'] }),
        qc.invalidateQueries({ queryKey: ['worktree-branches'] }),
        qc.invalidateQueries({ queryKey: ['conversation-context', sessionId] })
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button size="sm" variant="ghost" className="shrink-0" />}>
      <Info data-icon="inline-start" /><span className="hidden sm:inline">Details</span><span className="sr-only sm:hidden">Conversation details</span>
    </PopoverTrigger>
    <PopoverContent ref={popup} initialFocus={popup} align="end" className="max-h-[75vh] w-96 max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto p-4">
      <PopoverTitle>Conversation details</PopoverTitle>
      <dl className="flex flex-col gap-3 text-sm">
        <div><dt className="text-muted-foreground">Model</dt><dd className="break-words">{modelName}{model.data?.variant ? ` · ${model.data.variant}` : ''}</dd></div>
        {work && <div><dt className="text-muted-foreground">Branch</dt><dd className="break-all">{work.branch || 'Not selected'}</dd></div>}
        <div><dt className="text-muted-foreground">{work ? 'Review folder' : 'Folder'}</dt><dd className="break-all font-mono text-xs">{here || 'Unavailable'}</dd></div>
        <div><dt className="text-muted-foreground">Session</dt><dd>{children}</dd></div>
      </dl>
      <Separator />
      <div className="flex flex-col gap-3">
        <PopoverHeader className="gap-1">
          <PopoverTitle className="text-sm">Where this conversation works</PopoverTitle>
          <PopoverDescription>Both lists are Revva’s own — worktrees it knows and branches git reports. Nothing is created, renamed or deleted.</PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground" htmlFor={`${sessionId}-worktree`}>Worktree</label>
          <select
            id={`${sessionId}-worktree`}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            value={picked ?? NONE}
            disabled={busy || saving || (worktrees.isPending && !worktrees.data)}
            onChange={(event) => chooseWorktree(event.target.value)}
          >
            {!picked && <option value={NONE}>Loading…</option>}
            {picked && !listed && <option value={picked}>{here} — current</option>}
            {shown.map((wt) => (
              <option key={`${wt.repoDir}\u0000${wt.directory}`} value={wt.directory}>
                {wt.directory.split(/[\\/]/).filter(Boolean).pop() || wt.directory}
                {wt.branch ? ` — ${wt.branch}` : wt.detached ? ' — detached HEAD' : ''}
                {wt.directory === here ? ' · current' : wt.mainCheckout ? ' · main checkout' : wt.ticketKey ? ` · ${wt.ticketKey}` : ''}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {branches.isError
              ? (branches.error instanceof Error ? branches.error.message : String(branches.error))
              : branches.data
                ? `${branches.data.repoDir}${branches.data.mainCheckout ? ' — the main checkout of this repository' : ''}`
                : worktrees.isError
                  ? 'Revva could not list its worktrees. The branch list below still reads git directly.'
                  : 'Reading git…'}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted-foreground" htmlFor={`${sessionId}-branch`}>Branch</label>
          {work?.prUrl ? (
            <p className="text-xs text-muted-foreground">This run is linked to a PR, so it stays on the PR’s branch. Pick its worktree, or start another conversation for a different branch.</p>
          ) : <select
            id={`${sessionId}-branch`}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            value={branch ?? NONE}
            disabled={busy || saving || !branches.data}
            onChange={(event) => { setBranch(event.target.value === NONE ? null : event.target.value); setNote(null) }}
          >
            <option value={NONE}>{branches.data ? `Stay on ${branches.data.current || 'the current checkout'}` : branches.isError ? 'Git could not read this checkout' : 'Loading…'}</option>
            {(branches.data?.branches ?? []).map((item) => (
              <option key={`${item.remote ?? ''}\u0000${item.name}`} value={item.name} disabled={!!item.remotes || (!item.current && !!item.checkedOutIn)}>
                {item.name}
                {item.current ? ' · current' : item.checkedOutIn ? ` · checked out in ${item.checkedOutIn}` : item.remotes ? ` · on ${item.remotes.join(' and ')} — Revva will not guess` : item.remoteOnly ? ` · ${item.remote ?? 'remote'} only, starts a local branch` : ''}
              </option>
            ))}
          </select>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={saving || busy || (!worktree && !branch)} onClick={() => void apply({ directory: worktree ?? undefined, branch: branch ?? undefined })}>
            {saving && <Loader2 data-icon="inline-start" className="animate-spin" />}
            {saving ? 'Working…' : 'Apply'}
          </Button>
          <span className="text-xs text-muted-foreground">A dirty checkout is refused before git runs.</span>
        </div>
        {work && <p className="text-xs text-muted-foreground">This run’s folder and branch follow the guards of its state; a shipped run keeps the checkout it shipped from.</p>}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </PopoverContent>
  </Popover>
}
