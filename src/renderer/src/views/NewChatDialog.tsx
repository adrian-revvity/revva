import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Check, ChevronDown, FolderOpen, Cpu } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import type { ChatSummary } from '@shared/types'

const DEFAULT = '__default__'
type LastSelection = { directory: string; agentID?: string; model?: { providerID: string; id: string } }

function readSelection(value: unknown): LastSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = value as Record<string, unknown>
  if (typeof data.directory !== 'string' || !data.directory.trim()) return undefined
  const model = data.model && typeof data.model === 'object' ? data.model as Record<string, unknown> : undefined
  return {
    directory: data.directory,
    agentID: typeof data.agentID === 'string' ? data.agentID : undefined,
    model: model && typeof model.providerID === 'string' && typeof model.id === 'string' && model.providerID && model.id
      ? { providerID: model.providerID, id: model.id } : undefined
  }
}

export function NewChatDialog({ open, onOpenChange, onCreated }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (sessionId: string) => void
}): React.JSX.Element {
  const saved = useQuery({ queryKey: ['chat-last-selection'], queryFn: () => window.revva.settings.get('chat.lastSelection'), enabled: open })
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list(), enabled: open })
  const last = chats.data?.[0]
  const initial = readSelection(saved.data) ?? (last ? selectionFromChat(last) : undefined)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription>Start a conversation with your last project and settings, or change them below.</DialogDescription>
        </DialogHeader>
        {open && (saved.isPending || chats.isPending ? (
          <p className="py-4 text-sm text-muted-foreground">Loading chat settings…</p>
        ) : (
          <ChatChoices initial={initial} onOpenChange={onOpenChange} onCreated={onCreated} />
        ))}
      </DialogContent>
    </Dialog>
  )
}

function selectionFromChat(chat: ChatSummary): LastSelection {
  return {
    directory: chat.directory,
    agentID: chat.agentID,
    model: chat.providerID && chat.modelID ? { providerID: chat.providerID, id: chat.modelID } : undefined
  }
}

