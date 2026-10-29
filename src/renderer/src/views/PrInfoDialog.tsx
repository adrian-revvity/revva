/**
 * PR info dialog, opened by clicking a card's title: the PR's live detail in
 * one place — branches, review state, body — plus chats already linked to it.
 * "Chat with this PR" starts a new session linked to the PR and its ticket.
 * Nothing here opens github.com; the GitHub link is an explicit icon.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Layers, Loader2, MessageSquareText, ScanEye } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import type { PullRequest } from '@shared/types'
import { prGate, statusLine } from './PrConversationActions'

export function PrInfoDialog({
  pr,
  open,
  onClose,
  onOpenChat
}: {
  pr: PullRequest
  open: boolean
  onClose: () => void
  onOpenChat: (sessionId: string) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const detail = useQuery({
    queryKey: ['gh-pr-detail', pr.url],
    queryFn: () => window.revva.github.detail(pr.url),
    enabled: open,
    staleTime: 30_000
  })
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list(), enabled: open })
  const linked = (chats.data ?? []).filter((c) => c.prUrl === pr.url)
  const afterSession = (sessionId: string): void => {
    void qc.invalidateQueries({ queryKey: ['chats'] })
    void qc.invalidateQueries({ queryKey: ['gh-prs'] })
    void qc.invalidateQueries({ queryKey: ['gh-alerts'] })
    onClose()
    onOpenChat(sessionId)
  }
  const startChat = useMutation({
    mutationFn: () => window.revva.github.chat(pr.url),
    onSuccess: (res) => afterSession(res.sessionId)
  })
  const startReview = useMutation({
    mutationFn: () => window.revva.github.review(pr.url),
    onSuccess: (res) => afterSession(res.sessionId)
  })
  const data = detail.data
  const gate = data ? prGate(data) : undefined
  const busy = startChat.isPending || startReview.isPending
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="pr-6 text-[15px] leading-snug">{data?.title ?? pr.title}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-1.5 font-mono text-[11px]">
            <span>
              {pr.repo}#{pr.number}
              {data ? ` · ${statusLine(data)}` : ''}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-0.5 underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
              title="Open this PR on GitHub"
              onClick={() => void window.revva.shell.openExternal(pr.url)}
            >
              GitHub <ExternalLink className="size-3" />
            </button>
          </DialogDescription>
        </DialogHeader>

        {detail.isLoading && <Skeleton className="h-10 w-full" />}
        {detail.error instanceof Error && (
          <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {detail.error.message}
          </p>
        )}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="gap-1 font-mono text-[10px]">
                {data.headRefName}
                <span className="text-muted-foreground/60">→</span>
                {data.baseRefName}
              </Badge>
              {pr.defaultBranch && data.baseRefName !== pr.defaultBranch && (
                <Badge variant="outline" className="gap-0.5 border-violet-500/40 text-[10px] text-violet-600 dark:text-violet-400">
                  <Layers className="size-2.5" /> stack layer onto {data.baseRefName}
                </Badge>
              )}
              {data.isDraft && <Badge variant="outline" className="text-[10px]">draft</Badge>}
              {data.mergeable === 'CONFLICTING' && (
                <Badge variant="outline" className="border-red-500/40 text-[10px] text-red-500">conflicting</Badge>
              )}
              {gate?.behind && <Badge variant="outline" className="text-[10px]">behind base</Badge>}
              {data.reviewDecision && (
                <Badge variant="outline" className="text-[10px]">
                  {data.reviewDecision.replace(/_/g, ' ').toLowerCase()}
                </Badge>
              )}
            </div>

            {data.body && (
              <div
                className="line-clamp-6 rounded-md border bg-muted/30 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-[11px] [&_ul]:list-disc [&_ul]:pl-4"
                title="Full description lives on GitHub"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.body}</ReactMarkdown>
              </div>
            )}

            {linked.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground">Chats on this PR</p>
                {linked.map((c) => (
                  <button
                    key={c.sessionId}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={() => {
                      onClose()
                      onOpenChat(c.sessionId)
                    }}
                  >
                    <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {new Date(c.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-2">
              {startChat.error && (
                <p role="alert" className="text-xs text-destructive">{startChat.error.message}</p>
              )}
              {startReview.error && (
                <p role="alert" className="text-xs text-destructive">{startReview.error.message}</p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="flex-1 gap-1.5"
                  disabled={busy || !gate?.open}
                  title={gate?.open ? 'A new chat linked to this PR and its ticket' : 'PR is not open'}
                  onClick={() => startChat.mutate()}
                >
                  {startChat.isPending ? <Loader2 className="size-4 animate-spin" /> : <MessageSquareText className="size-4" />}
                  {startChat.isPending ? 'Checking out the PR…' : 'Chat with this PR'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={busy || !gate?.open}
                  title={gate?.open ? 'Read-only review agent session' : 'PR is not open'}
                  onClick={() => startReview.mutate()}
                >
                  {startReview.isPending ? <Loader2 className="size-4 animate-spin" /> : <ScanEye className="size-4" />}
                  Review session
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                The chat links this PR{data.reviewDecision ? ` (${data.reviewDecision.toLowerCase().replace(/_/g, ' ')})` : ''} and its ticket, and opens in the
                branch's worktree when it exists — never in a browser tab.
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
