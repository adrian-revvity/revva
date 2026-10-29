/**
 * Default prompt templates for the one-click task buttons, plus {placeholder} rendering.
 * Users can override each in Setup; these defaults are the placeholders and the reset target.
 * Placeholders: {ticketKey} {summary} {description} {prUrl} {prNumber} {repo} {title} {base} {head}
 */

export const DEFAULT_START_PROMPT = `You are working on Jira ticket {ticketKey}: {summary}.

{description}

Tackle this ticket end to end: read the whole ticket, understand the surrounding code before touching it, and follow the repository's engineering and testing policies — small focused changes, no drive-by refactors. Use available skills and subagents where they help with planning or research. Keep the tree committable and commit your work with clear messages referencing {ticketKey}.

Do not push and do not open PRs — revva runs reviews and ships for you.`

export const DEFAULT_TACKLE_PROMPT = `Open a working session on Jira ticket {ticketKey}: {summary}.

Tackle this ticket with me: explore the relevant code, think out loud about the approach, follow good practices, use agents/skills when useful, and ask before anything destructive. Make commits when it makes sense.

By default do NOT push or open PRs — that is revva's job. But if I ask during the conversation (e.g. "push when the changes are done"), push the branch and update the linked PR if one exists, otherwise open one.`

export const DEFAULT_PR_REVIEW_PROMPT = `Review GitHub PR {prUrl} ({repo}#{prNumber}: {title}, {head} → {base}).

The PR branch is checked out in this directory. Inspect the diff with \`gh pr view {prUrl} --json body,files\` and \`gh pr diff {prUrl}\`, then read the surrounding code before judging it. Review like a careful senior engineer: correctness, edge cases, tests, security, performance, and how well it matches {title}. Report concrete findings with file:line and a suggested fix, ordered by severity.

End your report with exactly one final line: \`VERDICT: APPROVED\` when clean, or \`VERDICT: CHANGES\` when there are blockers or majors.`

export const DEFAULT_PR_DESCRIPTION_PROMPT = `You write the description of pull request {prUrl} ({repo}#{prNumber}: {title}, {head} → {base}) for human reviewers at a small product team. Reviewers skim: lead with what a reader gets out of the change, then the notable decisions.

Write Markdown that will be embedded inside the existing PR body:
- Start with \`## Summary\`, then \`## Changes\` grouping the work by theme (not one bullet per commit), and add \`## Testing\`, \`## Risk\`, or \`## Follow-ups\` only when the evidence supports them.
- Explain why, not just what. Name the important files in backticks.
- Say plainly what is unverified or risky when the diff suggests it. Never invent behaviour, ticket numbers, test commands, or metrics that the facts and diff do not show.
- Under 220 words. No top-level \`#\` heading. No preamble or closing remarks — output only the Markdown section.
- Never output HTML comments.`

export const PROMPT_PLACEHOLDER_HELP =
  'Placeholders: {ticketKey} {summary} {description} {prUrl} {prNumber} {repo} {title} {base} {head}'

/** Always appended, including when the user customized the start template. */
export const BUILD_COMPLETION_INSTRUCTIONS = `Revva implementation phase:
- Do not launch code-review, test-audit or UI-review agents during implementation; Revva runs the independent review team after you finish. Run the repository's appropriate verification yourself.
- Only when the ticket is fully implemented, verified according to repo policy, and committed, end your final message with exactly REVVA: DONE on its own last line.
- If blocked, missing a dependency/plugin, asking a question, or only presenting a plan, explain what is needed and do NOT emit REVVA: DONE. Ending a turn alone does not start review.`

/** Replace {known} placeholders; unknown ones are left untouched so typos stay visible. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? vars[key]! : m))
}
