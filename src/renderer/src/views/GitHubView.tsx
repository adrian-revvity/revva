import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  CircleDot,
  ExternalLink,
  GitMerge,
  MessageSquareDot,
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
import { cn } from '@/lib/utils'
import type { PrAlert, PrMergeMethod, PullRequest } from '@shared/types'

/** Unseen PR events (comments/conflicts/approvals) — sidebar bell + polling feed. */
export function useGithubAlerts(): PrAlert[] {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['gh-alerts'], queryFn: () => window.revva.github.alerts() })
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
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
            <Button size="sm" variant="outline" disabled={prs.isFetching} onClick={() => prs.refetch()}>
              <RefreshCw className={cn('size-4', prs.isFetching && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {prs.isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}
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
        {prs.data?.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">No open PRs here.</p>
        )}

        {prs.data?.map((pr: PullRequest) => {
          const unseen = pr.hasNewComments || pr.hasNewConflicts || pr.hasNewApproval
          const conflicting = !pr.merged && pr.mergeable === 'CONFLICTING'
          return (
            <div
              key={pr.url}
              className={cn(
                'flex items-center gap-3 rounded-lg border p-3',
                unseen && 'border-primary/50 bg-primary/5'
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-sm font-medium hover:underline"
                  >
                    {pr.title}
                    <ExternalLink className="ml-1 inline size-3 opacity-60" />
                  </a>
                  {pr.isDraft && <Badge variant="outline" className="text-[10px]">draft</Badge>}
                  <ReviewBadge pr={pr} />
                  {conflicting && (
                    <Badge variant="secondary" className="gap-1 border-transparent bg-red-500/15 text-[10px] text-red-500">
                      <AlertTriangle className="size-3" />
                      {pr.hasNewConflicts ? 'new conflicts' : 'conflicts'}
                    </Badge>
                  )}
                  {pr.hasNewApproval && (
                    <Badge variant="secondary" className="gap-1 border-transparent bg-green-500/15 text-[10px] text-green-600 dark:text-green-400">
                      <Check className="size-3" /> just approved
                    </Badge>
                  )}
                  {pr.hasNewComments && (
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <MessageSquareDot className="size-3" />
                      new comment{pr.latestOtherCommentAuthor ? ` · ${pr.latestOtherCommentAuthor}` : ''}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {pr.repo}#{pr.number} ·{' '}
                  {pr.hasNewComments && pr.latestOtherCommentAt
                    ? `comment ${timeAgo(pr.latestOtherCommentAt)}`
                    : timeAgo(pr.updatedAt)}
                  {typeof pr.commentsCount === 'number' && pr.commentsCount > 0
                    ? ` · ${pr.commentsCount} comment${pr.commentsCount > 1 ? 's' : ''}`
                    : ''}
                </p>
              </div>
              {unseen && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="Mark as seen"
                  onClick={() => {
                    void window.revva.github.markSeen(pr.url)
                    void qc.invalidateQueries({ queryKey: ['gh-prs'] })
                    void qc.invalidateQueries({ queryKey: ['gh-alerts'] })
                  }}
                >
                  <Check className="size-4" />
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busyUrl === pr.url || review.isPending}
                onClick={() => {
                  setBusyUrl(pr.url)
                  void window.revva.github.markSeen(pr.url)
                  review.mutate(pr.url, { onSettled: () => setBusyUrl(null) })
                }}
              >
                <ScanEye className="size-4" />
                {busyUrl === pr.url ? 'Preparing…' : 'Review'}
              </Button>
              {pr.state === 'open' && !pr.merged && (
                <PrActions
                  pr={pr}
                  merging={merge.isPending && merge.variables?.prUrl === pr.url}
                  rebasing={rebase.isPending && rebase.variables === pr.url}
                  onMerge={(method) => merge.mutate({ prUrl: pr.url, method })}
                  onRebase={() => rebase.mutate(pr.url)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Direct PR actions: Merge (method menu; GitHub itself still enforces approvals,
 * checks and branch protection — its refusal is shown verbatim) and Rebase
 * (head onto base in a throwaway worktree, pushed with force-with-lease).
 */
function PrActions({
  pr,
  merging,
  rebasing,
  onMerge,
  onRebase
}: {
  pr: PullRequest
  merging: boolean
  rebasing: boolean
  onMerge: (method: PrMergeMethod) => void
  onRebase: () => void
}): React.JSX.Element {
  const mergeBlocked = pr.isDraft
    ? 'Draft PRs cannot be merged — mark it ready on GitHub first.'
    : pr.mergeable === 'CONFLICTING'
      ? 'This PR has conflicts — rebase it first.'
      : pr.reviewDecision === 'CHANGES_REQUESTED'
        ? 'Reviewers requested changes.'
        : pr.mergeStateStatus === 'BEHIND'
          ? 'Branch is behind base — rebase first.'
          : undefined
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="outline" disabled={rebasing} onClick={onRebase}>
            <Undo2 className="size-4" />
            {rebasing ? 'Rebasing…' : 'Rebase'}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Rebase the PR head onto its base branch and push the update (force-with-lease)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={merging || mergeBlocked !== undefined}>
                  <GitMerge className="size-4" />
                  {merging ? 'Merging…' : 'Merge'}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onMerge('squash')}>Squash and merge</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMerge('merge')}>Create a merge commit</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMerge('rebase')}>Rebase and merge</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </TooltipTrigger>
        {mergeBlocked && <TooltipContent>{mergeBlocked}</TooltipContent>}
      </Tooltip>
    </div>
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
