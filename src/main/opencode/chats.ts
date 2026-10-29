/**
 * Conversations: ordinary OpenCode sessions with optional Jira/PR properties.
 * Revva only stores the index (which session is a chat, its title/dir) in sqlite;
 * all transcript state lives in OpenCode. Links enable the shared utilities;
 * creating a linked session and tagging one later use the same path.
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import { openCodeService, describeError } from './service'
import { eventBus, type RawEvent } from './bus'
import { streamBuffer } from './stream-buffer'
import { transcriptImage } from './transcript-images'
import { getDb } from '../db'
import { sessionIndex } from './session-index'
import { parsePrRef, repoFromGitRemote, resolvePrRef } from '@shared/pr-ref'
import { ticketKeyFromText } from '@shared/ticket-key'
import { IPC, type ChatCreateInput, type ChatMessage, type ChatSummary, type PromptImage, type PromptRefs, type PushEvent, type QueuedMessage, type TranscriptPage } from '@shared/types'
import { fileAttachments, skillAttachments } from './prompt-refs'
import { skillGuardRules } from './skill-guard'
import { pushToWindows } from '../push'
import { notifyInbound } from '../notify'
import { isConflict, promptImageFiles } from '../util'
import { workManager } from '../pipeline/works'
import { performanceMeter } from './performance'

/** Cache prefixes supplement incomplete native drafts, never completed history. */
function mergePrefixes(history: ChatMessage[], prefixes: ChatMessage[]): ChatMessage[] {
  const rows = new Map(history.map((message) => [message.id, message]))
  const grow = (saved: string, prefix: string): string => prefix.startsWith(saved) ? prefix : saved
  for (const prefix of prefixes) {
    const saved = rows.get(prefix.id)
    if (!saved) { rows.set(prefix.id, prefix); continue }
    const text = grow(saved.text, prefix.text)
    const thinking = grow(saved.thinking ?? '', prefix.thinking ?? '')
    const tools = new Map(saved.tools?.map((tool) => [tool.id, tool]))
    for (const tool of prefix.tools ?? []) {
      const previous = tools.get(tool.id)
      if (previous?.state === 'completed' || previous?.state === 'error') continue
      if (previous?.state === 'running' && tool.state === 'streaming') continue
      tools.set(tool.id, { ...previous, ...tool, name: tool.name === 'tool' ? previous?.name ?? tool.name : tool.name, detail: tool.detail ?? previous?.detail, output: tool.output ?? previous?.output })
    }
    rows.set(saved.id, { ...saved, text, thinking: thinking || undefined, tools: tools.size ? [...tools.values()] : undefined, streamLengths: { text: text.length, thinking: thinking.length } })
  }
  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200)
}

const exec = promisify(execFile)

/** Placeholder title for chats the user did not name; replaced by OpenCode's
 *  auto-generated title (from the first message) via `session.renamed`. */
const AUTO_TITLE = 'New chat'

