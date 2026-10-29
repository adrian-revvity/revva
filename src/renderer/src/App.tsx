import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MessageSquare,
  Plus,
  Settings,
  Kanban,
  LayoutDashboard,
  Hammer,
  Terminal,
  Github,
  Trash2,
  FolderGit2,
  TriangleAlert,
  ChevronRight,
  Undo2,
  Eraser,
  Coffee,
  Inbox as InboxIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ConnectionStatus } from '@/components/ConnectionStatus'
import { cn } from '@/lib/utils'
import { subscribeTranscripts } from '@/lib/transcript-stream'
import { isActiveWorkState, workStateLabels } from '@/lib/work-state'
import { parsePrRef } from '@shared/pr-ref'
import { SetupView } from '@/views/Setup'
import { ChatView } from '@/views/Chat'
import { NewChatDialog } from '@/views/NewChatDialog'
import { WorktreesDialog, WorktreeRemovalDialog, type WorktreeRemovalRow } from '@/views/WorktreesDialog'
import { DashboardView } from '@/views/DashboardView'
import { BoardView } from '@/views/BoardView'
import { WorkCockpit } from '@/views/WorkCockpit'
import { InboxView, useInbox } from '@/views/InboxView'
import { useGithubAlerts } from '@/views/GitHubView'
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
  const [abandonTarget, setAbandonTarget] = useState<{ workId: string; row: WorktreeRemovalRow } | null>(null)
  const [abandonBusy, setAbandonBusy] = useState(false)

  useEffect(() => subscribeTranscripts(qc), [qc])

  const status = useQuery({
    queryKey: ['service-status'],
    queryFn: () => window.revva.service.status(),
    // Slow heartbeat only — reality arrives via the 'service' push from main.
    refetchInterval: 60_000
  })
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list() })
  const works = useQuery({ queryKey: ['works'], queryFn: () => window.revva.work.list() })
  // The cleanup list includes linked worktrees in known repos, not main checkouts.
  const worktrees = useQuery({
    queryKey: ['worktrees'],
    queryFn: () => window.revva.worktrees.list(),
    staleTime: 10_000,
    refetchInterval: 60_000
  })
  const activity = useQuery({
    queryKey: ['session-activity'],
    queryFn: () => window.revva.session.active(),
    enabled: status.data?.state === 'connected',
  })
  // Local workspace metadata is cheap; network picker inventory belongs to an
  // open dialog, not every background/read-only conversation surface.
  useQuery({ queryKey: ['workspaces'], queryFn: () => window.revva.workspace.list(), staleTime: 5 * 60_000 })
  useQuery({ queryKey: ['agents'], queryFn: () => window.revva.inventory.agents(), staleTime: 60_000, enabled: newChatOpen && status.data?.state === 'connected' })
  useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models(), staleTime: 60_000, enabled: newChatOpen && status.data?.state === 'connected' })
  const pending = useInbox()
  const ghAlerts = useGithubAlerts()
  const worktreeCount = worktrees.data?.length
  const worktreeWarning = worktreeCount !== undefined && worktreeCount > 10
  const worktreeDescription = worktreeCount === undefined
    ? worktrees.isLoading ? 'Checking worktrees' : 'Worktree count unavailable'
    : `${worktreeCount} linked worktrees in known repos${worktrees.isError ? ' (last known count)' : ''}${worktreeWarning ? ' · review for cleanup' : ''}`

  useEffect(() => {
    return window.revva.events.on((event) => {
      if (event.kind === 'service') {
        qc.setQueryData(['service-status'], event.status)
        if (event.status.state === 'connected') {
          void chats.refetch()
          void qc.invalidateQueries({ queryKey: ['session-activity'] })
        }
      }
      if (event.kind === 'chat.idle' || event.kind === 'chat.message' || event.kind === 'chat.renamed') void chats.refetch()
      if (event.kind === 'chat.idle' && event.sessionId === '*') void qc.invalidateQueries({ queryKey: ['session-activity'] })
      if (event.kind === 'session.activity') {
        const hadSnapshot = !!qc.getQueryData<string[]>(['session-activity'])
        void qc.cancelQueries({ queryKey: ['session-activity'] })
        qc.setQueryData<string[]>(['session-activity'], (old) => {
          const ids = new Set(old ?? [])
          if (event.running) ids.add(event.sessionId)
          else ids.delete(event.sessionId)
          return [...ids]
        })
        // Even the initial snapshot can race a start/finish event. Apply the
        // event immediately, then fetch the other sessions if none were known.
        if (!hadSnapshot) void qc.invalidateQueries({ queryKey: ['session-activity'] })
      }
      if (event.kind === 'work.updated') void works.refetch()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc])

  const st = status.data
  const stateInfo = serviceStateLabels[st?.state ?? 'connecting']
  const activeWork =
    view.kind === 'work' ? works.data?.find((w) => w.id === view.workId)
      : view.kind === 'chat' ? works.data?.find((w) => w.sessionId === view.sessionId && w.state !== 'ABANDONED') : undefined
  const sessionActivity = (sessionId: string): SessionActivity => {
    if (status.data?.state !== 'connected' || activity.isError) return 'Unavailable'
    if (pending.some((item) => item.sessionID === sessionId)) return 'Needs you'
    if (!activity.data) return 'Checking…'
    return activity.data.includes(sessionId) ? 'Thinking' : 'Ready'
  }
  const selectedSessionId = view.kind === 'chat' ? view.sessionId : activeWork?.sessionId
  const selectedActivity = selectedSessionId ? sessionActivity(selectedSessionId) : undefined
  const ticketWorks = (works.data ?? []).filter((w) => !!w.ticketKey && w.state !== 'ABANDONED')
  const ongoingWorks = ticketWorks.filter((w) => w.state !== 'SHIPPED')
  const ticketGroups = new Map<string, { works: typeof ticketWorks; chats: NonNullable<typeof chats.data> }>()
  for (const w of ticketWorks) {
    // One conversation per session, even when it also has pipeline properties.
    if (chats.data?.some((c) => c.sessionId === w.sessionId)) continue
    const group = ticketGroups.get(w.ticketKey) ?? { works: [], chats: [] }
    group.works.push(w)
    ticketGroups.set(w.ticketKey, group)
  }
  for (const chat of chats.data ?? []) {
    if (!chat.ticketKey) continue
    const group = ticketGroups.get(chat.ticketKey) ?? { works: [], chats: [] }
    group.chats.push(chat)
    ticketGroups.set(chat.ticketKey, group)
  }
  const prGroups = new Map<string, NonNullable<typeof chats.data>>()
  for (const chat of chats.data ?? []) {
    if (chat.ticketKey || !chat.prUrl) continue
    const group = prGroups.get(chat.prUrl) ?? []
    group.push(chat)
    prGroups.set(chat.prUrl, group)
  }
  const runningWorks = ongoingWorks.filter((w) => w.id !== activeWork?.id && isActiveWorkState(w.state))
  // Inbox badge: pending questions/permissions + finished runs nobody has seen.
  const inboxCount =
    pending.length +
    (chats.data ?? []).filter((c) => c.unread && !works.data?.some((w) => w.sessionId === c.sessionId && w.state !== 'ABANDONED')).length +
    (works.data ?? []).filter((w) => w.unread).length
  const waitingCount = inboxCount

  const deleteChat = (sessionId: string, title: string): void => {
    if (!confirm(`Delete chat "${title}"? The OpenCode session is removed too.`)) return
    void window.revva.chat.remove(sessionId).then(() => {
      qc.invalidateQueries({ queryKey: ['chats'] })
      if (view.kind === 'chat' && view.sessionId === sessionId) setView({ kind: 'dashboard' })
    }).catch((err) => alert(`Could not delete conversation: ${(err as Error).message}`))
  }
  const unlinkFromTicket = (sessionId: string): void => {
    void window.revva.chat
      .setTicket(sessionId, null)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['chats'] })
        void qc.invalidateQueries({ queryKey: ['works'] })
      })
      .catch((err) => alert(`Could not remove ticket link: ${(err as Error).message}`))
  }
  /** Hover actions on a chat row: unlink while it lives in a ticket group, plus delete. */
  const chatActions = (chat: { sessionId: string; title: string; ticketKey?: string }): React.JSX.Element => (
    <>
      {chat.ticketKey && (
        <NavAction title="Remove from ticket (keeps the chat)" neutral onClick={() => unlinkFromTicket(chat.sessionId)} icon={<Undo2 className="size-3.5" />} />
      )}
      <NavAction title="Delete chat" onClick={() => deleteChat(chat.sessionId, chat.title)} />
    </>
  )
  /** Flat (unticketed) chats at rest — not thinking, not waiting on you, not
   *  unread, not the one on screen — the bulk-clear target. Unknown activity
   *  (service down) shows no button at all. */
  const idleChats =
    status.data?.state === 'connected' && activity.data
      ? (chats.data ?? []).filter(
          (c) =>
            !c.ticketKey &&
            !c.unread &&
            !pending.some((item) => item.sessionID === c.sessionId) &&
            !activity.data?.includes(c.sessionId) &&
            !(view.kind === 'chat' && view.sessionId === c.sessionId)
        )
      : []
  const clearIdleChats = (): void => {
    if (idleChats.length === 0) return
    if (
      !confirm(
        `Delete ${idleChats.length} idle chat${idleChats.length === 1 ? '' : 's'}?\n\n${idleChats
          .slice(0, 8)
          .map((c) => `• ${c.title}`)
          .join('\n')}${idleChats.length > 8 ? `\n…and ${idleChats.length - 8} more` : ''}\n\nThe OpenCode sessions are removed too.`
      )
    )
      return
    void Promise.all(idleChats.map((c) => window.revva.chat.remove(c.sessionId).catch((err) => console.error('[chat] clear idle failed:', c.sessionId, err)))).then(() =>
      qc.invalidateQueries({ queryKey: ['chats'] })
    )
  }
  const abandonWork = (workId: string, ticketKey: string): void => {
    const work = works.data?.find((w) => w.id === workId)
    if (work?.ownsWorktree === false && work.sessionId) {
      unlinkFromTicket(work.sessionId)
      setView({ kind: 'chat', sessionId: work.sessionId })
      return
    }
    // Preview first (read-only): the dialog shows exactly what removal destroys
    // and demands a per-worktree tick whenever files would go. A thrown refusal
    // (locked, unregistered, unreadable state) means nothing may be touched.
    void window.revva.work
      .abandonPreflight(workId)
      .then((p) => {
        const row: WorktreeRemovalRow = {
          label: p.ticketKey,
          directory: p.worktreeDir,
          branch: p.branch,
          preflight: p.worktree
        }
        setAbandonTarget({ workId, row })
      })
      .catch((err) =>
        alert(`Cannot abandon ${ticketKey} yet: ${(err as Error).message}\nNothing was removed.`)
      )
  }
  const confirmAbandon = (workId: string, confirmedDirs: Set<string>): void => {
    const row = abandonTarget?.row
    setAbandonBusy(true)
    void window.revva.work
      .abandon({
        id: workId,
        confirmedSignature: row?.preflight.signature ?? '',
        confirmed: row ? confirmedDirs.has(row.preflight.directory) : false
      })
      .then((note) => {
        setAbandonTarget(null)
        if (note) alert(note)
        qc.invalidateQueries({ queryKey: ['works'] })
        qc.invalidateQueries({ queryKey: ['chats'] })
        if (view.kind === 'work' && view.workId === workId) setView({ kind: 'dashboard' })
      })
      .catch((err) => {
        // Refused or failed: the work keeps its state, files, session and
        // review rounds — abandon never cancels anything, so a refusal (an
        // in-flight review, drift from the confirmed state, a locked or
        // unregistered path) changes nothing and the user can retry.
        setAbandonTarget(null)
        alert(`Abandon failed: ${(err as Error).message}`)
        qc.invalidateQueries({ queryKey: ['works'] })
      })
      .finally(() => setAbandonBusy(false))
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
            icon={<InboxIcon className={cn('size-4', inboxCount > 0 && 'text-amber-500')} />}
            label="Inbox"
            badge={inboxCount > 0 ? inboxCount : undefined}
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
            icon={<Github className={cn('size-4', ghAlerts.length > 0 && 'text-amber-500')} />}
            label="GitHub"
            badge={ghAlerts.length > 0 ? ghAlerts.length : undefined}
            active={view.kind === 'github'}
            onClick={() => setView({ kind: 'github' })}
          />
          <NavButton
            icon={<Terminal className="size-4" />}
            label="Scripts"
            active={view.kind === 'scripts'}
            onClick={() => setView({ kind: 'scripts' })}
          />
        </div>

        <Separator className="my-2" />

        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <h2 className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Tickets
          </h2>
          <div className="px-2">
            {works.isLoading && <Skeleton className="mx-1 h-8" />}
            {works.isError && <p className="px-2 py-1.5 text-xs text-muted-foreground">Couldn’t load tickets</p>}
            {!works.isLoading && !works.isError && !chats.isLoading && ticketGroups.size === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No ticket conversations</p>
            )}
            {[...ticketGroups].map(([key, group]) => (
              <Collapsible key={key} defaultOpen>
                <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-sidebar-ring">
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground group-data-[panel-open]:rotate-90" />
                  <span className="min-w-0 flex-1 truncate">{key}</span>
                  {(group.works.some((w) => w.unread) || group.chats.some((c) => c.unread)) && <span className="size-2 rounded-full bg-primary" aria-label="Unread conversation" />}
                  <span className="text-[10px] text-muted-foreground">{group.works.length + group.chats.length}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-3 border-l pl-1">
                    {group.works.map((w) => (
                      <NavButton key={w.id} icon={<Hammer className={cn('size-4', w.state === 'BUILDING' && 'animate-pulse text-sky-500')} />}
                        label={w.state === 'SHIPPED' ? 'Shipped work' : 'Ticket work'} sublabel={workStateLabels[w.state]}
                        activity={w.sessionId && w.state !== 'WAITING_HUMAN' ? sessionActivity(w.sessionId) : undefined}
                        unread={!!w.unread} active={view.kind === 'work' && view.workId === w.id}
                        onClick={() => setView({ kind: 'work', workId: w.id })}
                        actions={<NavAction title={w.ownsWorktree === false ? 'Remove ticket link (keeps files and conversation)' : 'Abandon work'} onClick={() => abandonWork(w.id, w.ticketKey)} />} />
                    ))}
                    {group.chats.map((c) => {
                      const linkedWork = ticketWorks.find((w) => w.sessionId === c.sessionId)
                      return (
                        <NavButton key={c.sessionId} icon={c.prUrl ? <Hammer className="size-4 shrink-0" /> : <MessageSquare className="size-4 shrink-0" />} label={c.title}
                          sublabel={linkedWork ? workStateLabels[linkedWork.state] : undefined}
                          activity={sessionActivity(c.sessionId)} unread={!!c.unread} active={view.kind === 'chat' && view.sessionId === c.sessionId}
                          onClick={() => {
                            setView({ kind: 'chat', sessionId: c.sessionId })
                            if (c.unread) void window.revva.chat.markSeen(c.sessionId).then(() => chats.refetch())
                          }}
                          actions={chatActions(c)} />
                      )
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
          <Separator className="my-2" />
          {prGroups.size > 0 && <>
            <h2 className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Pull requests</h2>
            <div className="px-2">
              {[...prGroups].map(([url, conversations]) => {
                const ref = parsePrRef(url)
                return <Collapsible key={url} defaultOpen>
                  <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-sidebar-accent" title={url}>
                    <Github className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{ref?.repo ? `${ref.repo}#${ref.number}` : url}</span>
                    <span className="text-[10px] text-muted-foreground">{conversations.length}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="ml-3 border-l pl-1">
                      {conversations.map((chat) => <NavButton key={chat.sessionId} icon={<MessageSquare className="size-4" />} label={chat.title}
                        activity={sessionActivity(chat.sessionId)} unread={!!chat.unread} active={view.kind === 'chat' && view.sessionId === chat.sessionId}
                        onClick={() => {
                          setView({ kind: 'chat', sessionId: chat.sessionId })
                          if (chat.unread) void window.revva.chat.markSeen(chat.sessionId).then(() => chats.refetch())
                        }} actions={chatActions(chat)} />)}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              })}
            </div>
            <Separator className="my-2" />
          </>}
          <h2 className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Chats
          </h2>
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
          <div className="px-2">
            {chats.isLoading && <Skeleton className="mx-1 h-8" />}
            {chats.data?.filter((c) => !c.ticketKey && !c.prUrl).map((c) => (
              <NavButton
                key={c.sessionId}
                icon={c.prUrl ? <Hammer className="size-4 shrink-0" /> : <MessageSquare className="size-4 shrink-0" />}
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
                actions={chatActions(c)}
              />
            ))}
            {idleChats.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="mt-1 w-full justify-center gap-1.5 text-muted-foreground hover:text-destructive"
                    onClick={clearIdleChats}
                  >
                    <Eraser className="size-3.5" /> Clear {idleChats.length} idle chat{idleChats.length === 1 ? '' : 's'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Chats at rest right now — thinking, waiting-on-you, unread and open chats are kept
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        <Separator />
        <div className="flex items-center justify-between px-3 py-2">
          <ConnectionStatus status={st} />
          <KeepAwakeToggle />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 gap-1 px-1.5', worktreeWarning && 'text-amber-700 dark:text-amber-400')}
                aria-label={`Open worktree cleanup; ${worktreeDescription}`}
                onClick={() => setWorktreesOpen(true)}
              >
                <FolderGit2 className="size-3.5" />
                {worktreeCount !== undefined && <span className="text-[11px] tabular-nums">{worktreeCount}</span>}
                {worktreeWarning && <TriangleAlert className="size-3.5" aria-hidden="true" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{worktreeDescription}</TooltipContent>
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
            {view.kind === 'work' || view.kind === 'chat' ? 'Conversation' : <span className="capitalize">{view.kind}</span>}
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
          <InboxView
            onOpenChat={(sessionId) => setView({ kind: 'chat', sessionId })}
            onOpenWork={(workId) => setView({ kind: 'work', workId })}
          />
        ) : view.kind === 'scripts' ? (
          <ScriptsView />
        ) : view.kind === 'github' ? (
          <GitHubView onOpenChat={(sessionId) => setView({ kind: 'chat', sessionId })} />
        ) : view.kind === 'jira' ? (
          <BoardView
            works={works.data ?? []}
            onStart={(workId) => setView({ kind: 'work', workId })}
            onOpenChat={(sessionId) => setView({ kind: 'chat', sessionId })}
          />
        ) : view.kind === 'work' ? (
          activeWork ? (
            <WorkCockpit key={activeWork.sessionId ?? activeWork.id} work={activeWork} onOpenChat={(sessionId) => setView({ kind: 'chat', sessionId })} />
          ) : (
            <div className="p-8 text-sm text-muted-foreground">Loading work…</div>
          )
        ) : (
          <ChatView key={view.sessionId} sessionId={view.sessionId} onOpenChat={(sessionId) => setView({ kind: 'chat', sessionId })} />
        )}
      </main>

      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onCreated={(sessionId) => setView({ kind: 'chat', sessionId })}
      />

      <WorktreesDialog
        open={worktreesOpen}
        onOpenChange={setWorktreesOpen}
        onOpenChat={(sessionId) => setView({ kind: 'chat', sessionId })}
      />

      <WorktreeRemovalDialog
        open={abandonTarget !== null}
        onOpenChange={(next) => !next && !abandonBusy && setAbandonTarget(null)}
        title={`Abandon ${abandonTarget?.row.label ?? ''}?`}
        intro="Removal re-fingerprints staged contents and files right before deleting and aborts when content was staged, added, removed, or normally edited since this preview — a same-size rewrite with restored timestamps, or writes after the last check, cannot be caught. Tick the worktree if its files would be destroyed. Unmerged branches are always kept."
        rows={abandonTarget ? [abandonTarget.row] : []}
        confirmLabel="Abandon"
        busy={abandonBusy}
        onConfirm={(confirmedDirs) => abandonTarget && confirmAbandon(abandonTarget.workId, confirmedDirs)}
      />
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
        {(sublabel || (activity && activity !== 'Ready')) && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {sublabel && <span className="text-[10px] text-muted-foreground">{sublabel}</span>}
            {activity && activity !== 'Ready' && (
              <span className={cn(
                'text-[10px] font-medium',
                activity === 'Needs you' ? 'text-amber-700 dark:text-amber-400' :
                  activity === 'Thinking' ? 'text-sky-700 dark:text-sky-400' : 'text-muted-foreground'
              )}>
                {activity === 'Thinking' ? 'Thinking…' : activity}
              </span>
            )}
          </span>
        )}
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

/** Caffeinate equivalent: when on, the laptop is kept from sleeping. */
function KeepAwakeToggle(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    void window.revva.keepAwake.get().then(setEnabled)
  }, [])
  const toggle = (): void => {
    void window.revva.keepAwake.set(!enabled).then(setEnabled)
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('size-7', enabled && 'text-amber-600 dark:text-amber-400')}
          aria-pressed={enabled}
          aria-label={enabled ? 'Keep awake on — click to allow sleep' : 'Keep awake off — click to prevent sleep'}
          onClick={toggle}
        >
          <Coffee className={cn('size-3.5', enabled && 'motion-safe:animate-pulse')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {enabled ? 'Keeping this Mac awake — click to allow sleep' : 'Prevent sleep while agents run'}
      </TooltipContent>
    </Tooltip>
  )
}

/** Tiny hover button for row actions (delete/abandon/unlink). */
function NavAction({ title, onClick, icon, neutral }: { title: string; onClick: () => void; icon?: React.ReactNode; neutral?: boolean }): React.JSX.Element {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn('rounded p-1 text-muted-foreground', neutral ? 'hover:bg-accent hover:text-foreground' : 'hover:bg-destructive/15 hover:text-destructive')}
    >
      {icon ?? <Trash2 className="size-3.5" />}
    </button>
  )
}
