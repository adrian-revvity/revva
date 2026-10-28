/**
 * Board: JQL for the user's current-sprint assigned tickets, mapped to the Ticket DTO,
 * with issue-link dependency detection (blocks → dependsOn). Cached in sqlite.
 */
import { jiraMcp, parseToolResult, type JiraTicket } from './mcp'
import { getDb } from '../db'

const BOARD_JQL =
  "sprint in openSprints() AND assignee = currentUser() AND statusCategory != Done ORDER BY rank ASC"

type RawIssue = {
  id?: string
  key?: string
  self?: string
  fields?: Record<string, unknown>
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Unwrap common MCP result envelopes to an issue array. */
function issuesFrom(result: unknown): RawIssue[] {
  if (Array.isArray(result)) return result as RawIssue[]
  const r = result as Record<string, unknown>
  for (const key of ['issues', 'data', 'results']) {
    const v = r?.[key]
    if (Array.isArray(v)) return v as RawIssue[]
    if (v && typeof v === 'object') {
      const inner = (v as Record<string, unknown>)[key]
      if (Array.isArray(inner)) return inner as RawIssue[]
    }
  }
  return []
}

function mapIssue(raw: RawIssue): JiraTicket | undefined {
  const f = raw.fields
  if (!raw.key || !f) return undefined
  const status = f.status as Record<string, unknown> | undefined
  const category = (status?.statusCategory ?? status?.status_category) as Record<string, unknown> | undefined
  const issuetype = f.issuetype as Record<string, unknown> | undefined
  const dependsOn: string[] = []
  for (const link of arr(f.issuelinks ?? f.issueLinks)) {
    const l = link as Record<string, unknown>
    const type = (l.type ?? {}) as Record<string, unknown>
    const inward = String(type.inward ?? '').toLowerCase()
    // "Blocks X" outward → X is parent; "is blocked by Y" inward → Y is parent.
    const outwardIn = l.outward ?? l.inward
    const other = (l.inwardIssue ?? l.outwardIssue ?? {}) as Record<string, unknown>
    if (typeof outwardIn === 'string' && (outwardIn.toLowerCase().includes('blocked by') || inward.includes('is blocked by'))) {
      if (typeof other.key === 'string') dependsOn.push(other.key)
    }
  }
  const points = f.story_points ?? f.storyPoints ?? f['customfield_10004']
  return {
    key: raw.key,
    id: raw.id ?? raw.key,
    summary: String(f.summary ?? ''),
    status: String((status?.name as string | undefined) ?? (typeof f.status === 'string' ? f.status : '?')),
    statusCategory: String(category?.name ?? category?.key ?? 'New'),
    storyPoints: typeof points === 'number' ? points : Number(points) || undefined,
    issueTypeName: issuetype?.name ? String(issuetype.name) : undefined,
    dependsOn,
    url: raw.self ? String(raw.self) : undefined,
    raw
  }
}

export async function fetchBoard(): Promise<JiraTicket[]> {
  if (!jiraMcp.connected) await jiraMcp.connect()

  const result = await jiraMcp.search(BOARD_JQL)
  const tickets = issuesFrom(result).map(mapIssue).filter((t): t is JiraTicket => !!t)

  cacheTickets(tickets)
  return tickets
}

function cacheTickets(tickets: JiraTicket[]): void {
  const db = getDb()
  const now = Date.now()
  db.exec(`CREATE TABLE IF NOT EXISTS ticket (
    key TEXT PRIMARY KEY, jira_id TEXT, summary TEXT, status TEXT, status_category TEXT,
    points REAL, depends_on TEXT, raw TEXT, synced_at INTEGER
  );`)
  const stmt = db.prepare(
    `INSERT INTO ticket(key, jira_id, summary, status, status_category, points, depends_on, raw, synced_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET summary=excluded.summary, status=excluded.status,
       status_category=excluded.status_category, points=excluded.points,
       depends_on=excluded.depends_on, raw=excluded.raw, synced_at=excluded.synced_at`
  )
  const tx = db.transaction((rows: JiraTicket[]) => {
    for (const t of rows) {
      stmt.run(t.key, t.id, t.summary, t.status, t.statusCategory, t.storyPoints ?? null, JSON.stringify(t.dependsOn), JSON.stringify(t.raw), now)
    }
  })
  tx(tickets)
}

export async function getTicket(key: string): Promise<JiraTicket | undefined> {
  const row = getDb().prepare('SELECT * FROM ticket WHERE key = ?').get(key) as
    | { key: string; jira_id: string; summary: string; status: string; status_category: string; points: number | null; depends_on: string; raw: string }
    | undefined
  if (row) {
    return {
      key: row.key,
      id: row.jira_id,
      summary: row.summary,
      status: row.status,
      statusCategory: row.status_category,
      storyPoints: row.points ?? undefined,
      dependsOn: JSON.parse(row.depends_on) as string[],
      raw: JSON.parse(row.raw) as unknown
    }
  }
  try {
    const raw = (await jiraMcp.getIssue(key)) as RawIssue
    return mapIssue(raw)
  } catch {
    return undefined
  }
}