/** Pull a compact, human-meaningful summary out of one OpenCode tool part. */
function summarizeToolPart(p: Record<string, unknown>): NonNullable<ChatMessage['tools']>[number] {
  const state = (p.state ?? {}) as Record<string, unknown>
  const status = String(state.status ?? 'running')
  const input = state.input
  let detail: string | undefined
  if (typeof input === 'string') detail = input
  else if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    // Preferred one-liners per common tool, then first short string arg.
    const pick = ['command', 'cmd', 'path', 'filePath', 'file_path', 'pattern', 'query', 'url', 'prompt', 'description']
      .map((k) => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined))
      .find(Boolean)
    detail =
      pick ??
      Object.entries(obj)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(' · ')
  }
  let output: string | undefined
  if (status === 'completed') {
    const content = state.content
    if (Array.isArray(content)) {
      output = content
        .map((c) => {
          const item = c as Record<string, unknown>
          return typeof item.text === 'string' ? item.text : ''
        })
        .filter(Boolean)
        .join('\n')
    }
  } else if (status === 'error') {
    const err = state.error as Record<string, unknown> | undefined
    output = typeof err?.message === 'string' ? err.message : typeof err?.type === 'string' ? String(err.type) : undefined
    if (!output && Array.isArray(state.content)) {
      output = (state.content as Array<Record<string, unknown>>)
        .map((c) => (typeof c.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n')
    }
  }
  const truncate = (s: string | undefined): string | undefined => {
    if (!s) return undefined
    const t = s.trim()
    if (!t) return undefined
    return t.length > 2000 ? `${t.slice(0, 2000)}\n…` : t
  }
  return {
    id: String(p.id ?? `${String(p.name ?? 'tool')}-${String((p.time as Record<string, unknown> | undefined)?.created ?? Date.now())}`),
    name: String(p.name ?? 'tool'),
    state: (['streaming', 'running', 'completed', 'error'] as const).includes(status as never)
      ? (status as 'streaming' | 'running' | 'completed' | 'error')
      : 'running',
    detail: status === 'streaming' && typeof input === 'string' ? input.slice(0, 2000) : truncate(detail),
    inputLength: status === 'streaming' && typeof input === 'string' ? input.length : undefined,
    output: truncate(output)
  }
}

/** Resolve a possibly-bare PR ref ("#12") against the directory's GitHub remote. */
async function resolvePrLink(raw: string | undefined, directory: string): Promise<string | undefined> {
  if (!raw?.trim()) return undefined
  const ref = parsePrRef(raw)
  if (!ref) throw new Error(`Could not read that PR reference: "${raw}"`)
  if (ref.url && ref.repo) return ref.url
  let contextRepo: string | undefined
  try {
    const res = await exec('git', ['-C', directory, 'remote', 'get-url', 'origin'], { timeout: 10_000 })
    contextRepo = repoFromGitRemote(res.stdout)
  } catch {
    /* not a git repo / no remote → stays ambiguous */
  }
  const resolved = resolvePrRef(ref, contextRepo)
  if (!resolved?.url) throw new Error(`PR "${raw}" is ambiguous — many GitHub projects: use owner/repo#n or the full PR URL.`)
  return resolved.url
}

interface ChatRow {
  session_id: string
  title: string
  directory: string
  agent_id: string | null
  provider_id: string | null
  model_id: string | null
  ticket_key: string | null
  pr_url: string | null
  created_at: number
  updated_at: number
  seen_at: number | null
}

function rowToSummary(row: ChatRow): ChatSummary {
  return {
    sessionId: row.session_id,
    title: row.title,
    directory: row.directory,
    agentID: row.agent_id ?? undefined,
    providerID: row.provider_id ?? undefined,
    modelID: row.model_id ?? undefined,
    ticketKey: row.ticket_key ?? undefined,
    prUrl: row.pr_url ?? undefined,
    updatedAt: row.updated_at,
    // updated_at is touched on every completion; seen_at when the user last looked.
    unread: (row.seen_at ?? 0) < row.updated_at
  }
}

class ChatManager {
  private wired = false
  /** messageID → accumulated streamed text, for live transcript updates. */

  wire(): void {
    if (this.wired) return
    this.wired = true
    eventBus.on('event', (e: RawEvent) => this.onEvent(e))
    // SSE is live-only: after a reconnect the renderer refetches via its queries.
    eventBus.on('stream:reconnect', () => {
      streamBuffer.reset()
      pushToWindows({ kind: 'chat.idle', sessionId: '*' })
    })
  }

  list(): ChatSummary[] {
    const rows = getDb()
      .prepare('SELECT * FROM chat ORDER BY updated_at DESC')
      .all() as ChatRow[]
    return rows.map(rowToSummary)
  }

  async create(input: ChatCreateInput): Promise<ChatSummary> {
    const prUrl = await resolvePrLink(input.prUrl, input.directory)
    const api = openCodeService.api
    // Only force a title on the session when the user typed one — otherwise
    // OpenCode auto-titles from the first message and we adopt it via session.renamed.
    const custom = input.title?.trim()
    const title = custom || AUTO_TITLE
    const guard = await skillGuardRules(input.directory)
    const session = await api.session.create({
      ...(custom ? { title: custom } : {}),
      agent: input.agentID ?? null,
      model: input.model ? { providerID: input.model.providerID, id: input.model.id } : null,
      location: { directory: input.directory },
      ...(guard.length ? { permissions: guard } : {}),
      metadata: { revva: { kind: 'chat', ticketKey: input.ticketKey ?? null, prUrl: prUrl ?? null } }
    })
    const now = Date.now()
    // Context (ticket/PR brief) should never appear as chat noise. Preferred path:
    // an instruction entry — the service injects it on every turn and the empty
    // session's transcript stays clean (verified: no transcript message on first send).
    // Older services without the endpoint fall back to prepending it to the first message.
    let context = input.context?.trim() || null
    if (context) {
      try {
        await api.session.instructions.entry.put({ sessionID: session.id, key: 'revva.context', value: context })
        context = null
      } catch {
        /* pre-instructions service — keep the stored-context fold */
      }
    }
    getDb()
      .prepare(
        `INSERT INTO chat(session_id, title, directory, agent_id, provider_id, model_id, ticket_key, pr_url, context, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(session.id, title, input.directory, input.agentID ?? null, input.model?.providerID ?? null, input.model?.id ?? null, input.ticketKey ?? null, prUrl ?? null, context, now, now)
    sessionIndex.register(session.id, 'chat')
    return {
      sessionId: session.id,
      title,
      directory: input.directory,
      agentID: input.agentID,
      providerID: input.model?.providerID,
      modelID: input.model?.id,
      ticketKey: input.ticketKey,
      prUrl,
      updatedAt: now
    }
  }

  /** Rebuilds the local index from OpenCode metadata (crash/restart safety net). */
  async reconcile(): Promise<void> {
    if (!openCodeService.connected) return
    try {
      const res = await openCodeService.api.session.list({})
      const known = new Set(this.list().map((c) => c.sessionId))
      const db = getDb()
      for (const s of res.data) {
        const meta = s.metadata as Record<string, unknown> | undefined
        const revva = meta?.revva as Record<string, unknown> | undefined
        if (revva?.kind !== 'chat' || known.has(s.id)) continue
        const dir = typeof s.location?.directory === 'string' ? s.location.directory : ''
        if (!dir) continue
        db.prepare(
          `INSERT OR IGNORE INTO chat(session_id, title, directory, agent_id, provider_id, model_id, ticket_key, pr_url, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`
        ).run(
          s.id,
          s.title ?? 'Recovered chat',
          dir,
          s.agent ?? null,
          s.model?.providerID ?? null,
          s.model?.id ?? null,
          typeof revva.ticketKey === 'string' ? revva.ticketKey : null,
          typeof revva.prUrl === 'string' ? revva.prUrl : null,
          s.time?.created ?? Date.now(),
          s.time?.updated ?? Date.now()
        )
        sessionIndex.register(s.id, workManager.forSession(s.id) ? 'work' : 'chat')
      }
    } catch (err) {
      console.warn('[chat] reconcile failed:', describeError(err))
    }
  }

  /** Move a conversation between ticket groups without changing its transcript. */
  async setTicket(sessionId: string, ticketKey: string | null): Promise<void> {
    const row = getDb().prepare('SELECT session_id, ticket_key FROM chat WHERE session_id = ?').get(sessionId) as { session_id: string; ticket_key: string | null } | undefined
    if (!row) throw new Error('Chat not found.')
    if (ticketKey !== null) {
      // Accept existing groups or a manually typed key; normalize (upper-case, no leading zeros).
      // Bare numbers default to the Jira project in use, e.g. "129634" → CLN-129634.
      const trimmed = ticketKey.trim()
      const normalized = /^\d+$/.test(trimmed) ? `CLN-${trimmed.replace(/^0+(?=\d)/, '')}` : ticketKeyFromText(trimmed)
      if (!normalized) throw new Error('Enter a ticket number like CLN-1234.')
      ticketKey = normalized
    }
    await workManager.requireEditableLinks(sessionId)
    const api = openCodeService.api
    const session = await api.session.get({ sessionID: sessionId })
    const metadata = (session.metadata ?? {}) as Record<string, unknown>
    const revva = (metadata.revva ?? {}) as Record<string, unknown>
    await api.session.update({ sessionID: sessionId, metadata: { ...metadata, revva: { ...revva, ticketKey } } })
    getDb().prepare('UPDATE chat SET ticket_key = ? WHERE session_id = ?').run(ticketKey, sessionId)
    try {
      await workManager.setTicketProperty(sessionId, ticketKey)
    } catch (err) {
      getDb().prepare('UPDATE chat SET ticket_key = ? WHERE session_id = ?').run(row.ticket_key, sessionId)
      await api.session.update({ sessionID: sessionId, metadata: session.metadata ?? {} })
      throw err
    }
  }

  async messages(sessionId: string, since?: string, signal?: AbortSignal): Promise<TranscriptPage> {
    const api = openCodeService.api
    // First load is the newest 200. Refreshes fetch pages of 20 until the
    // overlap row; never silently skip steps when a run advances between polls.
    const res = await performanceMeter.request('history', () => api.message.list({ sessionID: sessionId, order: 'desc', limit: since ? 20 : 200 }, { signal }))
    const rows = [...res.data]
    let cursor = res.cursor.next
    const seen = new Set<string>()
    while (since && !rows.some((m) => m.id === since) && cursor && rows.length < 200 && !seen.has(cursor)) {
      seen.add(cursor)
      const nextCursor = cursor
      const page = await performanceMeter.request('history', () => api.message.list({ sessionID: sessionId, cursor: nextCursor, limit: Math.min(20, 200 - rows.length) }, { signal }))
      rows.push(...page.data)
      cursor = page.cursor.next
    }
    const overlap = since ? rows.findIndex((m) => m.id === since) : -1
    const reset = !since || overlap < 0
    const authoritative = new Set<string>()
    for (const message of rows) if (message.type === 'assistant' && message.time.completed !== undefined) {
      streamBuffer.persisted(sessionId, message.id)
      authoritative.add(message.id)
    }
    const selected = reset ? rows : rows.slice(0, overlap + 1)
    const out: ChatMessage[] = []
    for (const m of selected.reverse()) {
      if (m.type === 'user') {
        const images = (m.files ?? [])
          .flatMap((f, index) => f.data && /^image\/(png|jpeg|gif|webp)$/.test(f.mime)
            ? [{ name: f.name ?? undefined, mime: f.mime, data: transcriptImage(sessionId, m.id, index, f.mime, f.data) }]
            : [])
        const text = m.text ?? ''
        if (!text && images.length === 0) continue
        out.push({ id: m.id, role: 'user', text, images: images.length ? images : undefined, createdAt: m.time?.created ?? 0 })
      } else if (m.type === 'assistant') {
        let text = ''
        let thinking = ''
        const tools: ChatMessage['tools'] = []
        for (const part of m.content ?? []) {
          const p = part as Record<string, unknown>
          if (p.type === 'text' && typeof p.text === 'string') text += p.text
          else if (p.type === 'reasoning' && typeof p.text === 'string') thinking += p.text
          else if (p.type === 'tool') tools.push(summarizeToolPart(p))
        }
        const msg: ChatMessage = {
          id: m.id,
          role: 'assistant',
          text,
          tools: tools.length ? tools : undefined,
          thinking: thinking || undefined,
          streamLengths: { text: text.length, thinking: thinking.length },
          createdAt: m.time?.created ?? 0
        }
        if (!msg.text.trim() && !msg.tools && !msg.thinking?.trim()) continue
        out.push(msg)
      }
    }
    // Read the cache after HTTP finishes: buffered IPC overlaps this exact prefix
    // by numeric offsets. Ordinary tail/heartbeat fetches do not resend it.
    const messages = reset ? mergePrefixes(out, streamBuffer.snapshot(sessionId)) : out
    return { messages, reset, missingPrefixes: streamBuffer.missingPrefixes(sessionId, messages, authoritative) }
  }

  /** Messages waiting in OpenCode's inbox (queued follow-ups). */
  async queue(sessionId: string): Promise<QueuedMessage[]> {
    try {
      const items = await openCodeService.api.session.inbox.list({ sessionID: sessionId })
      return items
        .filter((i) => i.type === 'user')
        .map((i) => ({
          id: i.id,
          text: i.payload.text ?? '',
          imageCount: (i.payload.files ?? []).length,
          createdAt: i.time?.created ?? 0,
          delivery: i.delivery
        }))
    } catch {
      return []
    }
  }

  async cancelQueued(sessionId: string, inboxId: string): Promise<void> {
    await openCodeService.api.session.inbox.cancel({ sessionID: sessionId, inboxID: inboxId })
  }

  /** Force a waiting message through: switch it to steer delivery so the
   *  running agent reads it at the next step boundary instead of waiting
   *  behind the queue. Throws (409) if the item was already delivered. */
  async promoteQueued(sessionId: string, inboxId: string): Promise<void> {
    await openCodeService.api.session.inbox.update({ sessionID: sessionId, inboxID: inboxId, delivery: 'steer' })
  }

  async prompt(sessionId: string, text: string, images: PromptImage[] = [], queued = false, refs?: PromptRefs): Promise<void | 'queued'> {
    const chat = getDb().prepare('SELECT ticket_key, pr_url, context FROM chat WHERE session_id = ?').get(sessionId) as { ticket_key: string | null; pr_url: string | null; context: string | null } | undefined
    // A ticket/PR chat opens empty; its context rides the first real message only.
    // Cleared before delivery: a failed send keeps the folded text in the user's draft retry, never a double prefix.
    if (chat?.context) {
      text = `${chat.context}\n\n${text}`
      getDb().prepare('UPDATE chat SET context = NULL WHERE session_id = ?').run(sessionId)
    }
    // Jira and PR links enable the SAME utilities on the SAME conversation.
    if (chat?.ticket_key || chat?.pr_url || workManager.forSession(sessionId)) {
      await workManager.conversationContext(sessionId)
      return workManager.followUp(sessionId, text, images, queued, refs)
    }
    return this.sendPrompt(sessionId, text, images, queued, refs)
  }

  /** Plain transport retained for internal callers without a conversation row. */
  private async sendPrompt(sessionId: string, text: string, images: PromptImage[] = [], queued = false, refs?: PromptRefs): Promise<void> {
    const api = openCodeService.api
    getDb().prepare('UPDATE chat SET updated_at = ? WHERE session_id = ?').run(Date.now(), sessionId)
    const dir = this.directoryOf(sessionId)
    const files = [...promptImageFiles(images), ...(refs && dir ? fileAttachments(refs, dir) : [])]
    const skills = refs ? skillAttachments(refs) : []
    const payload = {
      sessionID: sessionId,
      text,
      ...(files.length ? { files } : {}),
      ...(skills.length ? { skills } : {}),
      delivery: (queued ? 'queue' : 'steer') as 'queue' | 'steer'
    }
    try {
      // 'steer' only matters while the session runs: inject at the next step.
      // 'queue' waits for the current run to finish. Idle sessions run immediately.
      await api.session.prompt(payload)
    } catch (err) {
      // Steer refused (409, session state raced) — park the message instead of losing it.
      if (!queued && isConflict(err)) await api.session.prompt({ ...payload, delivery: 'queue' })
      else throw err
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await openCodeService.api.session.interrupt({ sessionID: sessionId })
  }

  rename(sessionId: string, title: string): void {
    getDb().prepare('UPDATE chat SET title = ? WHERE session_id = ?').run(title.trim() || 'Chat', sessionId)
  }

  async remove(sessionId: string): Promise<void> {
    await workManager.forgetConversation(sessionId)
    try {
      await openCodeService.api.session.remove({ sessionID: sessionId })
    } catch {
      // already gone remotely — fine, remove local index anyway
    }
    getDb().prepare('DELETE FROM chat WHERE session_id = ?').run(sessionId)
    sessionIndex.forget(sessionId)
  }

  private touch(sessionId: string): void {
    getDb().prepare('UPDATE chat SET updated_at = ? WHERE session_id = ?').run(Date.now(), sessionId)
  }

  /** "I've looked at it": clears the sidebar unread dot. MAX() so a completion
   *  landing in the same millisecond does not immediately re-flag it. */
  markSeen(sessionId: string): void {
    getDb().prepare('UPDATE chat SET seen_at = MAX(?, updated_at) WHERE session_id = ?').run(Date.now(), sessionId)
  }

  /** The chat's working directory ('' when the index row is gone). */
  private directoryOf(sessionId: string): string {
    const row = getDb().prepare('SELECT directory FROM chat WHERE session_id = ?').get(sessionId) as { directory: string } | undefined
    return row?.directory ?? ''
  }

  private onEvent(e: RawEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>
    const sessionId = data.sessionID
    if (typeof sessionId !== 'string') return
    if (sessionIndex.kindOf(sessionId) !== 'chat' && e.type !== 'session.renamed') return
    switch (e.type) {
      case 'session.renamed': {
        // OpenCode auto-titles a session from its first message. Adopt that
        // title only while ours is still the placeholder, so a manual rename wins.
        const title = typeof data.title === 'string' ? data.title.trim() : ''
        if (!title) break
        const row = getDb().prepare('SELECT title FROM chat WHERE session_id = ?').get(sessionId) as { title: string } | undefined
        if (!row || row.title !== AUTO_TITLE) break
        getDb().prepare('UPDATE chat SET title = ? WHERE session_id = ?').run(title.slice(0, 100), sessionId)
        pushToWindows({ kind: 'chat.renamed', sessionId, title: title.slice(0, 100) })
        break
      }
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
      case 'session.idle': {
        // Primary completion signal for API-driven sessions is session.execution.*;
        // session.idle may also fire but must not be required.
        this.touch(sessionId)
        // Flush accumulated text before idle so the renderer's final refetch
        // never races a missing tail (ordering: last text, then idle).
        streamBuffer.flush(sessionId)
        pushToWindows({ kind: 'chat.idle', sessionId })
        // New Inbox message → laptop-level notification (deduped across the event burst).
        this.notifyFinished(sessionId)
        break
      }
    }
  }

  /** OS notification for the finished-unseen card this completion just raised. */
  private notifyFinished(sessionId: string): void {
    const row = getDb()
      .prepare('SELECT title, directory FROM chat WHERE session_id = ?')
      .get(sessionId) as { title: string; directory: string } | undefined
    if (!row) return
    notifyInbound(sessionId, 'Message ready', `${row.title}\n${row.directory}`)
  }
}

export const chatManager = new ChatManager()
