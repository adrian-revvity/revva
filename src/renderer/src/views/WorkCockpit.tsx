import type { WorkSummary } from '@shared/types'
import { ChatView } from './Chat'

/**
 * Compatibility entry point for started tickets. The screen itself is the
 * ordinary conversation UI, identical to linking that conversation later.
 */
export function WorkCockpit({ work, onOpenChat }: { work: WorkSummary; onOpenChat?: (sessionId: string) => void }): React.JSX.Element {
  if (!work.sessionId) {
    return <div className="p-8 text-sm text-muted-foreground">This work has no session.</div>
  }
  return <ChatView sessionId={work.sessionId} work={work} onOpenChat={onOpenChat} />
}
