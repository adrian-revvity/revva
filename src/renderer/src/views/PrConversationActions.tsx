/**
 * PR + review actions for conversations that link a PR or a ticket work.
 * A chat started from a GitHub card (review / conflicts) or attached to a
 * ticket shows the same menu here that the PR card in the GitHub tab has,
 * so the conversation is never cut off from the PR it is about. When the
 * conversation belongs to a ticket run, the ship actions (push, AI description,
 * re-run review) live here too — one dropdown for everything the PR can do.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ExternalLink, FilePenLine, GitMerge, Github, Layers, Rocket, ScanEye, Undo2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import type { PrDetail, PrMergeMethod, WorkSummary } from '@shared/types'
import { ReviewRerunButton } from './ReviewPanel'
import { ShipDialog, shipBlockReason } from './ShipPanel'

/** Same gating rules as the GitHub tab's card buttons (see PrActions there). */
export function prGate(pr: PrDetail): { conflicting: boolean; behind: boolean; canMerge: boolean; open: boolean } {
  const conflicting = pr.mergeable === 'CONFLICTING'
  const behind = !conflicting && pr.mergeStateStatus === 'BEHIND'
  const open = pr.state.toLowerCase() === 'open'
  const canMerge =
    open &&
    !conflicting &&
    !behind &&
    !pr.isDraft &&
    pr.reviewDecision !== 'CHANGES_REQUESTED' &&
    pr.reviewDecision !== 'REVIEW_REQUIRED' &&
    pr.mergeStateStatus !== 'BLOCKED'
  return { conflicting, behind, canMerge, open }
}

export function statusLine(pr: PrDetail): string {
  const gate = prGate(pr)
  if (!gate.open) return pr.state.toLowerCase()
  if (gate.conflicting) return 'has conflicts'
  if (pr.isDraft) return 'draft'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested'
  if (gate.behind) return 'behind base'
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'awaiting review'
  if (pr.mergeStateStatus === 'BLOCKED') return 'blocked'
  if (pr.reviewDecision === 'APPROVED') return 'approved'
  return 'open'
}

function descriptionRequest(prUrl: string): string {
  return [
    `Please update the PR description for ${prUrl} to reflect the latest changes.`,
    'Read the current description, commits, and diff with gh before editing.',
    'Preserve existing user-written content. If the body has Revva markers (`<!-- revva:description:start -->` and `<!-- revva:description:end -->`), replace only the content between them and leave everything outside untouched.',
    `Save the updated description with \`gh pr edit ${prUrl} --body ...\`. Do not change code or push commits. Then briefly summarize what you changed.`
  ].join('\n\n')
}

/**
 * Header dropdown with the linked PR's live state and every PR action.
 * `onOpenChat` navigates to the session Review / Solve conflicts creates.
 * `work` adds the ticket-run actions: push through the ship flow, re-run
 * review, and a request for the current agent to update the description.
 */
