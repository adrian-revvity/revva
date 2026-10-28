import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Inbox as InboxIcon, ShieldAlert, MessageCircleQuestion, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { InboxField, PendingItem } from '@shared/types'

/** Raw FormInfo.fields come across IPC untyped; normalize to InboxField[]. */
function normalizeFields(raw: unknown): InboxField[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      key: String(f.key ?? ''),
      title: typeof f.title === 'string' ? f.title : undefined,
      description: typeof f.description === 'string' ? f.description : undefined,
      type: (['string', 'number', 'integer', 'boolean', 'multiselect'].includes(String(f.type))
        ? String(f.type)
        : 'string') as InboxField['type'],
      required: typeof f.required === 'boolean' ? f.required : undefined,
      placeholder: typeof f.placeholder === 'string' ? f.placeholder : undefined,
      default: f.default,
      options: Array.isArray(f.options)
        ? (f.options as Array<Record<string, unknown>>).map((o) => ({
            value: String(o.value ?? ''),
            label: typeof o.label === 'string' ? o.label : undefined
          }))
        : undefined
    }))
    .filter((f) => f.key)
}

export function useInbox(): PendingItem[] {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['inbox'], queryFn: () => window.revva.inbox.list() })
  // Main pushes the authoritative snapshot; keep the cache in sync.
  useEffect(() => {
    return window.revva.events.on((e) => {
      if (e.kind === 'inbox') qc.setQueryData(['inbox'], e.items)
    })
  }, [qc])
  return q.data ?? []
}

export function InboxView(): React.JSX.Element {
  const items = useInbox()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 px-6 py-6">
        <header>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <InboxIcon className="size-5" /> Inbox
          </h2>
          <p className="text-xs text-muted-foreground">
            Pending questions and permission requests from all chats and ticket runs.
          </p>
        </header>
        {items.length === 0 && (
          <p className="py-14 text-center text-sm text-muted-foreground">Nothing waiting on you.</p>
        )}
        {items.map((item) => (item.kind === 'form' ? <FormCard key={item.id} item={item} /> : <PermissionCard key={item.id} item={item} />))}
      </div>
    </div>
  )
}

export function FormCard({ item }: { item: PendingItem }): React.JSX.Element {
  const fields = useMemo(() => normalizeFields(item.fields), [item.fields])
  const [answers, setAnswers] = useState<Record<string, string | number | boolean | string[]>>(() => {
    const init: Record<string, string | number | boolean | string[]> = {}
    for (const f of fields) if (f.default !== undefined) init[f.key] = f.default as never
    return init
  })
  const reply = useMutation({
    mutationFn: () => window.revva.inbox.replyForm(item.sessionID, item.id, answers),
    onError: (e: Error) => console.error('form reply failed', e)
  })
  const ready = fields.every((f) => !f.required || answers[f.key] !== undefined)

  return (
    <div className="rounded-lg border p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-sky-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{item.title}</div>
          <OwnerLine item={item} />
        </div>
        <Badge variant="secondary" className="text-[10px]">question</Badge>
      </div>

      <div className="mt-3 space-y-3">
        {fields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            value={answers[f.key]}
            onChange={(v) => setAnswers((a) => ({ ...a, [f.key]: v }))}
          />
        ))}
      </div>

      <div className="mt-4 flex justify-end">
        <Button size="sm" disabled={!ready || reply.isPending} onClick={() => reply.mutate()}>
          {reply.isPending ? 'Sending…' : 'Answer & continue'}
        </Button>
      </div>
      {reply.error instanceof Error && <p className="mt-2 text-xs text-destructive">{reply.error.message}</p>}
    </div>
  )
}

function FieldInput({
  field,
  value,
  onChange
}: {
  field: InboxField
  value: string | number | boolean | string[] | undefined
  onChange: (v: string | number | boolean | string[]) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">
        {field.title ?? field.key}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
      </div>
      {field.description && <p className="text-[11px] text-muted-foreground">{field.description}</p>}

      {field.type === 'boolean' ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={value === true} onCheckedChange={(c) => onChange(c === true)} />
          {field.title ?? field.key}
        </label>
      ) : field.type === 'multiselect' ? (
        <div className="flex flex-wrap gap-2">
          {(field.options ?? []).map((o) => {
            const list = Array.isArray(value) ? value : []
            const on = list.includes(o.value)
            return (
              <Button
                type="button"
                key={o.value}
                size="sm"
                variant={on ? 'default' : 'outline'}
                onClick={() =>
                  onChange(on ? list.filter((x) => x !== o.value) : [...list, o.value])
                }
              >
                {o.label ?? o.value}
              </Button>
            )
          })}
        </div>
      ) : field.options && field.options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {field.options.map((o) => (
            <Button
              type="button"
              key={o.value}
              size="sm"
              variant={value === o.value ? 'default' : 'outline'}
              onClick={() => onChange(o.value)}
            >
              {o.label ?? o.value}
            </Button>
          ))}
          {(field.type === 'string' || !field.required) && (
            <Input
              placeholder="or type your own…"
              className="h-8 w-44 text-xs"
              value={typeof value === 'string' && !(field.options ?? []).some((o) => o.value === value) ? value : ''}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      ) : field.type === 'string' ? (
        <Textarea
          rows={2}
          placeholder={field.placeholder}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
          value={value === undefined ? '' : String(value)}
          onChange={(e) =>
            onChange(field.type === 'boolean' ? e.target.value === 'true' : e.target.value)
          }
        />
      )}
    </div>
  )
}

export function PermissionCard({ item }: { item: PendingItem }): React.JSX.Element {
  const reply = useMutation({
    mutationFn: (d: 'once' | 'always' | 'reject') =>
      window.revva.inbox.replyPermission(item.sessionID, item.id, d)
  })
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{item.title}</div>
          <OwnerLine item={item} />
          {item.resources && item.resources.length > 0 && (
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {item.action}: {item.resources.slice(0, 3).join(', ')}
              {item.resources.length > 3 ? ` +${item.resources.length - 3}` : ''}
            </p>
          )}
        </div>
        <Badge variant="outline" className="border-amber-500/40 text-[10px]">permission</Badge>
      </div>
      <div className={cn('mt-3 flex justify-end gap-2')}>
        <Button size="sm" variant="outline" onClick={() => reply.mutate('reject')}>
          Reject
        </Button>
        <Button size="sm" variant="secondary" onClick={() => reply.mutate('once')}>
          Allow once
        </Button>
        <Button size="sm" onClick={() => reply.mutate('always')}>
          Always allow
        </Button>
      </div>
    </div>
  )
}

function OwnerLine({ item }: { item: PendingItem }): React.JSX.Element {
  return (
    <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium">{item.owner ?? 'session'}</span>
      <Separator orientation="vertical" className="h-3" />
      <FolderOpen className="size-3" />
      <span className="truncate font-mono">{item.directory}</span>
    </p>
  )
}
