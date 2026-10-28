/**
 * General chats: ordinary OpenCode sessions with no ticket/pipeline metadata.
 * Revva only stores the index (which session is a chat, its title/dir) in sqlite;
 * all transcript state lives in OpenCode.
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import { openCodeService, describeError } from './service'
import { eventBus, type RawEvent } from './bus'
import { streamBuffer } from './stream-buffer'
import { getDb } from '../db'
import { sessionIndex } from './session-index'
import { parsePrRef, repoFromGitRemote, resolvePrRef } from '@shared/pr-ref'
import { IPC, type ChatCreateInput, type ChatMessage, type ChatSummary, type PromptImage, type PromptRefs, type PushEvent, type QueuedMessage } from '@shared/types'
import { fileAttachments, skillAttachments } from './prompt-refs'

const exec = promisify(execFile)

/** The SDK error for "session busy" / conflicts carries status 409. */
function isConflict(err: unknown): boolean {
  const e = err as { status?: unknown; name?: unknown; message?: unknown }
  if (e?.status === 409) return true
  const msg = String(e?.message ?? err ?? '')
  return msg.includes('409') || /conflict|busy|already running/i.test(msg)
}

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
    detail: truncate(detail),
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

function send(event: PushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.eventPush, event)
}

class ChatManager {
  private wired = false
  /** messageID → accumulated streamed text, for live transcript updates. */

  wire(): void {
    if (this.wired) return
    this.wired = true
    eventBus.on('event', (e: RawEvent) => this.onEvent(e))
    // SSE is live-only: after a reconnect the renderer refetches via its queries.
    eventBus.on('stream:reconnect', () => send({ kind: 'chat.idle', sessionId: '*' }))
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
    const title = input.title?.trim() || 'New chat'
    const session = await api.session.create({
      title,
      agent: input.agentID ?? null,
      model: input.model ? { providerID: input.model.providerID, id: input.model.id } : null,
      location: { directory: input.directory },
      metadata: { revva: { kind: 'chat', ticketKey: input.ticketKey ?? null, prUrl: prUrl ?? null } }
    })
    const now = Date.now()
    getDb()
      .prepare(
        `INSERT INTO chat(session_id, title, directory, agent_id, provider_id, model_id, ticket_key, pr_url, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(session.id, title, input.directory, input.agentID ?? null, input.model?.providerID ?? null, input.model?.id ?? null, input.ticketKey ?? null, prUrl ?? null, now, now)
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
          `INSERT OR IGNORE INTO chat(session_id, title, directory, agent_id, provider_id, model_id, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?)`
        ).run(
          s.id,
          s.title ?? 'Recovered chat',
          dir,
          s.agent ?? null,
          s.model?.providerID ?? null,
          s.model?.id ?? null,
          s.time?.created ?? Date.now(),
          s.time?.updated ?? Date.now()
        )
        sessionIndex.register(s.id, 'chat')
      }
    } catch (err) {
      console.warn('[chat] reconcile failed:', describeError(err))
    }
  }

  async messages(sessionId: string): Promise<ChatMessage[]> {
    const api = openCodeService.api
    const res = await api.message.list({ sessionID: sessionId, order: 'asc', limit: 200 })
    const out: ChatMessage[] = []
    for (const m of res.data) {
      if (m.type === 'user') {
        const images = (m.files ?? [])
          .filter((f) => f.mime.startsWith('image/') && f.data)
          .map((f) => ({ name: f.name ?? undefined, mime: f.mime, data: `data:${f.mime};base64,${f.data}` }))
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
          text: text.trim(),
          tools: tools.length ? tools : undefined,
          thinking: thinking.trim() || undefined,
          createdAt: m.time?.created ?? 0
        }
        if (!msg.text && !msg.tools && !msg.thinking) continue
        out.push(msg)
      }
    }
    return out
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
          createdAt: i.time?.created ?? 0
        }))
    } catch {
      return []
    }
  }

  async cancelQueued(sessionId: string, inboxId: string): Promise<void> {
    await openCodeService.api.session.inbox.cancel({ sessionID: sessionId, inboxID: inboxId })
  }

  async prompt(sessionId: string, text: string, images: PromptImage[] = [], queued = false, refs?: PromptRefs): Promise<void> {
    const api = openCodeService.api
    getDb().prepare('UPDATE chat SET updated_at = ? WHERE session_id = ?').run(Date.now(), sessionId)
    const dir = this.directoryOf(sessionId)
    const files = [
      ...images.map((img) => {
        const base64 = img.data.startsWith('data:') ? img.data.slice(img.data.indexOf(',') + 1) : img.data
        return { uri: `data:${img.mime};base64,${base64}`, name: img.name }
      }),
      ...(refs && dir ? fileAttachments(refs, dir) : [])
    ]
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
    if (sessionIndex.kindOf(sessionId) !== 'chat') return
    switch (e.type) {
      case 'session.text.delta': {
        streamBuffer.push({
          kind: 'chat.delta',
          sessionId,
          messageId: String(data.assistantMessageID ?? ''),
          text: typeof data.delta === 'string' ? data.delta : ''
        })
        break
      }
      case 'session.tool.called': {
        send({ kind: 'chat.tool', sessionId, tool: String(data.name ?? data.tool ?? 'tool'), state: 'called' })
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
        send({ kind: 'chat.idle', sessionId })
        break
      }
    }
  }
}

export const chatManager = new ChatManager()
