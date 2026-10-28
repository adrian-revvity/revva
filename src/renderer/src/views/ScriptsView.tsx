import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Play, Plus, Square, Terminal, Trash2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { PushEvent, ScriptDef, ScriptInput } from '@shared/types'

/**
 * One-click shell scripts (e.g. "morning"): user-defined aliases/commands run
 * through interactive zsh, with live output and last-run status. Revva has no
 * idea what they do — it just runs them.
 */
export function ScriptsView(): React.JSX.Element {
  const qc = useQueryClient()
  const scripts = useQuery({ queryKey: ['scripts'], queryFn: () => window.revva.scripts.list() })
  const status = useQuery({
    queryKey: ['script-status'],
    queryFn: () => window.revva.scripts.status(),
    refetchInterval: 10_000
  })
  const needs = useQuery({
    queryKey: ['script-provider-needs'],
    queryFn: () => window.revva.scripts.providerNeeds()
  })

  const [editing, setEditing] = useState<ScriptDef | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [openOutput, setOpenOutput] = useState<string | null>(null)

  // Live pushes: streamed chunks go into the output query cache; status replaces wholesale.
  useEffect(() => {
    return window.revva.events.on((e: PushEvent) => {
      if (e.kind === 'script.output') {
        qc.setQueryData(['script-live-output', e.scriptId], (prev: string | undefined) =>
          ((prev ?? '') + e.chunk).slice(-64_000)
        )
        setOpenOutput((cur) => cur ?? e.scriptId)
      } else if (e.kind === 'script.status') {
        qc.setQueryData(['script-status'], e.status)
      }
    })
  }, [qc])

  const remove = useMutation({
    mutationFn: (id: string) => window.revva.scripts.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scripts'] })
      void qc.invalidateQueries({ queryKey: ['script-status'] })
    }
  })

  const run = useMutation({
    mutationFn: (id: string) => window.revva.scripts.run(id),
    onSuccess: (_r, id) => qc.setQueryData(['script-live-output', id], '')
  })

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 px-6 py-6">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Terminal className="size-5" /> Scripts
            </h2>
            <p className="text-xs text-muted-foreground">
              Your aliases and commands, one click away. Runs in interactive zsh, so anything from
              your shell config works.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            <Plus className="mr-1 size-4" /> New
          </Button>
        </header>

        {(needs.data ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
            <span>Models are gated while these local endpoints are down:</span>
            {(needs.data ?? []).map((n) => (
              <Badge key={n.providerID} variant={n.up ? 'secondary' : 'outline'} className={cn('font-mono text-[10px]', !n.up && 'border-amber-500/50 text-amber-600')}>
                {n.up ? '✓' : '✗'} {n.baseURL}
              </Badge>
            ))}
          </div>
        )}

        {(scripts.data ?? []).length === 0 && (
          <p className="py-14 text-center text-sm text-muted-foreground">
            No scripts yet — add one, e.g. name <span className="font-mono">morning</span>, command{' '}
            <span className="font-mono">morning</span> (your alias).
          </p>
        )}

        {(scripts.data ?? []).map((s) => {
          const st = (status.data ?? []).find((x) => x.id === s.id)
          return (
            <div key={s.id} className="rounded-lg border shadow-sm">
              <div className="flex items-center gap-2 p-3">
                <button
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => setOpenOutput(openOutput === s.id ? null : s.id)}
                  title="Toggle output"
                >
                  {openOutput === s.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground" title={s.command}>
                    $ {s.command}
                  </div>
                </div>
                {st?.running ? (
                  <Badge className="shrink-0 text-[10px]">running</Badge>
                ) : st?.lastExit !== null && st?.lastExit !== undefined ? (
                  <Badge variant={st.lastExit === 0 ? 'secondary' : 'destructive'} className="shrink-0 text-[10px]">
                    exit {st.lastExit} · {st.lastDurationMs !== null ? `${(st.lastDurationMs / 1000).toFixed(1)}s` : ''}
                  </Badge>
                ) : null}
                {st?.running ? (
                  <Button size="sm" variant="outline" onClick={() => window.revva.scripts.kill(s.id)}>
                    <Square className="size-3.5" />
                  </Button>
                ) : (
                  <Button size="sm" disabled={run.isPending} onClick={() => run.mutate(s.id)}>
                    <Play className="size-3.5" />
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(s)
                    setDialogOpen(true)
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              {openOutput === s.id && <ScriptOutput scriptId={s.id} running={st?.running ?? false} />}
            </div>
          )
        })}
      </div>

      <ScriptDialog
        open={dialogOpen}
        script={editing}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  )
}

function ScriptOutput({ scriptId, running }: { scriptId: string; running: boolean }): React.JSX.Element {
  const qc = useQueryClient()
  const live = useQuery({
    queryKey: ['script-live-output', scriptId],
    queryFn: () => qc.getQueryData<string>(['script-live-output', scriptId]) ?? '',
    enabled: running
  })
  const history = useQuery({
    queryKey: ['script-history', scriptId],
    queryFn: () => window.revva.scripts.history(scriptId),
    enabled: !running
  })
  const text = running ? (live.data ?? '') : (history.data?.[0]?.outputTail ?? '')
  const boxRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
  }, [text])

  return (
    <pre
      ref={boxRef}
      className="max-h-56 overflow-auto whitespace-pre-wrap break-all border-t bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-200"
    >
      {text || (running ? 'running…' : 'no output yet')}
    </pre>
  )
}

function ScriptDialog({
  open,
  script,
  onClose
}: {
  open: boolean
  script: ScriptDef | null
  onClose: () => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  const [interactive, setInteractive] = useState(true)

  useEffect(() => {
    if (open) {
      setName(script?.name ?? '')
      setCommand(script?.command ?? '')
      setCwd(script?.cwd ?? '')
      setInteractive(script?.interactive ?? true)
    }
  }, [open, script])

  const save = useMutation({
    mutationFn: () => {
      const input: ScriptInput = { name, command, cwd: cwd || undefined, interactive, ...(script ? { id: script.id } : {}) }
      return window.revva.scripts.save(input)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scripts'] })
      void qc.invalidateQueries({ queryKey: ['script-status'] })
      onClose()
    }
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{script ? 'Edit script' : 'New script'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="morning" autoFocus />
          </div>
          <div className="space-y-1">
            <Label>Command</Label>
            <textarea
              className="min-h-20 w-full rounded-md border bg-background p-2 font-mono text-xs"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={'morning\n# or: cd ~/workspace && uv run useaws.py --login'}
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label>Working directory (optional)</Label>
            <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/workspace" className="font-mono text-xs" />
          </div>
          <div className="flex items-center justify-between rounded-md border p-2.5">
            <div className="text-xs">
              <div className="font-medium">Interactive shell</div>
              <div className="text-muted-foreground">Load .zshrc so aliases and functions work.</div>
            </div>
            <Switch checked={interactive} onCheckedChange={setInteractive} />
          </div>
          {save.error instanceof Error && <p className="text-xs text-destructive">{save.error.message}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || !command.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