export function PrMenu({
  prUrl,
  directory,
  work,
  onOpenChat,
  onAskAgent
}: {
  prUrl: string
  /** The conversation's own checkout — enables "Push commits from this chat". */
  directory?: string
  work?: WorkSummary
  onOpenChat?: (sessionId: string) => void
  /** Send a request to the conversation that owns this menu. */
  onAskAgent: (text: string) => Promise<void>
}): React.JSX.Element {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [shipOpen, setShipOpen] = useState(false)
  const pr = useQuery({
    queryKey: ['gh-pr-detail', prUrl],
    queryFn: () => window.revva.github.detail(prUrl),
    staleTime: 30_000,
    refetchInterval: 90_000
  })
  // Stack detection shells out per candidate checkout — only while the menu is open.
  const stack = useQuery({
    queryKey: ['gh-pr-stack', prUrl, directory ?? null],
    queryFn: () => window.revva.github.stack(prUrl, directory),
    enabled: open,
    staleTime: 30_000
  })
  const refreshPr = (): void => {
    void qc.invalidateQueries({ queryKey: ['gh-pr-detail', prUrl] })
    void qc.invalidateQueries({ queryKey: ['gh-prs'] })
    void qc.invalidateQueries({ queryKey: ['gh-alerts'] })
    void qc.invalidateQueries({ queryKey: ['works'] })
  }
  const startSession = (kind: 'review' | 'solve'): void => {
    setBusy(kind)
    setError(null)
    void (kind === 'review'
      ? Promise.resolve(window.revva.github.markSeen(prUrl)).then(() => window.revva.github.review(prUrl))
      : window.revva.github.solveConflicts(prUrl)
    )
      .then((res) => {
        void qc.invalidateQueries({ queryKey: ['chats'] })
        refreshPr()
        onOpenChat?.(res.sessionId)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null))
  }
  const run = (label: string, action: () => Promise<unknown>): void => {
    setBusy(label)
    setError(null)
    setDone(null)
    void action()
      .then((res) => {
        if (typeof res === 'string') setDone(res)
        refreshPr()
        void qc.invalidateQueries({ queryKey: ['gh-pr-stack', prUrl] })
        if (work) void qc.invalidateQueries({ queryKey: ['reviews', work.id] })
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null))
  }
  const data = pr.data
  const gate = data ? prGate(data) : undefined
  const merge = (method: PrMergeMethod): void => run('merge', () => window.revva.github.merge(prUrl, method))
  const canRerunReview = !!work && (work.state === 'APPROVED' || work.state === 'WAITING_HUMAN')
  const shipReason = work ? shipBlockReason(work) : undefined
  return (
    <>
      <DropdownMenu onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-[11px]">
            <Github data-icon="inline-start" />
            {data ? `PR #${data.number}` : 'PR'} <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel>
            {data ? (
              <span className="flex flex-col">
                <span className="font-mono text-[11px]">{data.repo}#{data.number}</span>
                <span className="text-[10px] font-normal text-muted-foreground">{statusLine(data)}</span>
              </span>
            ) : (
              'Loading PR…'
            )}
          </DropdownMenuLabel>
          {pr.isLoading && <Skeleton className="mx-2 h-8" />}
          {pr.error instanceof Error && <p className="px-2 py-1 text-[11px] text-destructive">{pr.error.message}</p>}
          {error && <p role="alert" className="px-2 py-1 text-[11px] text-destructive">{error}</p>}
          {done && <p className="px-2 py-1 text-[11px] text-emerald-600 dark:text-emerald-400">{done}</p>}
          {data && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={!gate?.open || busy !== null} onSelect={() => startSession('review')}>
                  <ScanEye /> {busy === 'review' ? 'Preparing review…' : 'Start review session'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!gate?.open || !gate.conflicting || busy !== null}
                  title={!gate?.conflicting ? 'Only needed when the PR has conflicts' : undefined}
                  onSelect={() => startSession('solve')}
                >
                  <AlertTriangle /> {busy === 'solve' ? 'Preparing…' : 'Solve conflicts'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!gate?.open || !gate.behind || busy !== null}
                  title={!gate?.behind ? 'Only needed when the branch is behind its base' : undefined}
                  onSelect={() => run('rebase', () => window.revva.github.rebase(prUrl))}
                >
                  <Undo2 /> {busy === 'rebase' ? 'Rebasing…' : 'Rebase onto base'}
                </DropdownMenuItem>
                {stack.data && (
                  <DropdownMenuItem
                    disabled={busy !== null}
                    title={`gh stack rebase in ${stack.data.directory} — rebases every branch of the stack onto its parent; conflicts restore the stack untouched`}
                    onSelect={() => run('stack', () => window.revva.github.stackRebase(prUrl, stack.data!.directory))}
                  >
                    <Layers /> {busy === 'stack' ? 'Rebasing stack…' : `Rebase stack${stack.data.branches.length > 1 ? ` (${stack.data.branches.filter((b) => !b.isMerged).length} branches)` : ''}`}
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={!directory || !gate?.open || busy !== null}
                  title={!directory ? 'Only for chats whose worktree holds the commits to push (conflict-resolution sessions)' : 'Push this conversation’s worktree commits to the PR head branch'}
                  onSelect={() => run('push', () => window.revva.github.push(prUrl, directory!))}
                >
                  <Upload /> {busy === 'push' ? 'Pushing…' : 'Push commits from this chat'}
                </DropdownMenuItem>
                {work && (
                  <DropdownMenuItem
                    disabled={!!shipReason || busy !== null}
                    title={shipReason ?? 'Run the ship pre-flight and push the ticket’s worktree to this PR'}
                    onSelect={() => setShipOpen(true)}
                  >
                    <Rocket /> Push changes from the ticket
                  </DropdownMenuItem>
                )}
                {work && canRerunReview && (
                  <DropdownMenuItem
                    disabled={busy !== null}
                    title="Start a fresh review round for this ticket"
                    onSelect={() => run('reviewRound', () => window.revva.work.reviewStart(work.id))}
                  >
                    <ScanEye /> {busy === 'reviewRound' ? 'Starting review…' : 'Re-run review'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={busy !== null}
                  title="Ask the current agent to update the PR description"
                  onSelect={() => run('description', async () => {
                    await onAskAgent(descriptionRequest(prUrl))
                    return 'Request sent to this conversation.'
                  })}
                >
                  <FilePenLine /> {busy === 'description' ? 'Sending…' : 'Update PR description'}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {(['squash', 'merge', 'rebase'] as const).map((method) => (
                  <DropdownMenuItem
                    key={method}
                    disabled={!gate?.canMerge || busy === 'merge'}
                    title={
                      gate?.canMerge
                        ? undefined
                        : 'Draft, unreviewed, changes requested, conflicting, behind or blocked — GitHub will refuse the merge'
                    }
                    onSelect={() => merge(method)}
                  >
                    <GitMerge />
                    {busy === 'merge' ? 'Merging…' : method === 'squash' ? 'Squash and merge' : method === 'merge' ? 'Create a merge commit' : 'Rebase and merge'}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => window.open(prUrl, '_blank')}>
                <ExternalLink /> Open PR on GitHub
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {work && <ShipDialog work={work} open={shipOpen} onClose={() => setShipOpen(false)} />}
    </>
  )
}

/**
 * Actions for a chat that links a PR and/or a ticket's pipeline work:
 * the PR menu (which also carries the ticket's push/review actions) plus the
 * standalone review re-run when there is no PR to hang them on yet.
 */
export function PrConversationActions({
  prUrl,
  directory,
  work,
  onOpenChat,
  onAskAgent
}: {
  prUrl?: string
  /** The conversation's own checkout — enables "Push commits from this chat". */
  directory?: string
  work?: WorkSummary
  onOpenChat?: (sessionId: string) => void
  onAskAgent: (text: string) => Promise<void>
}): React.JSX.Element | null {
  const canReview = !!work && (work.state === 'APPROVED' || work.state === 'WAITING_HUMAN')
  if (!prUrl && !canReview) return null
  return (
    <>
      {prUrl ? (
        <PrMenu prUrl={prUrl} directory={directory} work={work} onOpenChat={onOpenChat} onAskAgent={onAskAgent} />
      ) : (
        canReview && work && <ReviewRerunButton workId={work.id} />
      )}
    </>
  )
}
