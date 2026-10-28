import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

/** Kept in sync with README "Features" (single source of truth lives in the README). */
const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: 'Dashboard',
    body: 'Landing view summarizing everything: OpenCode health, Jira sprint progress, inbox, active pipeline work, PRs needing attention, script status, recent chats. Every card deep-links into its view.'
  },
  {
    title: 'Sprint board (Jira)',
    body: 'Current-sprint tickets assigned to you, via the Atlassian MCP over revva\u2019s own OAuth connection.'
  },
  {
    title: 'Start work',
    body: 'Git worktree + branch per ticket in a workspace folder you pick; optionally branch from another ticket\u2019s branch (stacked work, gh-stack-compatible PR bases). A worktree cleanup dialog lists stale worktrees across your repos and removes them safely.'
  },
  {
    title: 'Optional grill-me intake',
    body: 'Before coding, the agent grills you about the ticket until the plan is solid; its output seeds the build.'
  },
  {
    title: 'Agent/model selection everywhere',
    body: 'Every agent and model from your OpenCode service is eligible. Per-role defaults (Sol-loop, test audit, UI review, fixer) below; any run can override each reviewer individually. Models needing a local endpoint are marked until the port is up.'
  },
  {
    title: 'Scripts',
    body: 'One-click shell scripts (aliases work — interactive zsh), e.g. your morning AWS/SSO/proxy routine. Live output, kill, and optional local-port probe. No AWS-specific logic in revva.'
  },
  {
    title: 'General chat',
    body: 'Plain OpenCode sessions with chosen directory/agent/model — no ticket or pipeline needed.'
  },
  {
    title: 'Ticket cockpit',
    body: 'Live streaming transcript, follow-up composer, interrupt, per-ticket state badge.'
  },
  {
    title: 'Question inbox',
    body: 'Every pending question (form) and permission request across sessions in one place; answer inline, audited.'
  },
  {
    title: 'Parallel review pipeline',
    body: 'Concurrent read-only reviewers (sol-loop, test audit, UI review when files changed). Incomplete/errored reviewers block approval; skipped \u2260 approved. Findings fan in to one fixer; bounded re-review rounds (default 3).'
  },
  {
    title: 'Ship',
    body: 'Pre-flight checks, push (never force), gh pr create with review-gate summary, opens the PR, transitions Jira + summary comment. Never merges.'
  },
  {
    title: 'AUTO mode',
    body: 'Per-run opt-in: agent picks safe/recommended options, minimal pings; ships automatically once all gates approve. Blockers park the work with the reason; every decision is logged.'
  },
  {
    title: 'Comment watcher',
    body: 'Polls Jira for new comments on shipped tickets; \u201cTackle comments\u201d runs a rework agent, pushes fixes to the PR, and replies on Jira.'
  },
  {
    title: 'GitHub tab',
    body: 'Your open PRs across all projects (via gh CLI), Mine / Needs review; \u201cReview\u201d checks out the PR head and starts a review agent session.'
  },
  {
    title: 'Prompt tuning + favorites',
    body: 'Setup holds per-role agent/model defaults, editable prompts for every one-click button, and favorite models pinned to the top of pickers.'
  }
]

/** Quiet entry point in Setup; opens the full feature list in a dialog. */
export function FeaturesDialogButton(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setOpen(true)}>
        <Sparkles className="mr-1 size-3.5" />
        Features
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>What revva does</DialogTitle>
            <DialogDescription>
              A local cockpit over your own OpenCode service — it discovers your models, agents, and skills.
            </DialogDescription>
          </DialogHeader>
          <dl className="space-y-3">
            {FEATURES.map((f) => (
              <div key={f.title}>
                <dt className="text-xs font-semibold">{f.title}</dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">{f.body}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </>
  )
}