function ChatChoices({ initial, onOpenChange, onCreated }: {
  initial?: LastSelection
  onOpenChange: (open: boolean) => void
  onCreated: (sessionId: string) => void
}): React.JSX.Element {
  const qc = useQueryClient()
  const popoverContainer = useRef<HTMLDivElement>(null)
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => window.revva.workspace.list(), staleTime: 5 * 60_000 })
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => window.revva.inventory.agents(), staleTime: 60_000 })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models(), staleTime: 60_000 })
  const [directory, setDirectory] = useState(initial?.directory ?? '')
  const [agentID, setAgentID] = useState(initial?.agentID ?? DEFAULT)
  const [modelKey, setModelKey] = useState(initial?.model ? modelKeyOf(initial.model.providerID, initial.model.id) : DEFAULT)
  const [projectOpen, setProjectOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [customDir, setCustomDir] = useState(initial?.directory ?? '')
  const [agentSearch, setAgentSearch] = useState('')
  const [modelSearch, setModelSearch] = useState('')
  const selectedAgent = agents.data?.find((agent) => agent.id === agentID)
  const selectedModel = models.data?.find((model) => modelKeyOf(model.providerID, model.id) === modelKey)
  const agentMissing = agentID !== DEFAULT && !!agents.data && !selectedAgent
  const modelMissing = modelKey !== DEFAULT && !!models.data && !selectedModel
  const modelBlocked = !!selectedModel?.gated
  const create = useMutation({
    mutationFn: async () => {
      const selection: LastSelection = {
        directory: directory.trim(),
        agentID: agentID === DEFAULT ? undefined : agentID,
        model: modelKey === DEFAULT ? undefined : parseModelKey(modelKey)
      }
      if (!selection.directory) throw new Error('Choose a project folder for this chat.')
      const chat = await window.revva.chat.create(selection)
      try {
        await window.revva.settings.set('chat.lastSelection', selection)
        qc.setQueryData(['chat-last-selection'], selection)
      } catch (error) {
        console.warn('[chat] Could not save last selection:', error)
      }
      void qc.invalidateQueries({ queryKey: ['chats'] })
      return chat
    },
    onSuccess: (chat) => {
      onOpenChange(false)
      onCreated(chat.sessionId)
    }
  })
  const matches = (value: string, search: string): boolean => value.toLowerCase().includes(search.trim().toLowerCase())
  const agentReady = agentID === DEFAULT || (!!agents.data && !agents.isError && !agentMissing)
  const modelReady = modelKey === DEFAULT || (!!models.data && !models.isError && !modelMissing && !modelBlocked)
  const canCreate = !!directory.trim() && !create.isPending && agentReady && modelReady

  return (
    <>
      <div ref={popoverContainer} className="flex flex-col gap-3">
        <Popover open={projectOpen} onOpenChange={setProjectOpen}>
          <PopoverTrigger render={<Button type="button" variant="outline" className="w-full min-w-0 justify-start" />}>
            <FolderOpen data-icon="inline-start" />
            <span className="min-w-0 flex-1 truncate text-left" title={directory}>{directory || 'Choose project folder'}</span>
            <ChevronDown data-icon="inline-end" />
          </PopoverTrigger>
          <PopoverContent container={popoverContainer} align="start" className="w-80 max-w-[calc(100vw-2rem)] gap-2 p-3">
            <PopoverTitle>Project folder</PopoverTitle>
            {workspaces.isError && <p className="text-xs text-destructive">Couldn’t load saved projects. You can still browse for a folder.</p>}
            <div className="max-h-48 overflow-y-auto">
              {(workspaces.data ?? []).map((workspace) => (
                <button key={workspace.id} type="button" className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setDirectory(workspace.path); setCustomDir(workspace.path); setProjectOpen(false) }}>
                  <span className="block truncate font-medium">{workspace.path.split(/[\\/]/).filter(Boolean).pop() || workspace.path}</span>
                  <span className="block truncate text-muted-foreground">{workspace.path}</span>
                </button>
              ))}
            </div>
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (customDir.trim()) { setDirectory(customDir.trim()); setProjectOpen(false) } }}>
              <Input aria-label="Project folder path" placeholder="Project folder path" value={customDir} onChange={(event) => setCustomDir(event.target.value)} />
              <Button type="button" size="icon" variant="outline" aria-label="Browse folders" onClick={() => void window.revva.workspace.pickFolder().then((picked) => { if (picked) { setDirectory(picked); setCustomDir(picked); setProjectOpen(false) } })}><FolderOpen /></Button>
              <Button type="submit" size="sm" disabled={!customDir.trim()}>Use</Button>
            </form>
          </PopoverContent>
        </Popover>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Popover open={agentOpen} onOpenChange={setAgentOpen}>
            <PopoverTrigger render={<Button type="button" variant="outline" className="min-w-0 justify-start" />}>
              <Bot data-icon="inline-start" />
              <span className="min-w-0 flex-1 truncate text-left">{agentID === DEFAULT ? 'Default agent' : selectedAgent?.name || agentID}</span>
              <ChevronDown data-icon="inline-end" />
            </PopoverTrigger>
            <PopoverContent container={popoverContainer} align="start" className="w-72 max-w-[calc(100vw-2rem)] gap-2 p-3">
              <PopoverTitle>Agent</PopoverTitle>
              <Input aria-label="Search agents" placeholder="Search agents…" value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} />
              <div className="max-h-64 overflow-y-auto">
                <Choice label="Service default" selected={agentID === DEFAULT} onClick={() => { setAgentID(DEFAULT); setAgentOpen(false) }} />
                {(agents.data ?? []).filter((agent) => matches(`${agent.name ?? ''} ${agent.id}`, agentSearch)).map((agent) => (
                  <Choice key={agent.id} label={agent.name || agent.id} selected={agentID === agent.id} onClick={() => { setAgentID(agent.id); setAgentOpen(false) }} />
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Popover open={modelOpen} onOpenChange={setModelOpen}>
            <PopoverTrigger render={<Button type="button" variant="outline" className="min-w-0 justify-start" />}>
              <Cpu data-icon="inline-start" />
              <span className="min-w-0 flex-1 truncate text-left" title={modelKey}>{modelKey === DEFAULT ? 'Default model' : selectedModel?.name || selectedModel?.id || modelKey}</span>
              <ChevronDown data-icon="inline-end" />
            </PopoverTrigger>
            <PopoverContent container={popoverContainer} align="end" className="w-80 max-w-[calc(100vw-2rem)] gap-2 p-3">
              <PopoverTitle>Model</PopoverTitle>
              <Input aria-label="Search models" placeholder="Search models…" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} />
              <div className="max-h-64 overflow-y-auto">
                <Choice label="Service default" selected={modelKey === DEFAULT} onClick={() => { setModelKey(DEFAULT); setModelOpen(false) }} />
                {(models.data ?? []).filter((model) => matches(`${model.name ?? ''} ${model.id} ${model.providerID}`, modelSearch)).map((model) => {
                  const key = modelKeyOf(model.providerID, model.id)
                  return <Choice key={key} label={model.name || model.id} detail={model.gated || model.providerID} disabled={!!model.gated} selected={modelKey === key} onClick={() => { setModelKey(key); setModelOpen(false) }} />
                })}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {agentMissing && <p role="alert" className="text-xs text-destructive">The saved agent is unavailable. Choose another agent.</p>}
        {modelMissing && <p role="alert" className="text-xs text-destructive">The saved model is unavailable. Choose another model.</p>}
        {modelBlocked && <p role="alert" className="text-xs text-destructive">{selectedModel?.gated}</p>}
        {(agents.isError || models.isError) && (
          <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
            <span>Couldn’t load agents or models. Service defaults are still available.</span>
            <Button type="button" size="xs" variant="outline" onClick={() => { if (agents.isError) void agents.refetch(); if (models.isError) void models.refetch() }}>Retry</Button>
          </div>
        )}
        {create.error instanceof Error && <p role="alert" className="text-xs text-destructive">{create.error.message}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
        <Button onClick={() => create.mutate()} disabled={!canCreate}>{create.isPending ? 'Creating…' : 'Start chat'}</Button>
      </DialogFooter>
    </>
  )
}

export function Choice({ label, detail, selected, disabled, onClick }: { label: string; detail?: string; selected: boolean; disabled?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" disabled={disabled} aria-pressed={selected} onClick={onClick} className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
      <span className="flex items-center gap-1 font-medium">{label}{selected && <Check className="size-3" aria-label="Selected" />}</span>
      {detail && <span className="text-muted-foreground">{detail}</span>}
    </button>
  )
}

export const modelKeyOf = (providerID: string, id: string): string => `${providerID}::${id}`
export const parseModelKey = (key: string): { providerID: string; id: string } => {
  const [providerID, id] = key.split('::')
  return { providerID: providerID ?? '', id: id ?? '' }
}
