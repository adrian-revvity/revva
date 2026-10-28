import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleDot, ExternalLink, MessageSquareDot, RefreshCw, ScanEye, Github, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { PullRequest } from '@shared/types'

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
  const prs = useQuery({
    queryKey: ['gh-prs', scope],
    queryFn: () => window.revva.github.list(scope),
    staleTime: 30_000
  })
  const review = useMutation({
    mutationFn: (prUrl: string) => window.revva.github.review(prUrl),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['chats'] })
      void qc.invalidateQueries({ queryKey: ['gh-prs'] })
      onOpenChat(res.sessionId)
    }
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
        {prs.data?.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">No open PRs here.</p>
        )}

        {prs.data?.map((pr: PullRequest) => (
          <div
            key={pr.url}
            className={cn(
              'flex items-center gap-3 rounded-lg border p-3',
              pr.hasNewComments && 'border-primary/50 bg-primary/5'
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
            {pr.hasNewComments && (
              <Button
                size="sm"
                variant="ghost"
                title="Mark comments as seen"
                onClick={() => {
                  void window.revva.github.markSeen(pr.url)
                  void qc.invalidateQueries({ queryKey: ['gh-prs'] })
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
          </div>
        ))}
      </div>
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
