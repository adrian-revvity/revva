import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

const ANY_FOLDER = '__pick__'

export function NewChatDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (sessionId: string) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => window.revva.workspace.list() })
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => window.revva.inventory.agents() })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models() })

  const [directory, setDirectory] = useState<string>(ANY_FOLDER)
  const [customDir, setCustomDir] = useState('')
  const [agentID, setAgentID] = useState('__default__')
  const [modelKey, setModelKey] = useState('__default__')
  const [ticketKey, setTicketKey] = useState('')
  const [prRef, setPrRef] = useState('')

  // Default the folder to the first configured workspace.
  useEffect(() => {
    if (open && workspaces.data && workspaces.data.length > 0 && directory === ANY_FOLDER && !customDir) {
      // keep sentinel; user explicitly picks — but preselect first in the list UI
    }
  }, [open, workspaces.data, directory, customDir])

  const create = useMutation({
    mutationFn: async () => {
      const dir = directory === ANY_FOLDER ? customDir.trim() : directory
      if (!dir) throw new Error('Choose a project folder for this chat.')
      const chat = await window.revva.chat.create({
        directory: dir,
        agentID: agentID === '__default__' ? undefined : agentID,
        model: modelKey === '__default__' ? undefined : parseModelKey(modelKey),
        ticketKey: ticketKey.trim() || undefined,
        prUrl: prRef.trim() || undefined
      })
      await qc.invalidateQueries({ queryKey: ['chats'] })
      return chat
    },
    onSuccess: (chat) => {
      onOpenChange(false)
      onCreated(chat.sessionId)
    }
  })

  const canSubmit =
    (directory !== ANY_FOLDER || customDir.trim().length > 0) && !create.isPending && !models.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription>
            A general OpenCode session — not attached to any ticket or pipeline. It gets a title
            automatically from your first message.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Project folder</Label>
            <Select
              value={directory}
              onValueChange={(v) => {
                setDirectory(v ?? ANY_FOLDER)
                if (v !== ANY_FOLDER) setCustomDir('')
              }}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder="Choose a folder…" />
              </SelectTrigger>
              <SelectContent>
                {(workspaces.data ?? []).map((w) => (
                  <SelectItem key={w.id} value={w.path} className="font-mono text-xs">
                    {w.path.split('/').filter(Boolean).pop() || w.path}
                  </SelectItem>
                ))}
                <SelectItem value={ANY_FOLDER}>Browse…</SelectItem>
              </SelectContent>
            </Select>
            {directory === ANY_FOLDER && (
              <div className="flex gap-2">
                <Input
                  placeholder="~/some/project"
                  value={customDir}
                  onChange={(e) => setCustomDir(e.target.value)}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const picked = await window.revva.workspace.pickFolder()
                    if (picked) setCustomDir(picked)
                  }}
                >
                  <FolderOpen className="size-4" />
                </Button>
              </div>
            )}
          </div>

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

          {create.error instanceof Error && <p className="text-xs text-destructive">{create.error.message}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!canSubmit}>
            {create.isPending ? 'Creating…' : 'Start chat'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const modelKeyOf = (providerID: string, id: string): string => `${providerID}::${id}`
export const parseModelKey = (key: string): { providerID: string; id: string } => {
  const [providerID, id] = key.split('::')
  return { providerID: providerID ?? '', id: id ?? '' }
}
