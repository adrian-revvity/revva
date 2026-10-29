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
  // Classic projects: parent is an object; team-managed: parent is a one-element array.
  const parent = Array.isArray(f.parent) ? f.parent[0] : f.parent
  const parentKey = (parent as Record<string, unknown> | undefined)?.key
  return {
    key: raw.key,
    id: raw.id ?? raw.key,
    summary: String(f.summary ?? ''),
    status: String((status?.name as string | undefined) ?? (typeof f.status === 'string' ? f.status : '?')),
    statusCategory: String(category?.name ?? category?.key ?? 'New'),
    storyPoints: typeof points === 'number' ? points : Number(points) || undefined,
    issueTypeName: issuetype?.name ? String(issuetype.name) : undefined,
    subtaskCount: Array.isArray(f.subtasks) ? (f.subtasks as unknown[]).length : undefined,
    parentKey: typeof parentKey === 'string' ? parentKey : undefined,
    dependsOn,
    url: raw.self ? String(raw.self) : undefined,
    raw
  }
}

export async function fetchBoard(): Promise<JiraTicket[]> {
  if (!jiraMcp.connected) await jiraMcp.connect()

  const result = await jiraMcp.search(BOARD_JQL, [
    'summary',
    'status',
    'issuetype',
    'subtasks',
    'issuelinks',
    'story_points',
    'parent'
  ])
  const tickets = issuesFrom(result).map(mapIssue).filter((t): t is JiraTicket => !!t)

  cacheTickets(tickets)
  return tickets
}

/** Sub-tickets (fields.subtasks) of one issue, mapped like board cards. */
export async function fetchSubtasks(key: string): Promise<JiraTicket[]> {
  if (!jiraMcp.connected) await jiraMcp.connect()

  const raw = (await jiraMcp.getIssue(key, ['summary', 'status', 'issuetype', 'subtasks', 'parent'])) as
    | RawIssue
    | { issue?: RawIssue }
  const issue = (raw as RawIssue)?.fields ? (raw as RawIssue) : (raw as { issue?: RawIssue }).issue
  const fields = issue?.fields
  // Sub-tasks sit under fields.subtasks; some envelopes hoist them to the top level.
  // Last resort: the board search cached the same array in the parent's raw row.
  let list = arr(fields?.subtasks ?? (raw as Record<string, unknown>)?.subtasks)
  if (list.length === 0) {
    const row = getDb().prepare('SELECT raw FROM ticket WHERE key = ?').get(key) as { raw: string } | undefined
    if (row) {
      try {
        const cached = JSON.parse(row.raw) as RawIssue
        list = arr((cached.fields as Record<string, unknown> | undefined)?.subtasks)
      } catch {
        /* cached raw was not parseable — nothing to fall back to */
      }
    }
  }
  const tickets = list
    .map((s) => {
      const r = s as RawIssue
      // Some feeds key subtasks by id only; key is what every downstream uses.
      // Sub-task summaries inside the parent payload are sometimes missing.
      return mapIssue({ ...r, key: r.key ?? (r.id ? String(r.id) : undefined) })
    })
    .filter((t): t is JiraTicket => !!t)

  cacheTickets(tickets)
  return tickets
}

function cacheTickets(tickets: JiraTicket[]): void {
  const db = getDb()
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO ticket(key, jira_id, summary, status, status_category, points, depends_on, raw, synced_at, issue_type, subtask_count, parent_key)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET summary=excluded.summary, status=excluded.status,
       status_category=excluded.status_category, points=excluded.points,
       depends_on=excluded.depends_on, raw=excluded.raw, synced_at=excluded.synced_at,
       issue_type=excluded.issue_type, subtask_count=excluded.subtask_count,
       parent_key=excluded.parent_key`
  )
  const tx = db.transaction((rows: JiraTicket[]) => {
    for (const t of rows) {
      stmt.run(t.key, t.id, t.summary, t.status, t.statusCategory, t.storyPoints ?? null, JSON.stringify(t.dependsOn), JSON.stringify(t.raw), now, t.issueTypeName ?? null, t.subtaskCount ?? null, t.parentKey ?? null)
    }
  })
  tx(tickets)
}

export async function getTicket(key: string): Promise<JiraTicket | undefined> {
  const row = getDb().prepare('SELECT * FROM ticket WHERE key = ?').get(key) as
    | { key: string; jira_id: string; summary: string; status: string; status_category: string; points: number | null; depends_on: string; raw: string; issue_type: string | null; subtask_count: number | null; parent_key: string | null }
    | undefined
  if (row) {
    return {
      key: row.key,
      id: row.jira_id,
      summary: row.summary,
      status: row.status,
      statusCategory: row.status_category,
      storyPoints: row.points ?? undefined,
      issueTypeName: row.issue_type ?? undefined,
      subtaskCount: row.subtask_count ?? undefined,
      parentKey: row.parent_key ?? undefined,
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
