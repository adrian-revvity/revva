/**
 * General chats: ordinary OpenCode sessions with no ticket/pipeline metadata.
 * Revva only stores the index (which session is a chat, its title/dir) in sqlite;
 * all transcript state lives in OpenCode.
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { openCodeService, describeError } from './service'
import { eventBus, type RawEvent } from './bus'
import { getDb } from '../db'
import { IPC, type ChatCreateInput, type ChatMessage, type ChatSummary, type PushEvent } from '@shared/types'

interface ChatRow {
  session_id: string
  title: string
  directory: string
  agent_id: string | null
  provider_id: string | null
  model_id: string | null
  created_at: number
  updated_at: number
}

function rowToSummary(row: ChatRow): ChatSummary {
  return {
    sessionId: row.session_id,
    title: row.title,
    directory: row.directory,
    agentID: row.agent_id ?? undefined,
    providerID: row.provider_id ?? undefined,
    modelID: row.model_id ?? undefined,
    updatedAt: row.updated_at
  }
}

function send(event: PushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.eventPush, event)
}

class ChatManager {
  private wired = false
  /** messageID → accumulated streamed text, for live transcript updates. */
  private streaming = new Map<string, { sessionId: string; text: string }>()

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
    const api = openCodeService.api
    const title = input.title?.trim() || 'New chat'
    const session = await api.session.create({
      title,
      agent: input.agentID ?? null,
      model: input.model ? { providerID: input.model.providerID, id: input.model.id } : null,
      location: { directory: input.directory },
      metadata: { revva: { kind: 'chat' } }
    })
    const now = Date.now()
    getDb()
      .prepare(
        `INSERT INTO chat(session_id, title, directory, agent_id, provider_id, model_id, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(session.id, title, input.directory, input.agentID ?? null, input.model?.providerID ?? null, input.model?.id ?? null, now, now)
    return {
      sessionId: session.id,
      title,
      directory: input.directory,
      agentID: input.agentID,
      providerID: input.model?.providerID,
      modelID: input.model?.id,
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
        out.push({ id: m.id, role: 'user', text: m.text ?? '', createdAt: m.time?.created ?? 0 })
      } else if (m.type === 'assistant') {
        let text = ''
        for (const part of m.content ?? []) {
          const p = part as Record<string, unknown>
          if (p.type === 'text' && typeof p.text === 'string') text += p.text
          else if (p.type === 'tool') text += `\n[tool · ${String(p.name ?? p.tool ?? '?')}]\n`
        }
        out.push({ id: m.id, role: 'assistant', text: text.trim(), createdAt: m.time?.created ?? 0 })
      }
    }
    return out.filter((m) => m.text.length > 0)
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const api = openCodeService.api
    getDb().prepare('UPDATE chat SET updated_at = ? WHERE session_id = ?').run(Date.now(), sessionId)
    await api.session.prompt({ sessionID: sessionId, text })
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
  }

  private touch(sessionId: string): void {
    getDb().prepare('UPDATE chat SET updated_at = ? WHERE session_id = ?').run(Date.now(), sessionId)
  }

  private isChat(sessionId: string): boolean {
    return getDb().prepare('SELECT 1 FROM chat WHERE session_id = ?').get(sessionId) !== undefined
  }

  private onEvent(e: RawEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>
    const sessionId = data.sessionID
    if (typeof sessionId !== 'string') return
    if (!this.isChat(sessionId)) return
    switch (e.type) {
      case 'session.text.delta': {
        const msgId = String(data.assistantMessageID ?? '')
        const entry = this.streaming.get(msgId) ?? { sessionId, text: '' }
        entry.text += typeof data.delta === 'string' ? data.delta : ''
        this.streaming.set(msgId, entry)
        send({ kind: 'chat.delta', sessionId, messageId: msgId, text: entry.text })
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
        this.streaming.clear()
        send({ kind: 'chat.idle', sessionId })
        break
      }
    }
  }
}

export const chatManager = new ChatManager()
