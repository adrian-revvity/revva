import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquareText, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { JiraComment, PushEvent } from '@shared/types'

/**
 * New Jira comments (M6): appears when reviewers/PMs commented on a shipped ticket
 * since revva last looked. "Tackle comments" starts a rework session on the branch.
 */
export function CommentsStrip({ workId }: { workId: string }): React.JSX.Element | null {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const comments = useQuery({ queryKey: ['comments'], queryFn: () => window.revva.comments.pending() })

  useEffect(() => {
    return window.revva.events.on((e: PushEvent) => {
      if (e.kind === 'comments') qc.setQueryData(['comments'], e.items)
    })
  }, [qc])

  const mine = (comments.data ?? []).filter((c: JiraComment) => c.workId === workId)
  if (mine.length === 0) return null

  return (
    <div className="shrink-0 space-y-1.5 border-b bg-pink-500/5 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <MessageSquareText className="size-3.5 text-pink-600 dark:text-pink-400" />
        <span className="font-medium">
          {mine.length} new Jira comment{mine.length > 1 ? 's' : ''} on {mine[0]!.ticketKey}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 px-2 text-[11px]"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            void window.revva.comments
              .tackle(workId)
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false))
          }}
        >
          <Wrench className="mr-1 size-3" />
          {busy ? 'Reworking…' : 'Tackle comments'}
        </Button>
      </div>
      {mine.slice(0, 3).map((c) => (
        <p key={c.id} className="truncate text-[11px] text-muted-foreground" title={c.body}>
          <span className="font-medium">{c.author}:</span> {c.body}
        </p>
      ))}
      {mine.length > 3 && <p className="text-[11px] text-muted-foreground">…and {mine.length - 3} more</p>}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
