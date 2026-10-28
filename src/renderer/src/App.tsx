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
  Github,
  Trash2,
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
import { GitHubView } from '@/views/GitHubView'

type View =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'setup' }
  | { kind: 'board' }
  | { kind: 'work'; workId: string }
  | { kind: 'inbox' }
  | { kind: 'scripts' }
  | { kind: 'github' }

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
    (w) => w.state === 'BUILDING' || w.state === 'REVIEW' || w.state === 'FIXING' || w.state === 'REWORK' || w.state === 'WAITING_HUMAN'
  )
  const waitingCount = pending.length

  const deleteChat = (sessionId: string, title: string): void => {
    if (!confirm(`Delete chat "${title}"? The OpenCode session is removed too.`)) return
    void window.revva.chat.remove(sessionId).then(() => {
      qc.invalidateQueries({ queryKey: ['chats'] })
      if (view.kind === 'chat' && view.sessionId === sessionId) setView({ kind: 'board' })
    })
  }
  const abandonWork = (workId: string, ticketKey: string): void => {
    if (!confirm(`Abandon ${ticketKey}? The worktree is removed and the build session deleted. The branch is only deleted if fully merged — otherwise revva keeps it.`)) return
    void window.revva.work.abandon(workId).then((note) => {
      if (note) alert(note)
      qc.invalidateQueries({ queryKey: ['works'] })
      if (view.kind === 'work' && view.workId === workId) setView({ kind: 'board' })
    })
  }

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
          <NavButton
            icon={<Github className="size-4" />}
            label="GitHub"
            active={view.kind === 'github'}
            onClick={() => setView({ kind: 'github' })}
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
              actions={
                <NavAction
                  title="Abandon work"
                  onClick={() => abandonWork(w.id, w.ticketKey)}
                />
              }
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
              actions={<NavAction title="Delete chat" onClick={() => deleteChat(c.sessionId, c.title)} />}
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
        <div className="drag-region flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <span className="no-drag text-[13px] font-medium capitalize text-muted-foreground">
            {view.kind === 'work' ? activeWork?.ticketKey : view.kind === 'chat' ? 'Chat' : view.kind}
          </span>
          {runningWorks.slice(0, 3).map((w) => (
            <button
              key={w.id}
              onClick={() => setView({ kind: 'work', workId: w.id })}
              className={cn(
                'no-drag flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent',
                w.state === 'BUILDING' && 'border-sky-500/40 text-sky-700 dark:text-sky-400',
                w.state === 'REVIEW' && 'border-violet-500/40 text-violet-700 dark:text-violet-400',
                w.state === 'FIXING' && 'border-orange-500/40 text-orange-700 dark:text-orange-400',
                w.state === 'REWORK' && 'border-pink-500/40 text-pink-700 dark:text-pink-400',
                w.state === 'WAITING_HUMAN' && 'border-amber-500/40 text-amber-700 dark:text-amber-400'
              )}
              title={`${w.ticketKey} · ${w.state}`}
            >
              <Hammer className={cn('size-3', (w.state === 'BUILDING' || w.state === 'REVIEW' || w.state === 'FIXING' || w.state === 'REWORK') && 'animate-pulse')} />
              {w.ticketKey}
              <span className="opacity-70">{w.state === 'WAITING_HUMAN' ? 'needs you' : w.state.toLowerCase()}</span>
            </button>
          ))}
          {runningWorks.length > 3 && (
            <Badge variant="outline" className="no-drag font-normal">+{runningWorks.length - 3} more</Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setView({ kind: 'inbox' })}
              className={cn(
                'no-drag flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors hover:bg-accent',
                waitingCount > 0
                  ? 'border-amber-500/40 text-amber-700 dark:text-amber-400'
                  : 'text-muted-foreground'
              )}
            >
              <InboxIcon className="size-3.5" />
              {waitingCount > 0 ? `${waitingCount} waiting on you` : 'Inbox clear'}
            </button>
            {st?.state === 'connected' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="no-drag flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    opencode v{st.version}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{st.url}</TooltipContent>
              </Tooltip>
            ) : (
              <Badge variant="outline" className={cn('no-drag font-normal', stateInfo.cls)}>
                {stateInfo.label}
              </Badge>
            )}
          </div>
        </div>
        {view.kind === 'setup' ? (
          <SetupView />
        ) : view.kind === 'inbox' ? (
          <InboxView />
        ) : view.kind === 'scripts' ? (
          <ScriptsView />
        ) : view.kind === 'github' ? (
          <GitHubView onOpenChat={(sessionId) => setView({ kind: 'chat', sessionId })} />
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
  onClick,
  actions
}: {
  icon: React.ReactNode
  label: string
  sublabel?: string
  badge?: number
  active: boolean
  onClick: () => void
  /** Hover-revealed buttons (e.g. delete). */
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'group/nav relative flex w-full items-center rounded-md text-left text-[13px] hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent font-medium'
      )}
    >
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
        {icon}
        <span className="truncate">{label}</span>
        {badge !== undefined && (
          <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
            {badge}
          </span>
        )}
        {sublabel && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{sublabel}</span>}
      </button>
      {actions && (
        <span className="absolute right-1 hidden items-center gap-0.5 rounded-md bg-sidebar-accent group-hover/nav:flex">
          {actions}
        </span>
      )}
    </div>
  )
}

/** Tiny hover button for row actions (delete/abandon). */
function NavAction({ title, onClick }: { title: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
    >
      <Trash2 className="size-3.5" />
    </button>
  )
}
