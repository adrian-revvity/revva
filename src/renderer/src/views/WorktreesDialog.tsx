import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, FolderX, GitBranch, RefreshCw, Sparkles, Trash2, TriangleAlert } from 'lucide-react'
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
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { WorktreeInfo, WorktreeRemovalPreflight } from '@shared/types'

/** One worktree with its removal proof, shown in the confirmation dialog. */
export interface WorktreeRemovalRow {
  /** Short human label (ticket key or folder name). */
  label: string
  directory: string
  branch?: string
  preflight: WorktreeRemovalPreflight
}

/** The race no check in this stack can close — stated wherever files get deleted. */
function RaceWarning({ rows }: { rows: WorktreeRemovalRow[] }): React.JSX.Element | null {
  if (!rows.some((r) => !r.preflight.missing)) return null
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-muted-foreground">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <span>
        Revva re-checks each worktree immediately before deleting it, but no check can rule out an
        external program (an editor, a build, a terminal, another OpenCode instance) changing files
        in between — removal is <span className="font-medium text-foreground">not race-free</span>.
      </span>
    </p>
  )
}

/**
 * The confirmation gate every worktree removal passes through. Each row shows
 * exactly what removal destroys (counts, never contents) and how git will be
 * invoked; rows that destroy anything (dirty / untracked / ignored content,
 * detached HEAD) carry their own checkbox and cannot be removed until it is
 * ticked. Rows whose folder is already gone only have a stale git registration
 * cleared and need no checkbox. Cancel is always available; nothing runs until
 * confirm, and every removal re-validates in the main process anyway.
 */
export function WorktreeRemovalDialog({
  open,
  onOpenChange,
  title,
  intro,
  rows,
  confirmLabel,
  busy,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  intro?: string
  rows: WorktreeRemovalRow[]
  confirmLabel: string
  busy?: boolean
  /** Receives the directories the user explicitly ticked; main re-checks each one. */
  onConfirm: (confirmedDirs: Set<string>) => void
}): React.JSX.Element {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  // Each opening shows a fresh proof — checkboxes never carry over between openings.
  useEffect(() => {
    if (open) setChecked(new Set())
  }, [open])
  const allConfirmed = rows.every((r) => !r.preflight.requiresConfirmation || checked.has(r.preflight.directory))

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderX className="size-4" />
            {title}
          </DialogTitle>
          <DialogDescription>
            {intro ??
              'Revva fingerprints the staged contents and files below (blob hashes, sizes, timestamps, inodes) and re-checks right before acting: content staged, added, removed or normally edited since this preview aborts with nothing touched. Limits: a writer that rewrites identical-size content and restores exact timestamps slips past the fingerprint, and anything written between the last check and the deletion cannot be caught — removal is not race-free. Tick each worktree whose files would be destroyed.'}
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3 text-[12px]">
          {rows.map((r) => {
            const p = r.preflight
            return (
              <li key={p.directory} className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-medium">{r.label}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground" title={p.directory}>
                    {p.directory}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {p.missing
                    ? 'folder already gone — only the git registration is cleared'
                    : p.trackedDirty + p.untracked > 0
                      ? 'deletes the folder with git worktree remove --force (git otherwise refuses while modified or untracked files exist)'
                      : 'deletes the folder with git worktree remove (no force)'}
                  {p.branch ? ` · branch ${p.branch} is deleted only if git allows it (branch -d)` : ' · no branch to delete'}
                </div>
                {p.confirmationReasons.map((w) => (
                  <p key={w} className="mt-0.5 text-destructive">
                    {w}
                  </p>
                ))}
                {p.requiresConfirmation && (
                  <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[11px]">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 shrink-0 accent-destructive"
                      checked={checked.has(p.directory)}
                      disabled={busy}
                      onChange={(e) =>
                        setChecked((old) => {
                          const next = new Set(old)
                          if (e.target.checked) next.add(p.directory)
                          else next.delete(p.directory)
                          return next
                        })
                      }
                    />
                    <span>I have read the warnings above and want this exact worktree deleted.</span>
                  </label>
                )}
              </li>
            )
          })}
        </ul>

        <RaceWarning rows={rows} />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(checked)} disabled={busy || !allConfirmed}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Worktree cleanup: every linked worktree across known repos, with two paths.
 * "Clean up with agent" hands the whole set to one chat whose agent checks each
 * worktree for work that would be lost and removes only the provably-safe ones
 * with plain `git worktree remove` (git itself refuses anything dirty; locked
 * and live-work worktrees are off-limits). Manual removal first asks the main
 * process for a removal proof (worktree-safety.ts) that counts exactly what
 * removal would destroy; anything that destroys content needs its own checkbox
 * in the confirmation dialog, and every removal is re-proven — and aborted on
 * any drift — immediately before it happens. Deletion is not race-free against
 * external writers; the dialog says so. Branches are deleted only when git
 * allows it (`branch -d` — never unmerged work).
 */
