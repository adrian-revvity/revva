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
