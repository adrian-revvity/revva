/**
 * AI PR description dialog: generates a fresh description for the PR through the
 * OpenCode service (diff + commits + ticket context), lets the user edit it or
 * regenerate with extra instructions, then saves it as the PR body. Text the
 * user wrote outside Revva's markers is preserved; the save fails if the PR
 * moved while the dialog was open.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import type { PrDescriptionDraft } from '@shared/types'

export function PrDescribeDialog({ prUrl, onClose }: { prUrl: string; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [nonce, setNonce] = useState(0)
  const [draftInstructions, setDraftInstructions] = useState('')
  const [instructions, setInstructions] = useState('')
  const regenerate = (): void => {
    setInstructions(draftInstructions)
    setNonce((n) => n + 1)
  }
  const draft = useQuery({
    queryKey: ['pr-describe', prUrl, nonce, instructions],
    queryFn: () => window.revva.github.describe(prUrl, instructions.trim() || undefined),
    staleTime: Infinity,
    // Each dialog open writes a new draft — never reuse a stale cached one.
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: false
  })
  const save = useMutation({
    mutationFn: (body: string) => {
      if (!draft.data) throw new Error('The description is still being written.')
      return window.revva.github.describeSave(prUrl, draft.data.original, draft.data.head, body)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['gh-pr-detail', prUrl] })
      void qc.invalidateQueries({ queryKey: ['gh-prs'] })
      onClose()
    }
  })
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> AI PR description
            {draft.data?.source === 'ai' && (
              <Badge variant="outline" className="text-[10px] font-normal">{draft.data.model ?? 'AI'}</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Written from the diff and commits{draft.data?.ticketKey ? `, linked to ${draft.data.ticketKey}` : ''}. Your own text outside Revva’s section is kept.
          </DialogDescription>
        </DialogHeader>
        {draft.isFetching && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {nonce || instructions ? 'Rewriting the description…' : 'Reading the PR and writing a description…'}
          </p>
        )}
        {draft.error && (
          <div role="alert" className="space-y-2 py-2 text-sm text-destructive">
            <p>{draft.error instanceof Error ? draft.error.message : String(draft.error)}</p>
            <Button variant="outline" size="sm" onClick={regenerate}>Retry</Button>
          </div>
        )}
        {!draft.isFetching && !draft.error && draft.data && <DescribeEditor key={nonce} draft={draft.data} save={save} onClose={onClose} />}
        <div className="flex items-center gap-1.5">
          <Input
            value={draftInstructions}
            onChange={(e) => setDraftInstructions(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !draft.isFetching) {
                e.preventDefault()
                regenerate()
              }
            }}
            placeholder="Optional: what the AI should emphasise, drop, or add…"
            className="h-8 text-xs"
          />
          <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-xs" disabled={draft.isFetching} onClick={regenerate}>
            <RefreshCw className="size-3" /> Regenerate
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DescribeEditor({
  draft,
  save,
  onClose
}: {
  draft: PrDescriptionDraft
  save: ReturnType<typeof useMutation<void, Error, string>>
  onClose: () => void
}): React.JSX.Element {
  const [body, setBody] = useState(draft.proposed)
  return (
    <>
      {draft.note && (
        <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
          {draft.note}
        </p>
      )}
      <label htmlFor="pr-description" className="text-sm font-medium">PR description (Markdown)</label>
      <Textarea
        id="pr-description"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="max-h-[45vh] min-h-64 overflow-y-auto font-mono text-xs"
      />
      {save.error && <p role="alert" className="text-sm text-destructive">{save.error instanceof Error ? save.error.message : String(save.error)}</p>}
      <DialogFooter className="sm:justify-between">
        <Button variant="ghost" onClick={() => setBody(draft.proposed)} disabled={save.isPending || body === draft.proposed}>
          Restore AI draft
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate(body)} disabled={save.isPending || !body.trim()}>
            {save.isPending ? 'Saving…' : 'Save description'}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