export function WorktreesDialog({
  open,
  onOpenChange,
  onOpenChat
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenChat: (sessionId: string) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<WorktreeRemovalRow[] | null>(null)

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

  /** Step 1: ask main for the removal proofs of everything selected. A throw = refused path. */
  const preflight = useMutation({
    mutationFn: async (targets: WorktreeInfo[]) => {
      const rows: WorktreeRemovalRow[] = []
      const refusedText: string[] = []
      for (const w of targets) {
        const label = w.ticketKey ?? w.directory.split('/').slice(-1)[0] ?? w.directory
        try {
          const preflight = await window.revva.worktrees.preflight({ repoDir: w.repoDir, directory: w.directory })
          rows.push({ label, directory: w.directory, branch: w.branch, preflight })
        } catch (err) {
          refusedText.push(`Refused ${w.directory}: ${(err as Error).message}`)
        }
      }
      return { rows, refusedText }
    },
    onMutate: () => {
      setError(null)
      setNotes([])
    },
    onSuccess: ({ rows, refusedText }) => {
      if (refusedText.length > 0) setNotes(refusedText)
      if (rows.length > 0) setConfirming(rows)
      else setError('Every selected worktree was refused — nothing will be removed.')
    },
    onError: (err) => setError((err as Error).message)
  })

  /** Step 2: remove only what the user just confirmed, each with its own signature + tick. */
  const remove = useMutation({
    mutationFn: async ({ rows, confirmedDirs }: { rows: WorktreeRemovalRow[]; confirmedDirs: Set<string> }) => {
      const results: string[] = []
      const removedDirs: string[] = []
      for (const r of rows) {
        try {
          const note = await window.revva.worktrees.remove({
            repoDir: r.preflight.repoDir,
            directory: r.preflight.directory,
            confirmedSignature: r.preflight.signature,
            confirmed: confirmedDirs.has(r.preflight.directory)
          })
          results.push(note ?? `Removed ${r.preflight.directory}.`)
          removedDirs.push(r.preflight.directory)
        } catch (err) {
          results.push(`Failed on ${r.preflight.directory}: ${(err as Error).message}`)
        }
      }
      return { results, removedDirs }
    },
    onSuccess: ({ results, removedDirs }) => {
      setConfirming(null)
      setNotes((old) => [...old.filter((n) => !n.startsWith('Refused ')), ...results])
      // Keep failed selections; drop only what actually disappeared.
      setSelected((old) => {
        const next = new Set(old)
        for (const dir of removedDirs) for (const key of [...next]) if (key.endsWith(`\u0000${dir}`)) next.delete(key)
        return next
      })
      void qc.invalidateQueries({ queryKey: ['worktrees'] })
      void qc.invalidateQueries({ queryKey: ['works'] })
    },
    onError: (err) => {
      setConfirming(null)
      setError((err as Error).message)
    }
  })

  /**
   * "Clean up with agent": opens one chat primed to audit every worktree for
   * work that would be lost (uncommitted, unpushed, unmerged) and remove only
   * the provably-safe ones itself — plain `git worktree remove`, never force,
   * so git's own guard refuses anything the agent misjudges. The agent reports
   * what it kept and why; locked and live-work worktrees are off-limits.
   */
  const cleanup = useMutation({
    mutationFn: () => window.revva.worktrees.cleanupChat(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['chats'] })
      onOpenChange(false)
      onOpenChat(res.sessionId)
    },
    onError: (err) => setError(`Could not start the cleanup: ${(err as Error).message}`)
  })

  const targets = items.filter((w) => selected.has(keyOf(w)))
  const allSelected = removable.length > 0 && removable.every((w) => selected.has(keyOf(w)))
  const busy = preflight.isPending || remove.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4" /> Worktrees
            {worktrees.data && <Badge variant="secondary">{items.length}</Badge>}
          </DialogTitle>
          <DialogDescription>
            Linked worktrees across your repos. Clean up with agent hands them to one chat that
            checks each for uncommitted or unpushed work and removes only the ones that hold
            nothing. Manual removal always previews first: you see exactly what
            gets destroyed (counts, never contents), tick each worktree whose files would go, and
            revva re-fingerprints staged contents and files right before deleting — aborting when
            content was staged, added, removed, or normally edited since the preview. A writer that
            restores exact file timestamps and sizes can still slip past the fingerprint, and files
            written between the last check and the deletion cannot be caught at all: removal is not
            race-free. Branches are deleted only when git allows it; unmerged ones are always kept.
          </DialogDescription>
        </DialogHeader>

        {items.length > 10 && (
          <p className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            More than 10 linked worktrees. Review any you no longer need.
          </p>
        )}
        {worktrees.isError && worktrees.data && (
          <p role="alert" className="text-xs text-destructive">Couldn’t refresh worktrees. Showing the last known list.</p>
        )}

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
            variant="outline"
            className="ml-auto"
            title="Open a chat where an agent checks every worktree for uncommitted or unpushed work, removes the ones that hold nothing, and reports what it kept"
            disabled={items.length === 0 || cleanup.isPending}
            onClick={() => cleanup.mutate()}
          >
            {cleanup.isPending ? <RefreshCw className="mr-1 size-3.5 animate-spin" /> : <Sparkles className="mr-1 size-3.5" />}
            {cleanup.isPending ? 'Starting…' : 'Clean up with agent'}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={targets.length === 0 || busy}
            onClick={() => preflight.mutate(targets)}
          >
            <Trash2 className="mr-1 size-3.5" />
            {preflight.isPending
              ? 'Checking…'
              : `Remove ${targets.length > 0 ? targets.length : ''}`.trim()}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {worktrees.isLoading && (
            <div className="space-y-2 p-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {worktrees.isError && !worktrees.data && (
            <p role="alert" className="p-6 text-center text-sm text-destructive">
              Couldn’t load worktrees. Use Refresh to try again.
            </p>
          )}
          {!worktrees.isLoading && (!worktrees.isError || worktrees.data) && items.length === 0 && (
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

      <WorktreeRemovalDialog
        open={confirming !== null}
        onOpenChange={(next) => !next && !remove.isPending && setConfirming(null)}
        title={`Remove ${confirming?.length ?? 0} worktree${(confirming?.length ?? 0) === 1 ? '' : 's'}?`}
        rows={confirming ?? []}
        confirmLabel="Remove"
        busy={remove.isPending}
        onConfirm={(confirmedDirs) => confirming && remove.mutate({ rows: confirming, confirmedDirs })}
      />
    </Dialog>
  )
}
