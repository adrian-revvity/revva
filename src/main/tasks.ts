/**
 * One-click tasks create ordinary conversations pre-linked to a ticket:
 * - ticketSession: "Open a session related to that ticket" — an ordinary OpenCode
 *   session (chat) in the ticket's repo, seeded with the tunable tackle prompt.
 *   No new checkout is created; the link enables the shared conversation utilities.
 * PR reviews live in github.ts (they need a worktree checkout).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chatManager } from './opencode/chats'
import { getDb, settingGet } from './db'
import { getTicket } from './jira/board'
import { renderPrompt, DEFAULT_TACKLE_PROMPT } from '@shared/prompts'
import type { TaskSessionResult } from '@shared/types'

function expandTilde(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/** Best-effort repo for a ticket: last active work's repo, else the first workspace. */
function inferRepoDir(ticketKey: string): string | undefined {
  const work = getDb()
    .prepare("SELECT repo_dir FROM work WHERE ticket_key = ? AND state != 'ABANDONED' ORDER BY updated_at DESC LIMIT 1")
    .get(ticketKey) as { repo_dir: string } | undefined
  if (work) return work.repo_dir
  const ws = getDb().prepare('SELECT path FROM workspace ORDER BY rowid LIMIT 1').get() as { path: string } | undefined
  return ws ? expandTilde(ws.path) : undefined
}

export async function startTicketSession(ticketKey: string, repoDir?: string): Promise<TaskSessionResult> {
  const dir = repoDir ? expandTilde(repoDir) : inferRepoDir(ticketKey)
  if (!dir) throw new Error('No repo known for this ticket — add a workspace folder in Setup or pick one.')
  const ticket = await getTicket(ticketKey)
  const chat = await chatManager.create({
    directory: dir,
    title: `${ticketKey} session`,
    ticketKey
  })
  const template = settingGet<string>('prompt.tackle') || DEFAULT_TACKLE_PROMPT
  const text = renderPrompt(template, {
    ticketKey,
    summary: ticket?.summary ?? '',
    description: ''
  })
  await chatManager.prompt(chat.sessionId, text)
  return { sessionId: chat.sessionId, title: chat.title, directory: dir }
}
