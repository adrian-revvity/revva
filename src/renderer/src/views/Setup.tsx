import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { FolderPlus, Trash2, CircleCheck, CircleX, CircleDashed, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { RoleSelectors, DEFAULT, selOrUndefined } from './RoleSelectors'
import { FeaturesDialogButton } from './FeaturesDialog'
import {
  DEFAULT_START_PROMPT,
  DEFAULT_TACKLE_PROMPT,
  DEFAULT_PR_REVIEW_PROMPT,
  PROMPT_PLACEHOLDER_HELP
} from '@shared/prompts'
import type { PipelineRole, SettingsKey } from '@shared/types'

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
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Setup</h1>
            <p className="text-sm text-muted-foreground">
              Revva drives whatever your own OpenCode service exposes — no imported config required.
            </p>
          </div>
          <FeaturesDialogButton />
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

        <section className="space-y-2">
          <h2 className="text-sm font-medium">Agent / model defaults by role</h2>
          <p className="text-xs text-muted-foreground">
            Any run can override these. Empty = whatever your OpenCode service defaults to.
          </p>
          <RoleDefaults />
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">Prompt templates</h2>
          <p className="text-xs text-muted-foreground">
            What the one-click buttons tell the agent. Edit freely; placeholders are filled in per run.
          </p>
          <PromptTuning />
        </section>

        <section className={cn('space-y-2', !connected && 'opacity-50')}>
          <h2 className="text-sm font-medium">Favorite models</h2>
          <p className="text-xs text-muted-foreground">
            Star the models you use most — they pin to the top of every picker.
          </p>
          {connected && <ModelFavorites />}
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
          <p>Pick a project folder above, then use “New chat” to start a general session or open the Board to start work on a ticket.</p>
        </section>
      </div>
    </div>
  )
}

const REVIEW_ROLES: Array<{ role: PipelineRole; label: string; hint: string }> = [
  { role: 'build', label: 'Build', hint: 'default agent/model for Start flow & ticket sessions' },
  { role: 'sol', label: 'Sol-loop', hint: 'adversarial code review, every round' },
  { role: 'testAudit', label: 'Test audit', hint: 'tests around changed code' },
  { role: 'impeccable', label: 'UI review', hint: 'only when UI files change' },
  { role: 'fixer', label: 'Fixer', hint: 'applies consolidated findings' },
  { role: 'prReview', label: 'PR review', hint: 'GitHub tab review sessions' }
]

function RoleDefaults(): React.JSX.Element {
  const qc = useQueryClient()
  const cfg = useQuery({ queryKey: ['role-config'], queryFn: () => window.revva.roleConfig.list() })
  const byRole = new Map((cfg.data ?? []).map((c) => [c.role, c]))
  return (
    <div className="space-y-2">
      {REVIEW_ROLES.map(({ role, label, hint }) => {
        const saved = byRole.get(role)
        return (
          <div key={role} className="space-y-1.5 rounded-md border p-2.5">
            <div className="text-xs font-medium">
              {label} <span className="font-normal text-muted-foreground">— {hint}</span>
            </div>
            <RoleSelectors
              agentID={saved?.agentID ?? DEFAULT}
              modelKey={saved?.model ? `${saved.model.providerID}::${saved.model.id}` : DEFAULT}
              onAgent={(v) =>
                void window.revva.roleConfig
                  .save({ role, agentID: v === DEFAULT ? undefined : v, model: saved?.model })
                  .then(() => qc.invalidateQueries({ queryKey: ['role-config'] }))
              }
              onModel={(v) => {
                let model: { providerID: string; id: string } | undefined
                if (v !== DEFAULT) {
                  const [providerID, id] = v.split('::')
                  if (providerID && id) model = { providerID, id }
                }
                void window.revva.roleConfig
                  .save({ role, agentID: saved?.agentID, model })
                  .then(() => qc.invalidateQueries({ queryKey: ['role-config'] }))
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

const PROMPT_FIELDS: Array<{ key: 'prompt.start' | 'prompt.tackle' | 'prompt.review'; label: string; hint: string; fallback: string }> = [
  { key: 'prompt.start', label: 'Start flow (pipeline build)', hint: 'the full worktree→review→ship run', fallback: DEFAULT_START_PROMPT },
  { key: 'prompt.tackle', label: 'Session button (ticket)', hint: 'plain session linked to a Jira ticket', fallback: DEFAULT_TACKLE_PROMPT },
  { key: 'prompt.review', label: 'Review button (PR)', hint: 'GitHub tab review sessions', fallback: DEFAULT_PR_REVIEW_PROMPT }
]

function PromptTuning(): React.JSX.Element {
  const qc = useQueryClient()
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">{PROMPT_PLACEHOLDER_HELP}</p>
      {PROMPT_FIELDS.map(({ key, label, hint, fallback }) => (
        <PromptField key={key} settingKey={key} label={label} hint={hint} fallback={fallback} qc={qc} />
      ))}
    </div>
  )
}

function PromptField({
  settingKey,
  label,
  hint,
  fallback,
  qc
}: {
  settingKey: SettingsKey
  label: string
  hint: string
  fallback: string
  qc: QueryClient
}): React.JSX.Element {
  const saved = useQuery({ queryKey: ['settings', settingKey], queryFn: () => window.revva.settings.get(settingKey) })
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? (typeof saved.data === 'string' && saved.data ? saved.data : fallback)
  const dirty = draft !== null && draft !== (saved.data ?? '')

  const persist = (next: string): void => {
    void window.revva.settings.set(settingKey, next === fallback ? null : next).then(() => {
      setDraft(null)
      void qc.invalidateQueries({ queryKey: ['settings', settingKey] })
    })
  }

  return (
    <div className="space-y-1.5 rounded-md border p-2.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">
          {label} <span className="font-normal text-muted-foreground">— {hint}</span>
        </Label>
        <div className="flex items-center gap-1.5">
          {dirty && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => persist(draft!)}>
              Save
            </Button>
          )}
          {typeof saved.data === 'string' && saved.data && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => persist('')}>
              Reset
            </Button>
          )}
        </div>
      </div>
      <Textarea value={value} onChange={(e) => setDraft(e.target.value)} rows={5} className="text-[11px] leading-relaxed" />
    </div>
  )
}

function ModelFavorites(): React.JSX.Element {
  const qc = useQueryClient()
  const models = useQuery({ queryKey: ['models'], queryFn: () => window.revva.inventory.models() })
  return (
    <div className="flex flex-wrap gap-1.5">
      {(models.data ?? []).map((m) => (
        <button
          key={`${m.providerID}::${m.id}`}
          onClick={() =>
            void window.revva.models.toggleFavorite(`${m.providerID}::${m.id}`).then(() => {
              void qc.invalidateQueries({ queryKey: ['models'] })
              void qc.invalidateQueries({ queryKey: ['role-config'] })
            })
          }
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-accent',
            m.favorite && 'border-amber-500/50 bg-amber-500/10'
          )}
        >
          <Star className={cn('size-3', m.favorite ? 'fill-amber-500 text-amber-500' : 'text-muted-foreground')} />
          {m.name || m.id}
          <span className="text-muted-foreground">{m.providerID}</span>
        </button>
      ))}
    </div>
  )
}

function InventoryRow({ label, items, loading }: { label: string; items: string[]; loading: boolean }): React.JSX.Element {  return (
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
