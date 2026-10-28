import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderPlus, Trash2, CircleCheck, CircleX, CircleDashed } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * First-run setup + settings (REQ-SETUP-1/2): OpenCode connection status, workspace folders,
 * and the live inventory discovered from the user's own service. Jira/AWS arrive in M1/M3.
 */
export function SetupView(): React.JSX.Element {
  const qc = useQueryClient()
  const [newFolder, setNewFolder] = useState('')

  const status = useQuery({ queryKey: ['service-status'], queryFn: () => window.revva.service.status(), refetchInterval: 5000 })
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => window.revva.workspace.list() })
  const connected = status.data?.state === 'connected'
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => window.revva.inventory.agents(), enabled: connected })
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models(), enabled: connected })
  const skills = useQuery({ queryKey: ['skills'], queryFn: () => window.revva.inventory.skills(), enabled: connected })

  const addFolder = useMutation({
    mutationFn: async (path: string) => {
      if (path) return window.revva.workspace.add(path)
      const picked = await window.revva.workspace.pickFolder()
      if (!picked) throw new Error('cancelled')
      return window.revva.workspace.add(picked)
    },
    onSuccess: () => {
      setNewFolder('')
      void workspaces.refetch()
    }
  })

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-8 px-6 py-8">
        <header>
          <h1 className="text-xl font-semibold">Setup</h1>
          <p className="text-sm text-muted-foreground">
            Revva drives whatever your own OpenCode service exposes — no imported config required.
          </p>
        </header>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">OpenCode connection</h2>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-2 text-sm">
              {status.data?.state === 'connected' ? (
                <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
              ) : status.data?.state === 'missing' ? (
                <CircleX className="size-4 text-destructive" />
              ) : (
                <CircleDashed className="size-4 animate-spin text-muted-foreground" />
              )}
              <span>
                {status.data?.state === 'connected'
                  ? `Connected — v${status.data.version} @ ${status.data.url}`
                  : (status.data?.message ?? 'Connecting…')}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void window.revva.service.retry().then((s) => qc.setQueryData(['service-status'], s))
              }
            >
              Retry
            </Button>
          </div>
          {status.data?.state === 'missing' && (
            <p className="text-xs text-muted-foreground">
              Install OpenCode (https://opencode.ai), make sure the <code>opencode</code> command is on PATH, then Retry.
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">Jira</h2>
          <JiraSection />
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">Project folders</h2>
          <p className="text-xs text-muted-foreground">
            Folders Revva may create sessions and worktrees in. Add repos you work on (Jira tickets attach in M1).
          </p>
          <div className="space-y-1.5">
            {workspaces.data?.map((w) => (
              <div key={w.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                <span className="truncate font-mono text-xs">{w.path}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={() => void window.revva.workspace.remove(w.id).then(() => workspaces.refetch())}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="/path/to/repo (or leave empty to browse)"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addFolder.mutate(newFolder)}
              className="font-mono text-xs"
            />
            <Button size="sm" variant="outline" onClick={() => addFolder.mutate('')}>
              <FolderPlus className="size-4" /> Add
            </Button>
          </div>
          {addFolder.error instanceof Error && addFolder.error.message !== 'cancelled' && (
            <p className="text-xs text-destructive">{addFolder.error.message}</p>
          )}
        </section>

        <section className={cn('space-y-2', !connected && 'opacity-50')}>
          <h2 className="text-sm font-medium">Discovered from your OpenCode</h2>
          {!connected && <p className="text-xs text-muted-foreground">Available once connected.</p>}
          {connected && (
            <div className="space-y-3 text-sm">
              <InventoryRow
                label={`Agents (${agents.data?.length ?? '…'})`}
                items={(agents.data ?? []).map((a) => a.id)}
                loading={agents.isLoading}
              />
              <InventoryRow
                label={`Models (${models.data?.length ?? '…'})`}
                items={(models.data ?? []).map((m) => `${m.providerID}/${m.id}`)}
                loading={models.isLoading}
              />
              <InventoryRow
                label={`Skills (${skills.data?.length ?? '…'})`}
                items={(skills.data ?? []).map((s) => s.id)}
                loading={skills.isLoading}
              />
            </div>
          )}
        </section>

        <Separator />
        <section className="space-y-1 text-xs text-muted-foreground">
          <p>Jira (Atlassian OAuth) · AWS/Bedrock readiness · role defaults arrive with M1–M3.</p>
          <p>Pick a project folder above, then use “New chat” to start a general session.</p>
        </section>
      </div>
    </div>
  )
}

function InventoryRow({ label, items, loading }: { label: string; items: string[]; loading: boolean }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {loading ? (
        <Skeleton className="h-6 w-full" />
      ) : (
        <div className="flex flex-wrap gap-1">
          {items.slice(0, 40).map((i) => (
            <Badge key={i} variant="secondary" className="font-mono text-[10px]">
              {i}
            </Badge>
          ))}
          {items.length > 40 && <Badge variant="outline" className="text-[10px]">+{items.length - 40}</Badge>}
        </div>
      )}
    </div>
  )
}

function JiraSection(): React.JSX.Element {
  const qc = useQueryClient()
  const jira = useQuery({ queryKey: ['jira-status'], queryFn: () => window.revva.jira.status() })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.revva.jira.connect()
      void qc.invalidateQueries({ queryKey: ['jira-status'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const connected = jira.data?.connected
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="flex items-center gap-2 text-sm">
          {connected ? (
            <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
          ) : jira.data?.expired ? (
            <CircleX className="size-4 text-amber-500" />
          ) : (
            <CircleX className="size-4 text-muted-foreground" />
          )}
          <span>
            {connected
              ? 'Connected via Atlassian MCP (OAuth)'
              : jira.data?.expired
                ? 'Token expired — reconnect'
                : 'Not connected'}
          </span>
        </div>
        {connected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void window.revva.jira
                .disconnect()
                .then(() => qc.invalidateQueries({ queryKey: ['jira-status'] }))
            }
          >
            Disconnect
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void connect()}>
            {busy ? 'Waiting for browser…' : 'Connect'}
          </Button>
        )}
      </div>
      {connected && jira.data?.capabilities && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(jira.data.capabilities).map(([cap, tool]) => (
            <Badge key={cap} variant={tool ? 'secondary' : 'outline'} className="font-mono text-[10px]">
              {tool ? `✓ ${cap}` : `✗ ${cap}`}
            </Badge>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Revva registers its own OAuth client and stores tokens in the macOS Keychain (encrypted), never reading other apps' credential caches.
      </p>
    </div>
  )
}
