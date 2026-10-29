import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import type { PromptRefs, WorkFollowUp, WorkSummary } from '@shared/types'

export function WorkFollowUpQueue({ work, running, refsForText }: { work: WorkSummary; running: boolean; refsForText: (text: string) => PromptRefs }): React.JSX.Element | null {
  const queue = useQuery({ queryKey: ['work-queue', work.id], queryFn: () => window.revva.work.queue(work.id), refetchInterval: 5000 })
  if (queue.isError) return <p role="alert" className="mx-auto mb-2 max-w-3xl text-xs text-destructive">Saved follow-ups unavailable. <Button size="xs" variant="ghost" onClick={() => void queue.refetch()}>Retry</Button></p>
  if (!queue.data?.length) return null
  return <section aria-label="Queued ticket follow-ups" className="mx-auto mb-2 flex max-h-48 max-w-3xl flex-col gap-2 overflow-y-auto">
    <p role="status" className="text-xs text-muted-foreground">{queue.data.length} saved follow-up(s) · run when active work settles, before shipping</p>
    {queue.data.map((item, index) => <FollowUpRow key={item.id} item={item} position={index + 1} work={work} running={running} refsForText={refsForText} />)}
  </section>
}

function FollowUpRow({ item, position, work, running, refsForText }: { item: WorkFollowUp; position: number; work: WorkSummary; running: boolean; refsForText: (text: string) => PromptRefs }): React.JSX.Element {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)
  const action = useMutation({
    mutationFn: async (kind: 'edit' | 'remove' | 'send') => {
      if (kind === 'edit') await window.revva.work.editQueued(work.id, item.id, text, refsForText(text))
      if (kind === 'remove') await window.revva.work.cancelQueued(work.id, item.id)
      if (kind === 'send') await window.revva.work.sendQueuedNow(work.id, item.id)
    },
    onSuccess: () => setEditing(false),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['work-queue', work.id] })
      void qc.invalidateQueries({ queryKey: ['works'] })
      void qc.invalidateQueries({ queryKey: ['session-activity'] })
    }
  })
  const disabled = item.status === 'sending' || action.isPending
  const reviewBusy = work.state === 'REVIEW' || work.state === 'FIXING'
  return <div className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">#{position} {item.status === 'sending' ? 'Delivering' : item.status === 'error' ? 'Delivery held' : 'Queued'}</Badge>
      <span className="min-w-0 flex-1 truncate" title={item.text}>{item.text || `${item.imageCount} image(s)`}</span>
      {item.imageCount > 0 && <span className="text-muted-foreground">{item.imageCount} image(s)</span>}
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => { setText(item.text); setEditing(!editing) }}>Edit</Button>
      <Button size="xs" variant="ghost" disabled={disabled || running} onClick={() => action.mutate('send')}>{action.isPending && action.variables === 'send' ? 'Sending…' : reviewBusy ? 'Stop review & send' : item.status === 'error' ? 'Retry delivery' : 'Send now'}</Button>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => action.mutate('remove')}>Remove</Button>
    </div>
    {editing && <div className="flex flex-col gap-2">
      <Textarea aria-label={`Edit queued follow-up ${position}`} value={text} onChange={(event) => setText(event.target.value)} rows={2} disabled={disabled} />
      <div className="flex gap-2"><Button size="xs" disabled={disabled || (!text.trim() && !item.imageCount)} onClick={() => action.mutate('edit')}>Save changes</Button><Button size="xs" variant="ghost" onClick={() => setEditing(false)}>Cancel edit</Button></div>
    </div>}
    {item.error && <p role="alert" className="break-words text-destructive">{item.error}</p>}
    {action.error && <p role="alert" className="break-words text-destructive">{action.error.message}</p>}
  </div>
}
