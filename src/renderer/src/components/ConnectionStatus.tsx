import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ServiceStatus } from '@shared/types'

const serviceLabels: Record<ServiceStatus['state'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  missing: 'OpenCode not found',
  error: 'Service error'
}

export function ConnectionStatus({ status }: {
  status?: ServiceStatus
}): React.JSX.Element {
  const qc = useQueryClient()
  const connected = status?.state === 'connected'
  const jira = useQuery({ queryKey: ['jira-status'], queryFn: () => window.revva.jira.status(), refetchInterval: 30_000 })
  const retryJira = useMutation({
    mutationFn: async (action: 'retry' | 'sign-in') => {
      if (action === 'retry') await window.revva.jira.reconnect()
      else await window.revva.jira.connect()
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['jira-status'] })
      void qc.invalidateQueries({ queryKey: ['board'] })
    }
  })

  const jiraProblem = jira.isError || !!jira.data?.expired || !!(jira.data?.connected && jira.data.mcpConnected !== true)
  const checking = connected && jira.isLoading
  const problem = connected && jiraProblem
  const label = !connected ? serviceLabels[status?.state ?? 'connecting'] : problem ? 'Connection issues' : checking ? 'Checking…' : 'Connected'

  return (
    <Popover>
      <PopoverTrigger className={cn(
        'flex min-w-0 items-center gap-1.5 rounded text-left text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-ring',
        problem ? 'text-amber-700 dark:text-amber-400' : connected && !checking ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
        status?.state === 'error' || status?.state === 'missing' ? 'text-destructive' : ''
      )}>
        <Server className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="max-h-[min(70vh,32rem)] w-80 max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto p-3">
        <PopoverTitle>Connections</PopoverTitle>
        <div className="text-xs">
          <div className="font-medium">OpenCode · {serviceLabels[status?.state ?? 'connecting']}</div>
          {status?.message && <p className="mt-1 break-words text-muted-foreground">{status.message}</p>}
          {status?.url && <p className="mt-1 break-all text-muted-foreground">{status.url}{status.version ? ` · v${status.version}` : ''}</p>}
        </div>
        <div className="border-t pt-3 text-xs">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Jira · Revva connection</p>
              <p className="text-muted-foreground">{jira.isLoading ? 'Checking…' : jira.isError ? 'Status unavailable' : jira.data?.expired ? 'Sign-in expired' : jira.data?.connected && jira.data.mcpConnected === true ? 'Connected' : jira.data?.connected && jira.data.mcpConnected === undefined ? 'Signed in · connection status unavailable' : jira.data?.connected ? 'Connection unavailable' : 'Not configured'}</p>
            </div>
            {jira.isError && <Button size="sm" variant="outline" onClick={() => void jira.refetch()}>Retry status</Button>}
            {!jira.isLoading && !jira.isError && !(jira.data?.connected && jira.data.mcpConnected === true) && (
              <Button size="sm" variant="outline" disabled={retryJira.isPending} onClick={() => {
                if (jira.data?.connected && jira.data.mcpConnected === undefined) void jira.refetch()
                else retryJira.mutate(jira.data?.connected && jira.data.mcpConnected === false ? 'retry' : 'sign-in')
              }}>
                {retryJira.isPending ? 'Connecting…' : jira.data?.connected && jira.data.mcpConnected === undefined ? 'Check again' : jira.data?.connected && jira.data.mcpConnected === false ? 'Retry' : 'Sign in'}
              </Button>
            )}
          </div>
          {jira.isError && <p className="mt-1 break-words text-destructive">{jira.error instanceof Error ? jira.error.message : String(jira.error)}</p>}
          {retryJira.error && (
            <div className="mt-1 flex flex-col items-start gap-2">
              <p role="alert" className="break-words text-destructive">{retryJira.error instanceof Error ? retryJira.error.message : String(retryJira.error)}</p>
              {retryJira.variables === 'retry' && <Button size="sm" variant="outline" onClick={() => retryJira.mutate('sign-in')}>Sign in again</Button>}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
