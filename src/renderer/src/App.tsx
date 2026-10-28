import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Plus, Settings, Server, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { SetupView } from '@/views/Setup'
import { ChatView } from '@/views/Chat'
import { NewChatDialog } from '@/views/NewChatDialog'

type View = { kind: 'chat'; sessionId: string } | { kind: 'setup' }

const serviceStateLabels = {
  connecting: { label: 'Connecting…', cls: 'text-muted-foreground' },
  connected: { label: 'Connected', cls: 'text-emerald-600 dark:text-emerald-400' },
  missing: { label: 'OpenCode not found', cls: 'text-destructive' },
  error: { label: 'Service error', cls: 'text-destructive' }
} as const

export default function App(): React.JSX.Element {
  const qc = useQueryClient()
  const [view, setView] = useState<View>({ kind: 'setup' })
  const [newChatOpen, setNewChatOpen] = useState(false)

  const status = useQuery({
    queryKey: ['service-status'],
    queryFn: () => window.revva.service.status(),
    refetchInterval: 10_000
  })
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => window.revva.chat.list() })

  useEffect(() => {
    return window.revva.events.on((event) => {
      if (event.kind === 'service') {
        qc.setQueryData(['service-status'], event.status)
        if (event.status.state === 'connected') void chats.refetch()
      }
      if (event.kind === 'chat.idle' || event.kind === 'chat.message') {
        void chats.refetch()
        void qc.invalidateQueries({ queryKey: ['chat-messages', event.kind === 'chat.message' ? event.sessionId : ''] })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc])

  // First launch: once connected and no chats exist, offer New Chat via setup CTA; if chats exist open the latest.
  useEffect(() => {
    if (view.kind === 'setup' && status.data?.state === 'connected' && (chats.data?.length ?? 0) > 0) {
      const last = chats.data![0]!
      setView({ kind: 'chat', sessionId: last.sessionId })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.state, chats.data?.length])

  const st = status.data
  const stateInfo = serviceStateLabels[st?.state ?? 'connecting']

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="drag-region flex h-11 items-center px-3 pl-20">
          <span className="text-[13px] font-semibold tracking-wide">revva</span>
        </div>
        <div className="px-3 pb-2">
          <Button size="sm" className="w-full justify-start gap-2" onClick={() => setNewChatOpen(true)} disabled={st?.state !== 'connected'}>
            <Plus className="size-4" /> New chat
          </Button>
        </div>
        <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Chats
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {chats.isLoading && <Skeleton className="mx-1 h-8" />}
          {chats.data?.map((c) => (
            <button
              key={c.sessionId}
              onClick={() => setView({ kind: 'chat', sessionId: c.sessionId })}
              className={cn(
                'flex w-full items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-sidebar-accent',
                view.kind === 'chat' && view.sessionId === c.sessionId && 'bg-sidebar-accent font-medium'
              )}
            >
              <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{c.title}</span>
            </button>
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
        <div className="drag-region flex h-11 shrink-0 items-center justify-end border-b px-3">
          {st?.state === 'connected' && (
            <Badge variant="outline" className="no-drag font-normal">
              opencode v{st.version}
            </Badge>
          )}
        </div>
        {view.kind === 'setup' ? <SetupView /> : <ChatView key={view.sessionId} sessionId={view.sessionId} />}
      </main>

      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onCreated={(sessionId) => setView({ kind: 'chat', sessionId })}
      />
    </div>
  )
}
