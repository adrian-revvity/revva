import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  defaultAnimateLayoutChanges,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  type AnimateLayoutChanges
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Shared drag-and-drop card board (dnd-kit). Cards live in ordered zones —
 * "important" / "main" / "later" — and drag within and across them. The whole
 * card is the drag handle except inside form controls, so grabbing a card
 * anywhere works and its buttons still click. The view supplies the zone
 * contents plus one render function; the board owns the gesture, the overlay,
 * and the reorder bookkeeping.
 */
export type CardZoneName = 'important' | 'main' | 'later'
export type CardZones = Record<CardZoneName, string[]>

/** Zones addressed by dynamic id inside the board (drop ids double as zone names). */
type ZoneMap = Record<string, string[] | undefined>

type CardBoardCtx = {
  zones: CardZones
  renderCard: (id: string) => React.ReactNode
  /** Zones rendered as sortable lists; zones outside this list are pure drop targets. */
  sortableZones: readonly string[]
  activeId: string | null
}

const Ctx = createContext<CardBoardCtx | null>(null)

function useCardBoardCtx(): CardBoardCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('CardZone must be rendered inside CardBoard')
  return ctx
}

function containerOf(zones: ZoneMap, id: string): string | null {
  for (const [zone, items] of Object.entries(zones)) if (items?.includes(id)) return zone
  return null
}

const DEFAULT_SORTABLE: CardZoneName[] = ['important', 'main', 'later']

