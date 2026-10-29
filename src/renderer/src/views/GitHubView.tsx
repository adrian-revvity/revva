import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Bell,
  Check,
  ChevronDown,
  CircleDot,
  Clock4,
  CornerUpLeft,
  ExternalLink,
  GitMerge,
  Layers,
  Loader2,
  MessageSquareDot,
  MessageSquareText,
  Pin,
  PinOff,
  RefreshCw,
  ScanEye,
  Github,
  Undo2,
  X
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CardBoard, CardZone, moveToZone } from '@/components/CardBoard'
import { PrInfoDialog } from './PrInfoDialog'
import { useCardOrder } from '@/lib/use-card-order'
import { cn } from '@/lib/utils'
import type { PrAlert, PrMergeMethod, PullRequest } from '@shared/types'/** Unseen PR events (comments/conflicts/approvals) — sidebar bell + polling feed.
 *  The feed is push-based (main sends it after every poll), so no refetch
 *  interval and no focus-refetch: one fetch on app start, pushes from there. */
export function useGithubAlerts(): PrAlert[] {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['gh-alerts'],
    queryFn: () => window.revva.github.alerts(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  useEffect(() => {
    return window.revva.events.on((e) => {
      if (e.kind === 'github.alerts') qc.setQueryData(['gh-alerts'], e.items)
    })
  }, [qc])
  return q.data ?? []
}

/**
 * GitHub tab: open PRs (authored / review-requested) via the user's `gh` CLI.
 * "Review" spins up a read-only review session on a checked-out PR worktree.
 */
export function GitHubView({
  onOpenChat
}: {
  onOpenChat: (sessionId: string) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const [scope, setScope] = useState<'mine' | 'review'>('mine')
  const [busyUrl, setBusyUrl] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const prs = useQuery({
    queryKey: ['gh-prs', scope],
    queryFn: () => window.revva.github.list(scope),
    staleTime: 30_000,
    // Background freshness: conflicts/approvals/comments land without a manual refresh.
    refetchInterval: 90_000
  })
  const review = useMutation({
    mutationFn: (prUrl: string) => window.revva.github.review(prUrl),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['chats'] })
      void qc.invalidateQueries({ queryKey: ['gh-prs'] })
      onOpenChat(res.sessionId)
    }
  })
  const chatSession = useMutation({
    mutationFn: (prUrl: string) => window.revva.github.chat(prUrl),
    onSuccess: (res) => {
      setActionError(null)
      void qc.invalidateQueries({ queryKey: ['chats'] })
      void qc.invalidateQueries({ queryKey: ['gh-prs'] })
      onOpenChat(res.sessionId)
    },
    onError: (e: Error) => setActionError(e.message)
  })
  /** Big card button: new chat linked to the PR (+ ticket), checked out at its branch. */
  const startChat = (url: string): void => {
    setBusyUrl(url)
    void window.revva.github.markSeen(url)
    chatSession.mutate(url, { onSettled: () => setBusyUrl(null) })
  }
  const solveConflicts = useMutation({
    mutationFn: (prUrl: string) => window.revva.github.solveConflicts(prUrl),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['chats'] })
      onOpenChat(res.sessionId)
    },
    onError: (e: Error) => {
      void qc.invalidateQueries({ queryKey: ['chats'] })
      setActionError(e.message)
    }
  })
  const merge = useMutation({
    mutationFn: ({ prUrl, method }: { prUrl: string; method: PrMergeMethod }) =>
      window.revva.github.merge(prUrl, method),
    onSuccess: () => {
      setActionError(null)
      void qc.invalidateQueries({ queryKey: ['gh-prs'] })
      void qc.invalidateQueries({ queryKey: ['gh-alerts'] })
      void qc.invalidateQueries({ queryKey: ['works'] })
    },
    onError: (e: Error) => setActionError(e.message)
  })
  const rebase = useMutation({
    mutationFn: (prUrl: string) => window.revva.github.rebase(prUrl),
    onSuccess: () => {
      setActionError(null)
      void qc.invalidateQueries({ queryKey: ['gh-prs'] })
      void qc.invalidateQueries({ queryKey: ['gh-alerts'] })
    },
    onError: (e: Error) => setActionError(e.message)
  })

  // Merged PRs are done — never listed, never alerted (main stopped fetching
  // them; this also covers cached pages that still contain one).
  const visible = (prs.data ?? []).filter((pr) => !pr.merged && pr.state !== 'merged')
  const alerts = useGithubAlerts()
  // Nonce so clicking the same alert row twice still re-triggers the jump.
  const [jump, setJump] = useState<{ url: string; n: number } | null>(null)
  /** Alert row click: alerts are always on my own PRs, so cross to Mine and pulse. */
  const jumpToAlert = (url: string): void => {
    setScope('mine')
    setJump((prev) => ({ url, n: (prev?.n ?? 0) + 1 }))
  }
  const markAllRead = (): void => {
    void window.revva.github.markAlertsSeen()
    void qc.invalidateQueries({ queryKey: ['gh-prs'] })
    void qc.invalidateQueries({ queryKey: ['gh-alerts'] })
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1600px] space-y-4 px-6 py-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Github className="size-5" /> Pull requests
            </h2>
            <p className="text-xs text-muted-foreground">
              via your gh CLI · multi-repo · review = a fresh read-only agent session on the PR head
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Tabs value={scope} onValueChange={(v) => setScope(v === 'review' ? 'review' : 'mine')}>
              <TabsList>
                <TabsTrigger value="mine">Mine</TabsTrigger>
                <TabsTrigger value="review">Needs review</TabsTrigger>
              </TabsList>
            </Tabs>
            {alerts.length > 0 && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={markAllRead}>
                <Check className="size-4" />
                Mark all read
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={prs.isFetching} onClick={() => prs.refetch()}>
              <RefreshCw className={cn('size-4', prs.isFetching && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {alerts.length > 0 && !prs.isLoading && (
          <div role="region" aria-label="Unseen PR updates" className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06]">
            <div className="flex items-center justify-between gap-3 px-3 pt-2.5 pb-1">
              <p className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                <Bell className="size-3.5" />
                {alerts.length} unseen update{alerts.length > 1 ? 's' : ''}
              </p>
              <Button size="xs" variant="ghost" className="h-6 text-[11px] text-muted-foreground" onClick={markAllRead}>
                <Check className="size-3" /> Mark all read
              </Button>
            </div>
            <ul className="px-1.5 pb-1.5">
              {alerts.map((a) => (
                <li key={a.url}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-amber-500/10"
                    onClick={() => jumpToAlert(a.url)}
                  >
                    <span className="flex shrink-0 items-center gap-0.5">
                      {a.kinds.includes('conflict') && <AlertTriangle className="size-3.5 text-red-500" />}
                      {a.kinds.includes('approval') && <Check className="size-3.5 text-green-600 dark:text-green-400" />}
                      {a.kinds.includes('comment') && <MessageSquareDot className="size-3.5 text-muted-foreground" />}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {a.repo}#{a.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{a.title}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{a.kinds.join(' · ')} →</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {prs.isLoading && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] items-stretch gap-2.5">
            {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-32" />)}
          </div>
        )}
        {prs.error instanceof Error && (
          <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {prs.error.message}
          </p>
        )}
        {review.error instanceof Error && (
          <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {review.error.message}
          </p>
        )}
        {actionError && (
          <p role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            <span>{actionError}</span>
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setActionError(null)}>
              <X className="size-3" />
            </Button>
          </p>
        )}
        {!prs.isLoading && visible.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">No open PRs here.</p>
        )}

        {!prs.isLoading && visible.length > 0 && (
          <PrBoard
            visible={visible}
            busyUrl={busyUrl}
            scope={scope}
            mergingUrl={merge.isPending ? (merge.variables?.prUrl ?? null) : null}
            rebasingUrl={rebase.isPending ? rebase.variables : null}
            solvingUrl={solveConflicts.isPending ? solveConflicts.variables : null}
            reviewing={review.isPending}
            onMarkSeen={(url) => {
              void window.revva.github.markSeen(url)
              void qc.invalidateQueries({ queryKey: ['gh-prs'] })
              void qc.invalidateQueries({ queryKey: ['gh-alerts'] })
            }}
            onMerge={(method, url) => merge.mutate({ prUrl: url, method })}
            onRebase={(url) => rebase.mutate(url)}
            onSolve={(url) => {
              setActionError(null)
              solveConflicts.mutate(url)
            }}
            onReview={(url) => {
              setBusyUrl(url)
              void window.revva.github.markSeen(url)
              review.mutate(url, { onSettled: () => setBusyUrl(null) })
            }}
            onOpenChat={onOpenChat}
            onChat={startChat}
            jump={jump}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Three drag-and-drop zones for PRs: Important (pinned), the main list, and a
 * collapsible "Not right now" shelf for PRs you're deliberately ignoring.
 */
function PrBoard({
  visible,
  busyUrl,
  scope,
  mergingUrl,
  rebasingUrl,
  solvingUrl,
  reviewing,
  onMarkSeen,
  onMerge,
  onRebase,
  onSolve,
  onReview,
  onOpenChat,
  onChat,
  jump
}: {
  visible: PullRequest[]
  busyUrl: string | null
  scope: 'mine' | 'review'
  mergingUrl: string | null
  rebasingUrl: string | null
  solvingUrl: string | null
  reviewing: boolean
  onMarkSeen: (url: string) => void
  onMerge: (method: PrMergeMethod, url: string) => void
  onRebase: (url: string) => void
  onSolve: (url: string) => void
  onReview: (url: string) => void
  onOpenChat: (sessionId: string) => void
  onChat: (url: string) => void
  /** Set by the alert strip; every new object scrolls to and pulses that card. */
  jump: { url: string; n: number } | null
}): React.JSX.Element {
  const liveIds = useMemo(() => visible.map((pr) => pr.url), [visible])
  const { zones, commit } = useCardOrder('gh', liveIds)
  const [laterOpen, setLaterOpen] = useState(false)
  const byUrl = useMemo(() => new Map(visible.map((pr) => [pr.url, pr])), [visible])
  /**
   * Stack chain per PR: every visible layer of one stack resolves to
   * `${repo}@<branch closest to trunk>`, so the trunk-based base PR and the
   * layers above it share a key and light up together on hover. Plain PRs key
   * to their own url (a chain of one, never highlighted). A layer missing from
   * the visible set splits the chain — there is nothing to bridge across.
   */
  const chains = useMemo(() => {
    const byHead = new Map<string, PullRequest>()
    for (const pr of visible) if (pr.headRefName) byHead.set(`${pr.repo}:${pr.headRefName}`, pr)
    const downLayer = new Set(visible.filter((p) => p.baseRefName).map((p) => `${p.repo}:${p.baseRefName}`))
    /** Branch names from this PR's base down to the trunk; unknown hops count as one. */
    const branchPath = (pr: PullRequest): string[] => {
      const path: string[] = []
      let branch = pr.baseRefName
      const seen = new Set<string>()
      while (branch && branch !== pr.defaultBranch && !seen.has(branch)) {
        seen.add(branch)
        path.push(branch)
        branch = byHead.get(`${pr.repo}:${branch}`)?.baseRefName
      }
      return path
    }
    const keys = new Map<string, string>()
    for (const pr of visible) {
      const stacked = !!pr.baseRefName && !!pr.defaultBranch && pr.baseRefName !== pr.defaultBranch
      if (!stacked && !(pr.headRefName && downLayer.has(`${pr.repo}:${pr.headRefName}`))) {
        keys.set(pr.url, pr.url)
        continue
      }
      const path = branchPath(pr)
      // Anchor on the lowest branch of the path (= the base PR's head branch),
      // so the trunk-based base PR and every layer above it share one key.
      keys.set(pr.url, `${pr.repo}@${path.length ? path[path.length - 1] : (pr.headRefName ?? pr.url)}`)
    }
    return keys
  }, [visible])
  const [hoveredChain, setHoveredChain] = useState<string | null>(null)
  /** Alert-strip click: scroll to this card and pulse it so it's found. */
  const [flashUrl, setFlashUrl] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const jumpToCard = (url: string): void => {
    if (zones.later.includes(url)) setLaterOpen(true)
    const scroll = (tries: number): void => {
      const el = document.querySelector(`[data-pr-url="${CSS.escape(url)}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Scope switches re-fetch first — retry while the new list lands.
      else if (tries > 0) setTimeout(() => scroll(tries - 1), 350)
    }
    requestAnimationFrame(() => scroll(6))
    clearTimeout(flashTimer.current)
    setFlashUrl(url)
    flashTimer.current = setTimeout(() => setFlashUrl(null), 2200)
  }
  useEffect(() => {
    if (jump) jumpToCard(jump.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump])

  const renderCard = (url: string): React.ReactNode => {
    const pr = byUrl.get(url)
    if (!pr) return null
    const zone: 'important' | 'main' | 'later' = zones.important.includes(url)
      ? 'important'
      : zones.later.includes(url)
        ? 'later'
        : 'main'
    return (
      <PrCard
        pr={pr}
        zone={zone}
        busy={busyUrl === url}
        merging={mergingUrl === url}
        rebasing={rebasingUrl === url}
        solving={solvingUrl === url}
        reviewing={reviewing}
        chainKey={chains.get(url)}
        chainHighlighted={!!chains.get(url) && chains.get(url) !== url && hoveredChain === chains.get(url)}
        onChainHover={setHoveredChain}
        onMarkSeen={() => onMarkSeen(url)}
        onMerge={(method) => onMerge(method, url)}
        onRebase={() => onRebase(url)}
        onSolve={() => onSolve(url)}
        onReview={() => onReview(url)}
        onMove={(to) => commit(moveToZone(zones, url, to))}
        onChat={() => onChat(url)}
        onOpenChat={onOpenChat}
        flash={flashUrl === url}
      />
    )
  }

  return (
    <CardBoard zones={zones} onReorder={commit} renderCard={renderCard}>
      {zones.important.length > 0 && (
        <section aria-label="Important pull requests" className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-600 dark:text-amber-400">
            <Pin className="size-3.5" /> Important
          </h3>
          <CardZone id="important" />
        </section>
      )}

      <CardZone id="main" emptyHint="Nothing here right now — drag a card back, or un-park it below." />

      <section aria-label="Not right now" className="pt-1">
        <button
          type="button"
          onClick={() => setLaterOpen((v) => !v)}
          aria-expanded={laterOpen}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', !laterOpen && '-rotate-90')} />
          Not right now
          <Badge variant="secondary" className="text-[10px]">
            {zones.later.length}
          </Badge>
          <span className="ml-auto text-[11px] font-normal text-muted-foreground/70">
            {laterOpen ? 'Collapse' : 'Expand'}
          </span>
        </button>
        <CardZone
          id="later"
          collapsed={!laterOpen}
          emptyHint="Drop PRs here to get them out of the way."
          collapsedContent={
            <div className="col-span-full flex h-7 items-center justify-center rounded border border-dashed border-border/60 text-[10px] text-muted-foreground/60">
              {zones.later.length ? `${zones.later.length} parked — drop here to add` : 'Drop PRs here to park them'}
            </div>
          }
        />
      </section>
    </CardBoard>
  )
}

/** Compact PR card: fits the 3-across minmax grid, zone-aware actions. */
function PrCard({
  pr,
  zone,
  busy,
  merging,
  rebasing,
  solving,
  reviewing,
  chainKey,
  chainHighlighted,
  onChainHover,
  onMarkSeen,
  onMerge,
  onRebase,
  onSolve,
  onReview,
  onMove,
  onChat,
  onOpenChat,
  flash
}: {
  pr: PullRequest
  zone: 'important' | 'main' | 'later'
  busy: boolean
  merging: boolean
  rebasing: boolean
  solving: boolean
  reviewing: boolean
  /** Stack chain identity (repo + root branch); equals the PR's own url when unstacked. */
  chainKey?: string
  /** Another card of the same chain is hovered — light this one up. */
  chainHighlighted: boolean
  onChainHover: (chain: string | null) => void
  onMarkSeen: () => void
  onMerge: (method: PrMergeMethod) => void
  onRebase: () => void
  onSolve: () => void
  onReview: () => void
  onMove: (to: 'important' | 'main' | 'later') => void
  onChat: () => void
  onOpenChat: (sessionId: string) => void
  /** Alert-strip jump landed on this card — pulse it. */
  flash: boolean
}): React.JSX.Element {
  const unseen = pr.hasNewComments || pr.hasNewConflicts || pr.hasNewApproval
  // gh only lists open PRs; a closed row can only come from a stale cache.
  const open = pr.state.toLowerCase() === 'open'
  // Based on something other than the repo's default branch → a layer of a stack.
  const stacked = !!pr.baseRefName && !!pr.defaultBranch && pr.baseRefName !== pr.defaultBranch
  const [infoOpen, setInfoOpen] = useState(false)
  return (
    <div
      data-pr-url={pr.url}
      className={cn('relative flex h-full flex-col transition-shadow', flash && 'z-10')}
      onMouseEnter={() => onChainHover(chainKey ?? null)}
      onMouseLeave={() => onChainHover(null)}
    >
      <div
        className={cn(
          'relative flex min-h-0 flex-1 flex-col gap-1.5 rounded-lg border bg-card p-2.5 transition-colors',
          unseen && !busy && 'border-primary/40 bg-primary/[0.04]',
          zone === 'important' && 'border-amber-500/40 bg-amber-500/[0.04]',
          zone === 'later' && 'opacity-80',
          chainHighlighted && 'border-violet-500/50 ring-1 ring-violet-500/30',
          flash && 'border-amber-500/70 ring-2 ring-amber-500/40 animate-pulse'
        )}
      >
      <div className="min-w-0 pr-5">
        <button
          type="button"
          title="PR details"
          onClick={() => setInfoOpen(true)}
          className="line-clamp-2 text-left text-[13px] font-medium leading-snug hover:underline"
        >
          {pr.title}
        </button>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
          {pr.repo}#{pr.number} ·{' '}
          {pr.hasNewComments && pr.latestOtherCommentAt
            ? `comment ${timeAgo(pr.latestOtherCommentAt)}`
            : timeAgo(pr.updatedAt)}
          {typeof pr.commentsCount === 'number' && pr.commentsCount > 0
            ? ` · ${pr.commentsCount} comment${pr.commentsCount > 1 ? 's' : ''}`
            : ''}
        </p>
      </div>

      <div className="flex min-h-4 flex-wrap items-center gap-1">
        {unseen && (
          <Badge variant="secondary" className="shrink-0 border-transparent bg-primary/15 text-[9px] text-primary">
            new
          </Badge>
        )}
        {pr.isDraft && <Badge variant="outline" className="shrink-0 text-[9px]">draft</Badge>}
        {stacked && (
          <Badge variant="outline" className="shrink-0 gap-0.5 border-violet-500/40 text-[9px] text-violet-600 dark:text-violet-400" title={`Stacked on ${pr.baseRefName} — merge the PR below first`}>
            <Layers className="size-2.5" />
            <span className="max-w-28 truncate">on {pr.baseRefName}</span>
          </Badge>
        )}
        <ReviewBadge pr={pr} />
        {pr.mergeable === 'CONFLICTING' && !pr.merged && (
          <Badge variant="secondary" className="shrink-0 gap-0.5 border-transparent bg-red-500/15 text-[9px] text-red-500">
            <AlertTriangle className="size-2.5" />
            conflicts
          </Badge>
        )}
        {pr.hasNewApproval && (
          <Badge variant="secondary" className="shrink-0 gap-0.5 border-transparent bg-green-500/15 text-[9px] text-green-600 dark:text-green-400">
            <Check className="size-2.5" /> approved
          </Badge>
        )}
        {pr.hasNewComments && pr.latestOtherCommentAuthor && (
          <Badge variant="secondary" className="shrink-0 gap-0.5 text-[9px]">
            <MessageSquareDot className="size-2.5" />
            {pr.latestOtherCommentAuthor}
          </Badge>
        )}
      </div>

      <div className="mt-auto space-y-1.5 border-t pt-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-full gap-1.5 border-primary/40 text-xs hover:border-primary/70"
          disabled={busy}
          onClick={onChat}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareText className="size-3.5" />}
          {busy ? 'Opening chat…' : 'Chat with this PR'}
        </Button>
        <div className="flex flex-wrap items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-1.5 text-muted-foreground"
              title={zone === 'important' ? 'Unpin' : 'Pin to Important'}
              onClick={() => onMove(zone === 'important' ? 'main' : 'important')}
            >
              {zone === 'important' ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{zone === 'important' ? 'Unpin' : 'Pin to Important'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-1.5 text-muted-foreground"
              title={zone === 'later' ? 'Back to the list' : 'Not right now'}
              onClick={() => onMove(zone === 'later' ? 'main' : 'later')}
            >
              {zone === 'later' ? <CornerUpLeft className="size-3.5" /> : <Clock4 className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{zone === 'later' ? 'Back to the list' : 'Not right now'}</TooltipContent>
        </Tooltip>
        {unseen && (
          <Button size="xs" variant="ghost" className="h-6 text-[11px] text-muted-foreground" onClick={onMarkSeen}>
            Read
          </Button>
        )}
        {open && (
          <PrActions
            pr={pr}
            merging={merging}
            rebasing={rebasing}
            solving={solving}
            reviewing={busy || reviewing}
            onMerge={onMerge}
            onRebase={onRebase}
            onSolve={onSolve}
            onReview={onReview}
          />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="outline"
              className="ml-auto"
              title="Open on GitHub"
              onClick={() => void window.revva.shell.openExternal(pr.url)}
            >
              <ExternalLink className="size-3" />
              <span className="sr-only">Open on GitHub</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open on GitHub</TooltipContent>
        </Tooltip>
        </div>
      </div>
      </div>
      <PrInfoDialog pr={pr} open={infoOpen} onClose={() => setInfoOpen(false)} onOpenChat={onOpenChat} />
    </div>
  )
}

/**
 * PR actions, one solid primary per card — whatever unblocks this PR right now:
 * Solve conflicts (conflicting), Rebase (behind base), Review (awaiting review —
 * nothing else to do here), Merge (approved + clean; method menu, GitHub still
 * enforces branch protection and its refusal is shown verbatim). A PR that
 * cannot merge (draft, changes requested, blocked by protection) gets no merge
 * button; the badge says why. Review/Rebase/Mark read are quiet ghosts.
 */
function PrActions({
  pr,
  merging,
  rebasing,
  solving,
  reviewing,
  onMerge,
  onRebase,
  onSolve,
  onReview
}: {
  pr: PullRequest
  merging: boolean
  rebasing: boolean
  solving: boolean
  reviewing: boolean
  onMerge: (method: PrMergeMethod) => void
  onRebase: () => void
  onSolve: () => void
  onReview: () => void
}): React.JSX.Element {
  const conflicting = pr.mergeable === 'CONFLICTING'
  const behind = !conflicting && pr.mergeStateStatus === 'BEHIND'
  const awaitingReview = !conflicting && !behind && pr.reviewDecision === 'REVIEW_REQUIRED'
  const canMerge =
    !conflicting &&
    !behind &&
    !pr.isDraft &&
    pr.reviewDecision !== 'CHANGES_REQUESTED' &&
    pr.reviewDecision !== 'REVIEW_REQUIRED' &&
    pr.mergeStateStatus !== 'BLOCKED'
  const reviewBtn = (
    <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[11px] text-muted-foreground" disabled={reviewing} onClick={onReview}>
      <ScanEye className="size-3.5" />
      {reviewing ? 'Preparing…' : 'Review'}
    </Button>
  )
  return (
    <>
      {conflicting && (
        <Button size="sm" disabled={solving} onClick={onSolve} className="h-6 gap-1 px-2 text-[11px]">
          <AlertTriangle className="size-3.5" />
          {solving ? 'Preparing…' : 'Solve conflicts'}
        </Button>
      )}
      {behind && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" disabled={rebasing} onClick={onRebase} className="h-6 gap-1 px-2 text-[11px]">
              <Undo2 className="size-3.5" />
              {rebasing ? 'Rebasing…' : 'Rebase'}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Branch is behind its base — rebase the PR head onto it and push (force-with-lease)</TooltipContent>
        </Tooltip>
      )}
      {awaitingReview && (
        <Button size="sm" disabled={reviewing} onClick={onReview} className="h-6 gap-1 px-2 text-[11px]">
          <ScanEye className="size-3.5" />
          {reviewing ? 'Preparing…' : 'Review'}
        </Button>
      )}
      {canMerge && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" disabled={merging} className="h-6 gap-1 px-2 text-[11px]">
              <GitMerge className="size-3.5" />
              {merging ? 'Merging…' : 'Merge'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onMerge('squash')}>Squash and merge</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onMerge('merge')}>Create a merge commit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onMerge('rebase')}>Rebase and merge</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {pr.reviewDecision === 'APPROVED' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex size-6 items-center justify-center text-green-600 dark:text-green-400" aria-label="Review approved">
              <Check className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Review approved</TooltipContent>
        </Tooltip>
      )}
      {pr.mergeStateStatus === 'BLOCKED' && !conflicting && !behind && pr.reviewDecision !== 'CHANGES_REQUESTED' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex size-6 items-center justify-center text-red-500" aria-label="Merge blocked">
              <AlertTriangle className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Branch protection or checks still block the merge</TooltipContent>
        </Tooltip>
      )}
      {!conflicting && !behind && !awaitingReview && reviewBtn}
    </>
  )
}

/** "Accepted or not": merged / approved / changes-requested / awaiting review. */
function ReviewBadge({ pr }: { pr: PullRequest }): React.JSX.Element | null {
  if (pr.merged)
    return (
      <Badge variant="secondary" className="gap-1 border-transparent bg-violet-500/15 text-[10px] text-violet-500">
        merged
      </Badge>
    )
  if (pr.reviewDecision === 'APPROVED')
    return (
      <Badge variant="secondary" className="gap-1 border-transparent bg-green-500/15 text-[10px] text-green-600 dark:text-green-400">
        <Check className="size-3" /> approved
      </Badge>
    )
  if (pr.reviewDecision === 'CHANGES_REQUESTED')
    return (
      <Badge variant="secondary" className="gap-1 border-transparent bg-red-500/15 text-[10px] text-red-500">
        <X className="size-3" /> changes requested
      </Badge>
    )
  if (pr.reviewDecision === 'REVIEW_REQUIRED')
    return (
      <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
        <CircleDot className="size-3" /> awaiting review
      </Badge>
    )
  return null
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
