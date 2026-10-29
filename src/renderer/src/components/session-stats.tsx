import { memo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ThroughputSnapshot } from '@shared/types'
import { useTranscriptVisibility } from '@/lib/transcript-stream'

/** Metrics updates must not rerender the transcript or composer. No local timer. */
export const SessionStats = memo(function SessionStats({ sessionId }: { sessionId: string; running: boolean }): React.JSX.Element {
  const visible = useTranscriptVisibility()
  const { data: rate } = useQuery<ThroughputSnapshot | null>({
    queryKey: ['session-throughput', sessionId], queryFn: () => null, enabled: false
  })
  const { data: usage } = useQuery({
    queryKey: ['session-context-usage', sessionId],
    queryFn: async ({ signal }) => {
      const value = await window.revva.session.contextUsage(sessionId)
      signal.throwIfAborted()
      return value
    },
    enabled: visible
  })
  const idle = rate ? rate.msSinceOutput ?? rate.elapsedMs : null
  const rows = [
    ['Context', usage?.limit ? `${Math.round(usage.tokens / usage.limit * 100)}%` : '—'],
    [rate && !rate.running ? 'Last' : 'Speed', rate ? `${rate.tokensPerSecond < 10 ? rate.tokensPerSecond.toFixed(1) : Math.round(rate.tokensPerSecond)} t/s` : '—'],
    ['Idle', idle != null ? `${Math.floor(idle / 1000)}s` : '—']
  ]
  return (
    <section aria-label="Session metrics" className="pointer-events-auto w-[140px] overflow-hidden rounded-lg border bg-background/95 px-2 py-1.5">
      <span className="mb-0.5 block text-[9px] font-medium tracking-wide text-muted-foreground">STATS</span>
      <dl className="space-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <dt className="w-[7ch] shrink-0 text-[10px] leading-tight">{label}</dt>
            <dd className="text-[11px] font-normal tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
})
