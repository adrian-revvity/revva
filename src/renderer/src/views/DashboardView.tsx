import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  ArrowRight,
  CircleCheck,
  CircleX,
  Github,
  Hammer,
  Inbox as InboxIcon,
  Kanban,
  LayoutDashboard,
  MessageSquare,
  Server,
  Terminal
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { WorkSummary } from '@shared/types'

type Section = 'inbox' | 'jira' | 'github' | 'scripts' | 'setup'

/**
 * Dashboard: at-a-glance summary of everything Revva knows — service health,
 * Jira sprint, inbox, active pipeline work, GitHub PRs, scripts, recent chats.
 * Read-only; every card deep-links into the owning view.
 */
export function DashboardView({
  works,
  go,
  onOpenWork,
  onOpenChat
}: {
  works: WorkSummary[]
  go: (section: Section) => void
  onOpenWork: (workId: string) => void
  onOpenChat: (sessionId: string) => void
}): React.JSX.Element {
  const status = useQuery({ queryKey: ['service-status'], queryFn: () => window.revva.service.status() })
  const jira = useQuery({ queryKey: ['jira-status'], queryFn: () => window.revva.jira.status() })
  const board = useQuery({
    queryKey: ['board'],
    queryFn: () => window.revva.jira.board(),
    enabled: !!jira.data?.connected,
    staleTime: 30_000
  })
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => window.revva.inbox.list() })
  const prsMine = useQuery({ queryKey: ['gh-prs', 'mine'], queryFn: () => window.revva.github.list('mine'), staleTime: 30_000 })
  const prsReview = useQuery({ queryKey: ['gh-prs', 'review'], queryFn: () => window.revva.github.list('review'), staleTime: 30_000 })
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list() })
  const scripts = useQuery({ queryKey: ['scripts'], queryFn: () => window.revva.scripts.list() })
  const scriptStatus = useQuery({ queryKey: ['script-status'], queryFn: () => window.revva.scripts.status() })

  const connected = status.data?.state === 'connected'
  const inboxItems = inbox.data ?? []
  const runningWorks = works.filter((w) =>
    ['BUILDING', 'REVIEW', 'FIXING', 'REWORK', 'WAITING_HUMAN'].includes(w.state)
  )
  const needsYouWorks = works.filter((w) => w.state === 'WAITING_HUMAN')
  const tickets = board.data ?? []
  const doneTickets = tickets.filter((t) => t.statusCategory?.toLowerCase() === 'done').length
  const prs = prsMine.data ?? []
  const reviewPrs = (prsReview.data ?? []).filter((p) => !p.merged)
  const prsNeedingAttention = prs.filter((p) => !p.merged && (p.reviewDecision === 'CHANGES_REQUESTED' || p.hasNewComments))
  const runningScripts = (scriptStatus.data ?? []).filter((s) => s.running)
  const recentChats = [...(chats.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
  const serviceDown = status.data && status.data.state !== 'connected'

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
        <header>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <LayoutDashboard className="size-5" /> Dashboard
          </h2>
          <p className="text-xs text-muted-foreground">
            Everything Revva is watching, at a glance. Click a card to jump in.
          </p>
        </header>

        {/* ---------- Stat cards ---------- */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            icon={<Server className="size-4" />}
            label="OpenCode"
            onClick={() => go('setup')}
            value={
              status.isPending ? (
                <Skeleton className="h-5 w-24" />
              ) : connected ? (
                <span className="flex items-center gap-1.5">
                  <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" /> v{status.data?.version}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-destructive">
                  <CircleX className="size-4" /> {status.data?.state === 'missing' ? 'Not found' : 'Offline'}
                </span>
              )
            }
            sub={connected ? status.data?.url : 'Open Setup to connect'}
          />
          <StatCard
            icon={<Kanban className="size-4" />}
            label="Jira sprint"
            onClick={() => go('jira')}
            value={
              !jira.data?.connected ? (
                <span className="text-muted-foreground">Not connected</span>
              ) : board.isPending ? (
                <Skeleton className="h-5 w-16" />
              ) : (
                `${tickets.length} tickets`
              )
            }
            sub={
              jira.data?.connected && tickets.length > 0 ? (
                <span className="block w-full space-y-1">
                  <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-emerald-500 transition-all"
                      style={{ width: `${tickets.length ? Math.round((doneTickets / tickets.length) * 100) : 0}%` }}
                    />
                  </span>
                  <span>
                    {doneTickets} done · {tickets.length - doneTickets} open
                  </span>
                </span>
              ) : (
                'Connect in Setup'
              )
            }
          />
          <StatCard
            icon={<InboxIcon className={cn('size-4', inboxItems.length > 0 && 'text-amber-500')} />}
            label="Inbox"
            onClick={() => go('inbox')}
            value={
              inboxItems.length > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">{inboxItems.length} waiting on you</span>
              ) : (
                'Clear'
              )
            }
            sub={inboxItems.length > 0 ? inboxItems.map((i) => i.title).slice(0, 2).join(' · ') : 'No forms or permissions pending'}
          />
          <StatCard
            icon={<Hammer className="size-4" />}
            label="Pipeline work"
            onClick={() => go('jira')}
            value={
              runningWorks.length > 0 ? (
                <span>
                  {runningWorks.length} active
                  {needsYouWorks.length > 0 && (
                    <span className="ml-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                      {needsYouWorks.length} need you
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">Nothing running</span>
              )
            }
            sub={
              runningWorks.length > 0
                ? runningWorks.slice(0, 2).map((w) => `${w.ticketKey} · ${w.state.toLowerCase()}`).join(' · ')
                : 'Start a ticket from the Jira board'
            }
          />
          <StatCard
            icon={<Github className="size-4" />}
            label="Pull requests"
            onClick={() => go('github')}
            value={
              prsMine.isPending && prsReview.isPending ? (
                <Skeleton className="h-5 w-16" />
              ) : prsMine.isError && prsReview.isError ? (
                <span className="text-muted-foreground">gh unavailable</span>
              ) : (
                `${prs.filter((p) => !p.merged).length} open`
              )
            }
            sub={`${reviewPrs.length} to review · ${prsNeedingAttention.length} with activity`}
          />
          <StatCard
            icon={<Terminal className="size-4" />}
            label="Scripts"
            onClick={() => go('scripts')}
            value={
              scripts.isPending ? (
                <Skeleton className="h-5 w-12" />
              ) : runningScripts.length > 0 ? (
                <span className="text-sky-600 dark:text-sky-400">{runningScripts.length} running</span>
              ) : (
                `${scripts.data?.length ?? 0} defined`
              )
            }
            sub={
              runningScripts.length > 0
                ? runningScripts.map((s) => scripts.data?.find((d) => d.id === s.id)?.name ?? s.id).join(' · ')
                : lastScriptRun(scriptStatus.data ?? [], scripts.data ?? [])
            }
          />
        </div>

        {serviceDown && (
          <button
            onClick={() => go('setup')}
            className="flex w-full items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-left text-xs text-destructive transition-colors hover:bg-destructive/10"
          >
            <CircleX className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              OpenCode service is {status.data?.state}: {status.data?.message ?? 'not reachable'} — most panels are limited until it reconnects.
            </span>
            <ArrowRight className="size-3.5 shrink-0" />
          </button>
        )}

        {/* ---------- Needs you ---------- */}
        <SectionHeader title="Needs you" icon={<InboxIcon className="size-4" />} />
        {inboxItems.length === 0 && needsYouWorks.length === 0 ? (
          <p className="rounded-lg border px-3 py-3 text-xs text-muted-foreground">All clear — nothing is blocked on you.</p>
        ) : (
          <div className="space-y-1.5">
            {needsYouWorks.map((w) => (
              <ListRow key={`work-${w.id}`} onClick={() => onOpenWork(w.id)}>
                <Hammer className="size-4 shrink-0 text-amber-500" />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  <span className="font-medium">{w.ticketKey}</span>{' '}
                  <span className="text-muted-foreground">{w.ticketSummary}</span>
                </span>
                <Badge variant="outline" className="shrink-0 border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400">
                  waiting on you
                </Badge>
              </ListRow>
            ))}
            {inboxItems.map((item) => (
              <ListRow key={`inbox-${item.id}`} onClick={() => go('inbox')}>
                <InboxIcon className="size-4 shrink-0 text-amber-500" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(item.createdAt)}</span>
              </ListRow>
            ))}
          </div>
        )}

        {/* ---------- Active work ---------- */}
        {runningWorks.length > 0 && (
          <>
            <SectionHeader title="Active work" icon={<Activity className="size-4" />} />
            <div className="space-y-1.5">
              {runningWorks.map((w) => (
                <ListRow key={w.id} onClick={() => onOpenWork(w.id)}>
                  <Hammer
                    className={cn('size-4 shrink-0', w.state === 'BUILDING' ? 'animate-pulse text-sky-500' : 'text-muted-foreground')}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="font-medium">{w.ticketKey}</span>{' '}
                    <span className="text-muted-foreground">{w.ticketSummary}</span>
                  </span>
                  <WorkStateBadge state={w.state} />
                </ListRow>
              ))}
            </div>
          </>
        )}

        {/* ---------- Pull requests ---------- */}
        {(prsNeedingAttention.length > 0 || reviewPrs.length > 0) && (
          <>
            <SectionHeader title="Pull requests" icon={<Github className="size-4" />} />
            <div className="space-y-1.5">
              {prsNeedingAttention.map((p) => (
                <ListRow key={`act-${p.url}`} onClick={() => go('github')}>
                  <MessageSquare className="size-4 shrink-0 text-orange-500" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="font-mono text-[11px] text-muted-foreground">{p.repo}</span> #{p.number} {p.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : `comment ${timeAgo(p.latestOtherCommentAt ?? p.updatedAt)}`}
                  </span>
                </ListRow>
              ))}
              {reviewPrs.slice(0, 4).map((p) => (
                <ListRow key={`rev-${p.url}`} onClick={() => go('github')}>
                  <Github className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="font-mono text-[11px] text-muted-foreground">{p.repo}</span> #{p.number} {p.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">requested from you · {timeAgo(p.updatedAt)}</span>
                </ListRow>
              ))}
            </div>
          </>
        )}

        {/* ---------- Recent chats ---------- */}
        <SectionHeader title="Recent chats" icon={<MessageSquare className="size-4" />} />
        {recentChats.length === 0 ? (
          <p className="rounded-lg border px-3 py-3 text-xs text-muted-foreground">
            No chats yet — pick a project folder in Setup, then “New chat”.
          </p>
        ) : (
          <div className="space-y-1.5">
            {recentChats.map((c) => (
              <ListRow key={c.sessionId} onClick={() => onOpenChat(c.sessionId)}>
                <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{c.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{shortDir(c.directory)}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(c.updatedAt)}</span>
              </ListRow>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------- Bits ---------- */

function SectionHeader({ title, icon }: { title: string; icon: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
      <span className="text-muted-foreground">{icon}</span> {title}
    </h3>
  )
}

function StatCard({
  icon,
  label,
  value,
  sub,
  onClick
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-1 rounded-lg border bg-card px-3.5 py-3 text-left transition-colors hover:bg-accent/50"
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {icon} {label}
        <ArrowRight className="ml-auto size-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
      </span>
      <span className="text-sm font-semibold">{value}</span>
      {sub && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{sub}</span>}
    </button>
  )
}

function ListRow({ children, onClick }: { children: React.ReactNode; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent"
    >
      {children}
    </button>
  )
}

const WORK_STATE_CLS: Record<string, string> = {
  BUILDING: 'border-sky-500/40 text-sky-700 dark:text-sky-400',
  REVIEW: 'border-violet-500/40 text-violet-700 dark:text-violet-400',
  FIXING: 'border-orange-500/40 text-orange-700 dark:text-orange-400',
  REWORK: 'border-pink-500/40 text-pink-700 dark:text-pink-400',
  WAITING_HUMAN: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  APPROVED: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
}

function WorkStateBadge({ state }: { state: WorkSummary['state'] }): React.JSX.Element {
  return (
    <Badge variant="outline" className={cn('shrink-0 text-[10px]', WORK_STATE_CLS[state])}>
      {state === 'WAITING_HUMAN' ? 'needs you' : state.toLowerCase()}
    </Badge>
  )
}

function lastScriptRun(
  statuses: { id: string; lastRunAt: number | null; running: boolean }[],
  defs: { id: string; name: string }[]
): string {
  const last = statuses.filter((s) => s.lastRunAt).sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))[0]
  if (!last?.lastRunAt) return 'Never run'
  const name = defs.find((d) => d.id === last.id)?.name ?? last.id
  return `Last: ${name} ${timeAgo(last.lastRunAt)}`
}

function shortDir(dir: string): string {
  const parts = dir.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
