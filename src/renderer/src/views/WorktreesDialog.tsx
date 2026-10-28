import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, RefreshCw, Trash2 } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import type { WorktreeInfo } from '@shared/types'

/**
 * Worktree cleanup: every linked worktree across known repos, with a removal
 * that also tries to delete the branch (`branch -d` only — never unmerged work).
 */
export function WorktreesDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const worktrees = useQuery({
    queryKey: ['worktrees'],
    queryFn: () => window.revva.worktrees.list(),
    enabled: open,
    // The list is git-derived and can change from outside revva; refresh while open.
    refetchInterval: open ? 10_000 : false
  })

  const items = useMemo(() => worktrees.data ?? [], [worktrees.data])
  const keyOf = (w: WorktreeInfo): string => `${w.repoDir}\u0000${w.directory}`
  const removable = useMemo(() => items.filter((w) => !w.busy), [items])

  const toggle = (w: WorktreeInfo): void => {
    if (w.busy) return
    setSelected((old) => {
      const next = new Set(old)
      const key = keyOf(w)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const remove = useMutation({
    mutationFn: async (targets: WorktreeInfo[]) => {
      const results: string[] = []
      for (const w of targets) {
        try {
          const note = await window.revva.worktrees.remove({ repoDir: w.repoDir, directory: w.directory, force: true })
          results.push(note ?? `Removed ${w.directory}.`)
        } catch (err) {
          results.push(`Failed on ${w.directory}: ${(err as Error).message}`)
        }
      }
      return results
    },
    onMutate: () => {
      setError(null)
      setNotes([])
    },
    onSuccess: (results) => {
      setNotes(results)
      setSelected(new Set())
      void qc.invalidateQueries({ queryKey: ['worktrees'] })
      void qc.invalidateQueries({ queryKey: ['works'] })
    },
    onError: (err) => setError((err as Error).message)
  })

  const targets = items.filter((w) => selected.has(keyOf(w)))
  const allSelected = removable.length > 0 && removable.every((w) => selected.has(keyOf(w)))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4" /> Worktrees
          </DialogTitle>
          <DialogDescription>
            Linked worktrees across your repos. Removing also deletes the branch only when git
            allows it — unmerged branches are always kept.
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => worktrees.refetch()}
            disabled={worktrees.isFetching}
          >
            <RefreshCw className={cn('mr-1 size-3.5', worktrees.isFetching && 'animate-spin')} />
            Refresh
          </Button>
          {removable.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(allSelected ? new Set() : new Set(removable.map(keyOf)))}
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            className="ml-auto"
            disabled={targets.length === 0 || remove.isPending}
            onClick={() => remove.mutate(targets)}
          >
            <Trash2 className="mr-1 size-3.5" />
            {remove.isPending ? 'Removing…' : `Remove ${targets.length > 0 ? targets.length : ''}`.trim()}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {worktrees.isLoading && (
            <div className="space-y-2 p-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {!worktrees.isLoading && items.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No worktrees found in your repos.
            </p>
          )}
          {items.map((w) => {
            const key = keyOf(w)
            return (
              <label
                key={key}
                className={cn(
                  'flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-[12px] last:border-b-0 hover:bg-accent/50',
                  w.busy && 'cursor-not-allowed opacity-60',
                  selected.has(key) && 'bg-accent/40'
                )}
              >
                <input
                  type="checkbox"
                  className="size-3.5 shrink-0 accent-primary"
                  checked={selected.has(key)}
                  disabled={w.busy}
                  onChange={() => toggle(w)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono" title={w.directory}>
                    {w.directory.split('/').slice(-1)[0]}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground" title={w.repoDir}>
                    {w.branch ?? (w.detached ? 'detached HEAD' : '—')} · {w.repoDir}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {w.busy && (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
                      {w.ticketKey ?? 'live work'}
                    </Badge>
                  )}
                  {w.prunable && <Badge variant="outline">stale</Badge>}
                  {w.locked && <Badge variant="outline">locked</Badge>}
                  {!w.busy && !w.prunable && !w.locked && (w.revva || w.inWorktreeRoot) && (
                    <Badge variant="outline" className="text-muted-foreground">revva</Badge>
                  )}
                </div>
              </label>
            )
          })}
        </div>

        {error && <p className="shrink-0 text-[12px] text-destructive">{error}</p>}
        {notes.length > 0 && (
          <ul className="max-h-24 shrink-0 space-y-0.5 overflow-y-auto text-[11px] text-muted-foreground">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
