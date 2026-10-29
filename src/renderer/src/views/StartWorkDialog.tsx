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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { Ticket, WorkSummary, PipelineRole } from '@shared/types'
import { modelKeyOf, parseModelKey } from './NewChatDialog'
import { RoleSelectors, DEFAULT, selOrUndefined } from './RoleSelectors'

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

  const [workspaceId, setWorkspaceId] = useState('')
  const [repoDir, setRepoDir] = useState('')
  const [auto, setAuto] = useState(false)
  const [grill, setGrill] = useState(false)
  const [shipOnApprove, setShipOnApprove] = useState(false)
  const [agentID, setAgentID] = useState('__default__')
  const [modelKey, setModelKey] = useState('__default__')
  const [showReviewOverrides, setShowReviewOverrides] = useState(false)
  const [reviewSel, setReviewSel] = useState<Record<'sol' | 'testAudit' | 'impeccable' | 'fixer', { agentID: string; modelKey: string }>>({
    sol: { agentID: DEFAULT, modelKey: DEFAULT },
    testAudit: { agentID: DEFAULT, modelKey: DEFAULT },
    impeccable: { agentID: DEFAULT, modelKey: DEFAULT },
    fixer: { agentID: DEFAULT, modelKey: DEFAULT }
  })

  const workspace = workspaces.data?.find((w) => w.id === workspaceId) ?? workspaces.data?.[0]
  const repositories = useQuery({
    queryKey: ['workspace-repositories', workspace?.id],
    queryFn: () => window.revva.workspace.repositories(workspace!.id),
    enabled: !!workspace,
    staleTime: 0
  })
  const paths = repositories.data?.paths ?? []
  const selectedRepo = paths.includes(repoDir) ? repoDir : paths.length === 1 ? paths[0] : undefined
  const words = new Set(`${ticket.key.split('-')[0]} ${ticket.summary}`.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3))
  const ranked = paths.map((path) => {
    const previous = works.some((work) => work.ticketKey === ticket.key && work.repoDir === path)
    const name = path.split('/').filter(Boolean).pop() ?? path
    const matches = name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && words.has(word))
    return { path, previous, matches }
  }).sort((a, b) => Number(b.previous) - Number(a.previous) || b.matches.length - a.matches.length || a.path.localeCompare(b.path))

  // Suggest a stacked parent only when it belongs to the selected repository.
  const suggestedParent = works.find(
    (w) => w.repoDir === selectedRepo && ticket.dependsOn.includes(w.ticketKey) && w.state !== 'ABANDONED'
  )
  const [parentChoice, setParentChoice] = useState<string | undefined>()
  const parentWorkId = parentChoice ?? suggestedParent?.id ?? '__none__'
  const validParent = parentWorkId === '__none__' || works.some((w) => w.id === parentWorkId && w.repoDir === selectedRepo && w.state !== 'ABANDONED')

  const start = useMutation({
    mutationFn: async () => {
      const dir = selectedRepo
      if (!dir) throw new Error('Choose a repository first.')
      if (!validParent) throw new Error('Choose a parent from the selected repository.')
      const work = await window.revva.work.start({
        ticketKey: ticket.key,
        repoDir: dir,
        mode: auto ? 'auto' : 'interactive',
        agentID: agentID === '__default__' ? undefined : agentID,
        model: modelKey === '__default__' ? undefined : parseModelKey(modelKey),
        parentWorkId: parentWorkId === '__none__' ? undefined : parentWorkId,
        grill,
        shipOnApprove: auto || shipOnApprove,
        reviewSel: {
          sol: selOrUndefined(reviewSel.sol.agentID, reviewSel.sol.modelKey),
          testAudit: selOrUndefined(reviewSel.testAudit.agentID, reviewSel.testAudit.modelKey),
          impeccable: selOrUndefined(reviewSel.impeccable.agentID, reviewSel.impeccable.modelKey),
          fixer: selOrUndefined(reviewSel.fixer.agentID, reviewSel.fixer.modelKey)
        }
      })
      return work
    },
    onSuccess: onStarted
  })

  const hasRepo = !!selectedRepo && validParent && !repositories.isFetching && !repositories.isError

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono">{ticket.key}</span>
            <span className="font-normal text-muted-foreground">Start work</span>
          </DialogTitle>
          <DialogDescription>{ticket.summary}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="work-workspace">Workspace</Label>
            <Select value={workspace?.id ?? ''} onValueChange={(v) => { setWorkspaceId(v); setRepoDir(''); setParentChoice(undefined) }}>
              <SelectTrigger id="work-workspace" size="sm" className="w-full">
                <SelectValue placeholder="Add a folder in Setup…" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(workspaces.data ?? []).map((w) => (
                    <SelectItem key={w.id} value={w.id} className="font-mono text-xs">{w.path}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="work-repository">Repository</Label>
            <Select value={selectedRepo ?? ''} onValueChange={(v) => { setRepoDir(v); setParentChoice(undefined) }} disabled={!paths.length || repositories.isFetching}>
              <SelectTrigger id="work-repository" size="sm" className="w-full">
                <SelectValue placeholder={repositories.isFetching ? 'Finding repositories…' : 'Choose a repository…'} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ranked.map(({ path, previous, matches }) => (
                    <SelectItem key={path} value={path} className="font-mono text-xs">
                      {path}{previous ? ' · previously used for this ticket' : matches.length ? ` · matches ${matches.join(', ')}` : ''}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {repositories.isError && <p className="text-xs text-destructive">Could not scan this workspace. Check that the folder is accessible and try again.</p>}
            {!repositories.isFetching && !repositories.isError && workspace && paths.length === 0 && <p className="text-xs text-muted-foreground">No repositories found within three folder levels. Add the repository folder in Setup.</p>}
            {repositories.data?.incomplete && <p className="text-xs text-muted-foreground">The scan was limited or some folders could not be read; the list may be incomplete. Add the repository folder in Setup if needed.</p>}
            {paths.length > 1 && <p className="text-xs text-muted-foreground">Choose a repository. Suggestions use prior ticket work and name matches, not a guarantee.</p>}
          </div>

          {ticket.dependsOn.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-dashed p-3">
              <div className="flex items-center justify-between">
                <Label>Stack on parent work</Label>
                {suggestedParent && parentWorkId === suggestedParent.id && <Badge variant="secondary" className="text-[10px]">detected</Badge>}
              </div>
              <Select value={parentWorkId} onValueChange={(v) => setParentChoice(v ?? '__none__')}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Branch from repository default</SelectItem>
                  {works
                    .filter((w) => w.state !== 'ABANDONED' && w.repoDir === selectedRepo)
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
                  Agent pursues the goal and ships after review gates pass. Blockers still need your attention.
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
            {!auto && <label className="flex cursor-pointer items-center justify-between">
              <div>
                <Label className="flex items-center gap-1.5">
                  <Rocket className="size-3.5" /> Push when changes are done
                </Label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  After all review gates approve, push and update the linked PR — or open one if there isn't. Off = you ship manually from the cockpit.
                </p>
              </div>
              <Checkbox checked={shipOnApprove} onCheckedChange={(c) => setShipOnApprove(c === true)} />
            </label>}
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left text-xs font-medium"
              onClick={() => setShowReviewOverrides((v) => !v)}
            >
              <span>
                Review team{' '}
                <span className="font-normal text-muted-foreground">
                  — defaults apply; override per reviewer and fixer for this run
                </span>
              </span>
              <span className="text-muted-foreground">{showReviewOverrides ? '−' : '+'}</span>
            </button>
            {showReviewOverrides &&
              (['sol', 'testAudit', 'impeccable', 'fixer'] as const).map((role) => (
                <div key={role} className="space-y-1">
                  <Label className="text-[11px] capitalize">{role === 'testAudit' ? 'test audit' : role}</Label>
                  <RoleSelectors
                    agentID={reviewSel[role].agentID}
                    modelKey={reviewSel[role].modelKey}
                    onAgent={(v) => setReviewSel((s) => ({ ...s, [role]: { ...s[role], agentID: v } }))}
                    onModel={(v) => setReviewSel((s) => ({ ...s, [role]: { ...s[role], modelKey: v } }))}
                  />
                </div>
              ))}
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
