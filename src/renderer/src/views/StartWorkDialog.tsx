import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Rocket, MessageCircleQuestion } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { Ticket, WorkSummary } from '@shared/types'
import { modelKeyOf, parseModelKey } from './NewChatDialog'

/**
 * Per-run choices (REQ-PIPE: role defaults + per-run overrides).
 * Base = main, or a stacked parent work's branch when the ticket depends on it.
 */
export function StartWorkDialog({
  ticket,
  works,
  onClose,
  onStarted
}: {
  ticket: Ticket
  works: WorkSummary[]
  onClose: () => void
  onStarted: (work: WorkSummary) => void
}): React.JSX.Element {
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => window.revva.workspace.list() })
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => window.revva.inventory.agents() })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models() })

  const [repoDir, setRepoDir] = useState<string>('')
  const [auto, setAuto] = useState(false)
  const [grill, setGrill] = useState(false)
  const [agentID, setAgentID] = useState('__default__')
  const [modelKey, setModelKey] = useState('__default__')

  // Suggest a stacked parent: an active work whose ticket this one depends on.
  const suggestedParent = works.find(
    (w) => ticket.dependsOn.length > 0 && w.ticketKey && ticket.dependsOn.includes(w.ticketKey) && w.state !== 'ABANDONED'
  )
  const [parentWorkId, setParentWorkId] = useState<string>(suggestedParent?.id ?? '__none__')

  const start = useMutation({
    mutationFn: async () => {
      const dir = repoDir || workspaces.data?.[0]?.path
      if (!dir) throw new Error('Add a project folder in Setup first.')
      const work = await window.revva.work.start({
        ticketKey: ticket.key,
        repoDir: dir,
        mode: auto ? 'auto' : 'interactive',
        agentID: agentID === '__default__' ? undefined : agentID,
        model: modelKey === '__default__' ? undefined : parseModelKey(modelKey),
        parentWorkId: parentWorkId === '__none__' ? undefined : parentWorkId,
        grill
      })
      return work
    },
    onSuccess: onStarted
  })

  const hasRepo = !!repoDir || (workspaces.data?.length ?? 0) > 0

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono">{ticket.key}</span>
            <span className="font-normal text-muted-foreground">Start work</span>
          </DialogTitle>
          <DialogDescription>{ticket.summary}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Repository</Label>
            <Select value={repoDir || workspaces.data?.[0]?.path || ''} onValueChange={(v) => setRepoDir(v ?? '')}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder="Add a project folder in Setup…" />
              </SelectTrigger>
              <SelectContent>
                {(workspaces.data ?? []).map((w) => (
                  <SelectItem key={w.id} value={w.path} className="font-mono text-xs">
                    {w.path.split('/').filter(Boolean).pop() || w.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {ticket.dependsOn.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-dashed p-3">
              <div className="flex items-center justify-between">
                <Label>Stack on parent work</Label>
                {suggestedParent && <Badge variant="secondary" className="text-[10px]">detected</Badge>}
              </div>
              <Select value={parentWorkId} onValueChange={(v) => setParentWorkId(v ?? '__none__')}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Branch from default (main)</SelectItem>
                  {works
                    .filter((w) => w.state !== 'ABANDONED')
                    .map((w) => (
                      <SelectItem key={w.id} value={w.id} className="text-xs">
                        {w.ticketKey} · {w.branch}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {parentWorkId !== '__none__' && (
                <p className="text-[11px] text-muted-foreground">
                  New branch starts from the parent work's branch, so its commits are included.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Agent</Label>
              <Select value={agentID} onValueChange={(v) => setAgentID(v ?? '__default__')}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Service default</SelectItem>
                  {(agents.data ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name || a.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <Select value={modelKey} onValueChange={(v) => setModelKey(v ?? '__default__')}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Service default</SelectItem>
                  {(models.data ?? []).map((m) => (
                    <SelectItem
                      key={modelKeyOf(m.providerID, m.id)}
                      value={modelKeyOf(m.providerID, m.id)}
                      disabled={!!m.gated}
                      title={m.gated}
                    >
                      {m.name || m.id}
                      <span className="ml-1 text-muted-foreground">{m.providerID}</span>
                      {m.gated && <span className="ml-1 text-[10px] text-amber-600">needs local endpoint</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <div>
                <Label className="flex items-center gap-1.5">
                  <Rocket className="size-3.5" /> AUTO mode
                </Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Agent pursues the goal, picks recommended options, minimizes questions. Gates still apply.
                </p>
              </div>
              <Switch checked={auto} onCheckedChange={(c) => setAuto(c === true)} />
            </div>
            <label className="flex cursor-pointer items-center justify-between">
              <div>
                <Label className="flex items-center gap-1.5">
                  <MessageCircleQuestion className="size-3.5" /> Grill first
                </Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Run /grill-me to sharpen the plan before building.
                </p>
              </div>
              <Checkbox checked={grill} onCheckedChange={(c) => setGrill(c === true)} />
            </label>
          </div>

          {start.error instanceof Error && <p className="text-xs text-destructive">{start.error.message}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => start.mutate()} disabled={!hasRepo || start.isPending}>
            {start.isPending ? 'Creating worktree…' : 'Start build'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
