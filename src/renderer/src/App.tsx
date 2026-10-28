import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MessageSquare,
  Plus,
  Settings,
  Server,
  RefreshCw,
  Kanban,
  LayoutDashboard,
  Hammer,
  Terminal,
  Github,
  Trash2,
  FolderGit2,
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
import { WorktreesDialog } from '@/views/WorktreesDialog'
import { DashboardView } from '@/views/DashboardView'
import { BoardView } from '@/views/BoardView'
import { WorkCockpit } from '@/views/WorkCockpit'
import { InboxView, useInbox } from '@/views/InboxView'
import { ScriptsView } from '@/views/ScriptsView'
import { GitHubView } from '@/views/GitHubView'

type View =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'setup' }
  | { kind: 'dashboard' }
  | { kind: 'jira' }
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

type SessionActivity = 'Thinking' | 'Needs you' | 'Ready' | 'Checking…' | 'Unavailable'

export default function App(): React.JSX.Element {
  const qc = useQueryClient()
  const [view, setView] = useState<View>({ kind: 'dashboard' })
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [worktreesOpen, setWorktreesOpen] = useState(false)

  const status = useQuery({
    queryKey: ['service-status'],
    queryFn: () => window.revva.service.status(),
    refetchInterval: 10_000
  })
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list() })
  const works = useQuery({ queryKey: ['works'], queryFn: () => window.revva.work.list() })
  const activity = useQuery({
    queryKey: ['session-activity'],
    queryFn: () => window.revva.session.active(),
    enabled: status.data?.state === 'connected',
    refetchInterval: 5000
  })
  const pending = useInbox()

  useEffect(() => {
    return window.revva.events.on((event) => {
      if (event.kind === 'service') {
        qc.setQueryData(['service-status'], event.status)
        if (event.status.state === 'connected') {
          void chats.refetch()
          void qc.invalidateQueries({ queryKey: ['session-activity'] })
        }
      }
      if (event.kind === 'chat.idle' || event.kind === 'chat.message') void chats.refetch()
      if (event.kind === 'chat.idle' && event.sessionId === '*') void qc.invalidateQueries({ queryKey: ['session-activity'] })
      if (event.kind === 'session.activity') {
        if (!qc.getQueryData<string[]>(['session-activity'])) {
          void qc.invalidateQueries({ queryKey: ['session-activity'] })
          return
        }
        void qc.cancelQueries({ queryKey: ['session-activity'] })
        qc.setQueryData<string[]>(['session-activity'], (old) => {
          const ids = new Set(old ?? [])
          if (event.running) ids.add(event.sessionId)
          else ids.delete(event.sessionId)
          return [...ids]
        })
      }
      if (event.kind === 'work.updated') void works.refetch()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc])

  const st = status.data
  const stateInfo = serviceStateLabels[st?.state ?? 'connecting']
  const activeWork =
    view.kind === 'work' ? works.data?.find((w) => w.id === view.workId) : undefined
  const activeChat = view.kind === 'chat' ? chats.data?.find((c) => c.sessionId === view.sessionId) : undefined
  const sessionActivity = (sessionId: string): SessionActivity => {
    if (status.data?.state !== 'connected' || activity.isError) return 'Unavailable'
    if (pending.some((item) => item.sessionID === sessionId)) return 'Needs you'
    if (!activity.data) return 'Checking…'
    return activity.data.includes(sessionId) ? 'Thinking' : 'Ready'
  }
  const selectedSessionId = view.kind === 'chat' ? view.sessionId : activeWork?.sessionId
  const selectedActivity = selectedSessionId ? sessionActivity(selectedSessionId) : undefined
  const runningWorks = (works.data ?? []).filter(
    (w) => w.state === 'BUILDING' || w.state === 'REVIEW' || w.state === 'FIXING' || w.state === 'REWORK' || w.state === 'WAITING_HUMAN'
  )
  const waitingCount = pending.length

  const deleteChat = (sessionId: string, title: string): void => {
    if (!confirm(`Delete chat "${title}"? The OpenCode session is removed too.`)) return
    void window.revva.chat.remove(sessionId).then(() => {
      qc.invalidateQueries({ queryKey: ['chats'] })
      if (view.kind === 'chat' && view.sessionId === sessionId) setView({ kind: 'dashboard' })
    })
  }
  const abandonWork = (workId: string, ticketKey: string): void => {
    if (!confirm(`Abandon ${ticketKey}? The worktree is removed and the build session deleted. The branch is only deleted if fully merged — otherwise revva keeps it.`)) return
    void window.revva.work.abandon(workId).then((note) => {
      if (note) alert(note)
      qc.invalidateQueries({ queryKey: ['works'] })
      if (view.kind === 'work' && view.workId === workId) setView({ kind: 'dashboard' })
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
            icon={<LayoutDashboard className="size-4" />}
            label="Dashboard"
            active={view.kind === 'dashboard'}
            onClick={() => setView({ kind: 'dashboard' })}
          />
          <NavButton
            icon={<InboxIcon className={cn('size-4', pending.length > 0 && 'text-amber-500')} />}
            label="Inbox"
            badge={pending.length > 0 ? pending.length : undefined}
            active={view.kind === 'inbox'}
            onClick={() => setView({ kind: 'inbox' })}
          />
          <NavButton
            icon={<Kanban className="size-4" />}
            label="Jira"
            active={view.kind === 'jira'}
            onClick={() => setView({ kind: 'jira' })}
          />
          <NavButton
            icon={<Github className="size-4" />}
            label="GitHub"
            active={view.kind === 'github'}
            onClick={() => setView({ kind: 'github' })}
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
              activity={w.sessionId ? sessionActivity(w.sessionId) : undefined}
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
              icon={<MessageSquare className="size-4 shrink-0" />}
              label={c.title}
              activity={sessionActivity(c.sessionId)}
              unread={!!c.unread}
              active={view.kind === 'chat' && view.sessionId === c.sessionId}
              onClick={() => {
                setView({ kind: 'chat', sessionId: c.sessionId })
                if (c.unread) {
                  void window.revva.chat.markSeen(c.sessionId).then(() => chats.refetch())
                }
              }}
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
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setWorktreesOpen(true)}>
                <FolderGit2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clean up worktrees</TooltipContent>
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
          <span className="no-drag min-w-0 truncate text-[13px] font-medium text-muted-foreground">
            {view.kind === 'work' ? activeWork?.ticketKey : view.kind === 'chat' ? (activeChat?.title ?? 'Chat') : <span className="capitalize">{view.kind}</span>}
          </span>
          {selectedActivity && <ActivityBadge activity={selectedActivity} />}
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
        ) : view.kind === 'dashboard' ? (
          <DashboardView
            works={works.data ?? []}
            go={(section) => setView({ kind: section })}
            onOpenWork={(workId) => setView({ kind: 'work', workId })}
            onOpenChat={(sessionId) => setView({ kind: 'chat', sessionId })}
          />
        ) : view.kind === 'inbox' ? (
          <InboxView />
        ) : view.kind === 'scripts' ? (
          <ScriptsView />
        ) : view.kind === 'github' ? (
          <GitHubView onOpenChat={(sessionId) => setView({ kind: 'chat', sessionId })} />
        ) : view.kind === 'jira' ? (
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

      <WorktreesDialog open={worktreesOpen} onOpenChange={setWorktreesOpen} />
    </div>
  )
}

function NavButton({
  icon,
  label,
  sublabel,
  activity,
  badge,
  unread,
  active,
  onClick,
  actions
}: {
  icon: React.ReactNode
  label: string
  sublabel?: string
  activity?: SessionActivity
  badge?: number
  /** Run finished, user hasn't looked yet — solid dot instead of the icon. */
  unread?: boolean
  active: boolean
  onClick: () => void
  /** Hover-revealed buttons (e.g. delete). */
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'group/nav relative flex w-full items-center rounded-md text-left text-[13px] hover:bg-sidebar-accent',
        active && 'bg-sidebar-primary/10 font-semibold text-sidebar-foreground ring-1 ring-inset ring-sidebar-primary/40 hover:bg-sidebar-primary/15'
      )}
    >
      <button onClick={onClick} aria-current={active ? 'page' : undefined} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-sidebar-ring">
        {unread && !active ? (
          <span
            role="status"
            aria-label="Finished, unread"
            title="Finished — not viewed yet"
            className="ml-0.5 size-2 shrink-0 rounded-full bg-primary"
          />
        ) : (
          <span className="shrink-0">{icon}</span>
        )}
        <span className={cn('truncate', unread && !active && 'font-medium')}>{label}</span>
        {badge !== undefined && (
          <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
            {badge}
          </span>
        )}
        {activity && activity !== 'Ready' ? (
          <span className={cn(
            'ml-auto shrink-0 text-[10px] font-medium',
            activity === 'Needs you' ? 'text-amber-700 dark:text-amber-400' :
              activity === 'Thinking' ? 'text-sky-700 dark:text-sky-400' : 'text-muted-foreground'
          )}>
            {activity === 'Thinking' ? 'Thinking…' : activity}
          </span>
        ) : sublabel && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{sublabel}</span>}
      </button>
      {actions && (
        <span className="mr-1 hidden shrink-0 items-center gap-0.5 group-hover/nav:flex group-focus-within/nav:flex">
          {actions}
        </span>
      )}
    </div>
  )
}

function ActivityBadge({ activity }: { activity: SessionActivity }): React.JSX.Element {
  return (
    <span
      role="status"
      className={cn(
        'no-drag inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        activity === 'Thinking' ? 'border-sky-500/40 text-sky-700 dark:text-sky-400' :
          activity === 'Needs you' ? 'border-amber-500/40 text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
      )}
    >
      <span aria-hidden="true" className={cn('size-1.5 rounded-full bg-current', activity === 'Thinking' && 'motion-safe:animate-pulse')} />
      {activity === 'Thinking' ? 'Thinking…' : activity}
    </span>
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
