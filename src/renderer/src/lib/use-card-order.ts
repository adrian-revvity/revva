import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CardZoneName, CardZones } from '@/components/CardBoard'

/**
 * User-arranged ordering of Jira/PR cards: pinned cards form the "Important"
 * section, parked cards sink into the collapsible "Not right now" shelf, and
 * everything else stays in the main zone. Per-view maps live in the settings
 * store (`cards.pinnedOrder`); ids the board no longer contains are pruned on
 * read so removed tickets/merged PRs never linger.
 */
type StoredOrder = Partial<Record<'jira' | 'gh', Partial<CardZones>>>

async function readOrder(): Promise<StoredOrder> {
  const raw = await window.revva.settings.get('cards.pinnedOrder')
  return raw && typeof raw === 'object' ? (raw as StoredOrder) : {}
}

export function useCardOrder(view: 'jira' | 'gh', liveIds: string[]): {
  zones: CardZones
  commit: (next: CardZones) => void
} {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['card-order'], queryFn: readOrder, staleTime: Infinity })
  const stored = q.data?.[view]

  const zones = useMemo<CardZones>(() => {
    const live = new Set(liveIds)
    const keep = (ids: string[] | undefined): string[] => (ids ?? []).filter((id) => live.has(id))
    const important = keep(stored?.important)
    const later = keep(stored?.later)
    const placed = new Set([...important, ...later, ...keep(stored?.main)])
    const seen = new Set<string>()
    const main = [...keep(stored?.main), ...liveIds.filter((id) => !placed.has(id))].filter(
      (id) => !seen.has(id) && !!seen.add(id)
    )
    return { important, main, later }
  }, [stored, liveIds])

  const commit = useCallback(
    async (next: CardZones) => {
      const snapshot = qc.getQueryData<StoredOrder>(['card-order']) ?? {}
      const prev = snapshot[view] ?? {}
      // Cards hidden by a filter never appear in `next`; keep them where they
      // were (appended to their previous zone) instead of losing their order.
      const mentioned = new Set(Object.values(next).flat())
      const merged: CardZones = { ...next }
      for (const [zone, ids] of Object.entries(prev) as [CardZoneName, string[]][]) {
        const carried = ids.filter((id) => !mentioned.has(id))
        if (carried.length) merged[zone] = [...(merged[zone] ?? []), ...carried]
      }
      // Optimistic so the dropped card never snaps back.
      qc.setQueryData(['card-order'], { ...snapshot, [view]: merged })
      await window.revva.settings.set('cards.pinnedOrder', { ...snapshot, [view]: merged })
    },
    [qc, view]
  )

  return { zones, commit }
}