export function CardBoard({
  zones,
  onReorder,
  renderCard,
  sortableZones = DEFAULT_SORTABLE,
  children
}: {
  zones: CardZones
  onReorder: (next: CardZones) => void
  renderCard: (id: string) => React.ReactNode
  sortableZones?: readonly CardZoneName[]
  children: React.ReactNode
}): React.JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeWidth, setActiveWidth] = useState<number | null>(null)
  // Zone the dragged card started in; a same-zone drop needs an explicit
  // arrayMove, a cross-zone drop is already reflected in the draft.
  const originZoneRef = useRef<string | null>(null)
  // Working copy during a drag so cards move between zones live.
  const [draft, setDraft] = useState<CardZones>(zones)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    if (!activeId) setDraft(zones)
  }, [zones, activeId])

  const shown = activeId ? draft : zones
  const ctx = useMemo<CardBoardCtx>(
    () => ({ zones: shown, renderCard, sortableZones, activeId }),
    [shown, renderCard, sortableZones, activeId]
  )

  const sensors = useSensors(
    // 4px activation: clicks on the card's buttons survive; drags start instantly.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const onStart = (e: DragStartEvent): void => {
    setDraft(zones)
    originZoneRef.current = containerOf(zones as ZoneMap, String(e.active.id))
    // Keep the overlay the card's original width so it doesn't jump to fit-content.
    setActiveWidth(e.active.rect.current.initial?.width ?? null)
    setActiveId(String(e.active.id))
  }

  const onOver = (e: DragOverEvent): void => {
    if (!e.over) return
    const active = String(e.active.id)
    const over = String(e.over.id)
    if (active === over) return
    setDraft((prev) => {
      const map = prev as ZoneMap
      const from = containerOf(map, active)
      // `over` is either a card id or a zone id (empty/collapsed drop area).
      const to = map[over] ? over : containerOf(map, over)
      if (!from || !to || from === to) return prev
      const next: ZoneMap = { ...map }
      next[from] = (map[from] ?? []).filter((id) => id !== active)
      const target = [...(map[to] ?? [])]
      // Sortable zones interpolate at the hovered card; drop-only zones append.
      const sortable = sortableZones.includes(to as CardZoneName)
      const overIndex = sortable ? target.indexOf(over) : -1
      target.splice(overIndex < 0 ? target.length : overIndex, 0, active)
      next[to] = target
      return next as CardZones
    })
  }

  const onEnd = (e: DragEndEvent): void => {
    const finalDraft = draftRef.current
    const map = finalDraft as ZoneMap
    const active = String(e.active.id)
    let next: CardZones = finalDraft
    if (e.over && String(e.over.id) !== active) {
      const over = String(e.over.id)
      const to = map[over] ? over : containerOf(map, over)
      // Same-zone reorder: onDragOver never mutated the draft (transforms do
      // the previewing), so apply the move now. Cross-zone drops are already
      // reflected in the draft from onDragOver — re-moving would jump the card.
      if (to && originZoneRef.current === to) {
        const items = map[to] ?? []
        const oldIndex = items.indexOf(active)
        // Hovering blank space inside the zone means: drop at the end.
        const newIndex = over === to ? items.length - 1 : items.indexOf(over)
        if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) {
          next = { ...finalDraft, [to]: arrayMove(items, oldIndex, newIndex) }
        }
      }
    }
    onReorder(next)
    originZoneRef.current = null
    setActiveId(null)
  }

  return (
    <Ctx.Provider value={ctx}>
      <DndContext
        sensors={sensors}
        onDragStart={onStart}
        onDragOver={onOver}
        onDragEnd={onEnd}
        onDragCancel={() => {
          originZoneRef.current = null
          setActiveId(null)
        }}
      >
        {children}
        <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
          {activeId ? (
            <div
              style={{ width: activeWidth ?? undefined }}
              className="pointer-events-none rotate-[1.5deg] cursor-grabbing opacity-95 shadow-xl ring-2 ring-primary/40"
            >
              {renderCard(activeId)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </Ctx.Provider>
  )
}

/** Move a card into `to`, appending at the end of that zone. */
export function moveToZone(zones: CardZones, id: string, to: CardZoneName): CardZones {
  const next: CardZones = { important: [], main: [], later: [] }
  for (const zone of Object.keys(next) as CardZoneName[]) {
    next[zone] = (zones[zone] ?? []).filter((x) => x !== id)
  }
  next[to] = [...next[to], id]
  return next
}

/** A drop-zone bound to one zone. Drop targets work even while collapsed. */
export function CardZone({
  id,
  gridClassName,
  emptyHint,
  collapsed,
  collapsedContent
}: {
  id: CardZoneName
  gridClassName?: string
  emptyHint?: string
  collapsed?: boolean
  collapsedContent?: React.ReactNode
}): React.JSX.Element {
  const ctx = useCardBoardCtx()
  const { setNodeRef, isOver } = useDroppable({ id })
  const items = ctx.zones[id] ?? []
  const sortable = ctx.sortableZones.includes(id) && !collapsed
  const highlighted = isOver && ctx.activeId !== null

  return (
    <SortableContext items={sortable ? items : []} strategy={rectSortingStrategy} disabled={!sortable}>
      <div
        ref={setNodeRef}
        className={cn(
          'grid items-stretch gap-2.5 rounded-lg transition-[background-color,box-shadow] duration-150',
          highlighted && 'bg-primary/[0.06] ring-2 ring-primary/40',
          gridClassName ?? 'grid-cols-[repeat(auto-fill,minmax(230px,1fr))]'
        )}
      >
        {collapsed ? (
          collapsedContent
        ) : (
          <>
            {items.map((itemId) => (
              <DraggableCard key={itemId} id={itemId} />
            ))}
            {items.length === 0 && emptyHint && (
              <p className="col-span-full border border-dashed border-border/70 py-3 text-center text-xs text-muted-foreground">
                {emptyHint}
              </p>
            )}
          </>
        )}
      </div>
    </SortableContext>
  )
}

// dnd-kit v10 only animates layout when asked; without this the neighbours of
// a dragged card snap instead of sliding.
const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true })

function DraggableCard({ id }: { id: string }): React.JSX.Element {
  const ctx = useCardBoardCtx()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    animateLayoutChanges
  })
  // The whole card drags — except its interactive children, whose clicks and
  // keys stay their own.
  const guarded = useMemo(() => {
    const wrapped: Record<string, (event: React.SyntheticEvent) => void> = {}
    for (const [key, handler] of Object.entries(listeners ?? {})) {
      wrapped[key] = (event) => {
        if ((event.target as HTMLElement).closest('button, a, input, textarea, select')) return
        ;(handler as (event: React.SyntheticEvent) => void)(event)
      }
    }
    return wrapped
  }, [listeners])
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group/card relative min-w-0 cursor-grab touch-none select-none active:cursor-grabbing',
        isDragging && 'z-0 opacity-35'
      )}
      {...attributes}
      // The card itself holds buttons and links, so it can't be a button.
      role="group"
      aria-roledescription="draggable card"
      {...guarded}
    >
      <GripVertical className="pointer-events-none absolute right-1 top-1 z-10 size-3.5 text-muted-foreground/40 opacity-0 transition-opacity group-hover/card:opacity-100" />
      {ctx.renderCard(id)}
    </div>
  )
}
