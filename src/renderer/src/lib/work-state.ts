import type { WorkState } from '@shared/types'

export const workStateLabels: Record<WorkState, string> = {
  READY: 'Ready',
  BUILDING: 'Building',
  REVIEW: 'In review',
  FIXING: 'Fixing',
  APPROVED: 'Approved',
  WAITING_HUMAN: 'Needs attention',
  REWORK: 'Reworking',
  SHIPPED: 'Shipped',
  ABANDONED: 'Abandoned'
}

const ACTIVE_WORK_STATES: ReadonlySet<WorkState> = new Set([
  'BUILDING', 'REVIEW', 'FIXING', 'REWORK', 'WAITING_HUMAN'
])

/** Ticket work shown as active in the app's sidebar and Inbox meter. */
export function isActiveWorkState(state: WorkState): boolean {
  return ACTIVE_WORK_STATES.has(state)
}

/** Compact state text shared with the sidebar's active-work chips. */
export function activeWorkLabel(state: WorkState): string {
  return state === 'WAITING_HUMAN' ? 'needs you' : state.toLowerCase()
}
