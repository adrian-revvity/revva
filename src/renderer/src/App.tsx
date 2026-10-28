import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MessageSquare,
  Plus,
  Settings,
  Server,
  RefreshCw,
  Kanban,
  Hammer,
  Terminal,
  Inbox as InboxIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { SetupView } from '@/views/Setup'
import { ChatView } from '@/views/Chat'
import { NewChatDialog } from '@/views/NewChatDialog'
import { BoardView } from '@/views/BoardView'
import { WorkCockpit } from '@/views/WorkCockpit'
import { InboxView, useInbox } from '@/views/InboxView'
import { ScriptsView } from '@/views/ScriptsView'

type View =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'setup' }
  | { kind: 'board' }
  | { kind: 'work'; workId: string }
  | { kind: 'inbox' }
  | { kind: 'scripts' }

const serviceStateLabels = {
  connecting: { label: 'Connecting…', cls: 'text-muted-foreground' },
  connected: { label: 'Connected', cls: 'text-emerald-600 dark:text-emerald-400' },
  missing: { label: 'OpenCode not found', cls: 'text-destructive' },
  error: { label: 'Service error', cls: 'text-destructive' }
} as const

export default function App(): React.JSX.Element {
  const qc = useQueryClient()
  const [view, setView] = useState<View>({ kind: 'board' })
  const [newChatOpen, setNewChatOpen] = useState(false)

  const status = useQuery({
    queryKey: ['service-status'],
    queryFn: () => window.revva.service.status(),
    refetchInterval: 10_000
  })
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list() })
  const works = useQuery({ queryKey: ['works'], queryFn: () => window.revva.work.list() })
  const pending = useInbox()

  useEffect(() => {
    return window.revva.events.on((event) => {
      if (event.kind === 'service') {
        qc.setQueryData(['service-status'], event.status)
        if (event.status.state === 'connected') void chats.refetch()
      }
      if (event.kind === 'chat.idle' || event.kind === 'chat.message') void chats.refetch()
      if (event.kind === 'work.updated') void works.refetch()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc])

  const st = status.data
  const stateInfo = serviceStateLabels[st?.state ?? 'connecting']
  const activeWork =
    view.kind === 'work' ? works.data?.find((w) => w.id === view.workId) : undefined
  const runningWorks = (works.data ?? []).filter(
    (w) => w.state === 'BUILDING' || w.state === 'REVIEW' || w.state === 'WAITING_HUMAN'
  )

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="drag-region flex h-11 items-center px-3 pl-20">
          <span className="text-[13px] font-semibold tracking-wide">revva</span>
        </div>

        <div className="space-y-0.5 px-2">
          <NavButton
            icon={<Kanban className="size-4" />}
            label="Board"
            active={view.kind === 'board'}
            onClick={() => setView({ kind: 'board' })}
          />
          <NavButton
            icon={<InboxIcon className={cn('size-4', pending.length > 0 && 'text-amber-500')} />}
            label="Inbox"
            badge={pending.length > 0 ? pending.length : undefined}
            active={view.kind === 'inbox'}
            onClick={() => setView({ kind: 'inbox' })}
          />
          <NavButton
            icon={<Terminal className="size-4" />}
            label="Scripts"
            active={view.kind === 'scripts'}
            onClick={() => setView({ kind: 'scripts' })}
          />
          {runningWorks.map((w) => (
            <NavButton
              key={w.id}
              icon={
                <Hammer
                  className={cn('size-4', w.state === 'BUILDING' && 'animate-pulse text-sky-500')}
                />
              }
              label={w.ticketKey}
              sublabel={w.state}
              active={view.kind === 'work' && view.workId === w.id}
              onClick={() => setView({ kind: 'work', workId: w.id })}
            />
          ))}
        </div>

        <Separator className="my-2" />

        <div className="px-3 pb-2">
          <Button
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => setNewChatOpen(true)}
            disabled={st?.state !== 'connected'}
          >
            <Plus className="size-4" /> New chat
          </Button>
        </div>
        <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Chats
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {chats.isLoading && <Skeleton className="mx-1 h-8" />}
          {chats.data?.map((c) => (
            <NavButton
              key={c.sessionId}
              icon={<MessageSquare className="size-4 shrink-0 text-muted-foreground" />}
              label={c.title}
              active={view.kind === 'chat' && view.sessionId === c.sessionId}
              onClick={() => setView({ kind: 'chat', sessionId: c.sessionId })}
            />
          ))}
        </div>

        <Separator />
        <div className="flex items-center justify-between px-3 py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn('flex items-center gap-1.5 text-[11px] font-medium', stateInfo.cls)}
                onClick={() => setView({ kind: 'setup' })}
              >
                <Server className="size-3.5" />
                {stateInfo.label}
              </button>
            </TooltipTrigger>
            {st && (
              <TooltipContent side="top">
                {st.url && <div>{st.url}</div>}
                {st.version && <div>opencode v{st.version}</div>}
                {st.message && <div>{st.message}</div>}
              </TooltipContent>
            )}
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() =>
                  void window.revva.service.retry().then((s) => qc.setQueryData(['service-status'], s))
                }
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reconnect OpenCode service</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setView({ kind: 'setup' })}>
                <Settings className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Setup &amp; settings</TooltipContent>
          </Tooltip>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="drag-region flex h-11 shrink-0 items-center justify-end gap-2 border-b px-3">
          {works.data?.some((w) => w.state === 'BUILDING') && (
            <Badge variant="outline" className="no-drag animate-pulse font-normal">
              building…
            </Badge>
          )}
          {st?.state === 'connected' && (
            <Badge variant="outline" className="no-drag font-normal">
              opencode v{st.version}
            </Badge>
          )}
        </div>
        {view.kind === 'setup' ? (
          <SetupView />
        ) : view.kind === 'inbox' ? (
          <InboxView />
        ) : view.kind === 'scripts' ? (
          <ScriptsView />
        ) : view.kind === 'board' ? (
          <BoardView works={works.data ?? []} onStart={(workId) => setView({ kind: 'work', workId })} />
        ) : view.kind === 'work' ? (
          activeWork ? (
            <WorkCockpit key={activeWork.sessionId ?? activeWork.id} work={activeWork} />
          ) : (
            <div className="p-8 text-sm text-muted-foreground">Loading work…</div>
          )
        ) : (
          <ChatView key={view.sessionId} sessionId={view.sessionId} />
        )}
      </main>

      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onCreated={(sessionId) => setView({ kind: 'chat', sessionId })}
      />
    </div>
  )
}

function NavButton({
  icon,
  label,
  sublabel,
  badge,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  sublabel?: string
  badge?: number
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent font-medium'
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {badge !== undefined && (
        <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
          {badge}
        </span>
      )}
      {sublabel && <span className="ml-auto text-[10px] text-muted-foreground">{sublabel}</span>}
    </button>
  )
}
