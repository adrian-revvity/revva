import type { RevvaApi } from '@shared/types'

declare global {
  interface Window {
    revva: RevvaApi
  }
}

export {}
