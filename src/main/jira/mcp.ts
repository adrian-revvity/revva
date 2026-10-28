/**
 * Atlassian MCP client with Revva-owned auth (docs/ARCHITECTURE.md §4).
 *
 * The MCP tool inventory differs across Atlassian deployments, so at connect time we
 * `tools/list` and map CAPABILITIES (search/JQL, get issue, comments, transitions, user
 * info) to actual tool names behind this stable interface. Nothing downstream hardcodes
 * an Atlassian tool name.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { jiraAuth, MCP_URL } from './auth'

export type JiraTicket = {
  key: string
  id: string
  summary: string
  status: string
  statusCategory: string
  storyPoints?: number
  issueTypeName?: string
  dependsOn: string[]
  url?: string
  raw: unknown
}

export type JiraCapability =
  | 'search'
  | 'getIssue'
  | 'addComment'
  | 'transition'
  | 'getTransitions'
  | 'user'

type ToolDef = { name: string; description?: string; inputSchema?: Record<string, unknown> }

/** Preferred tool-name patterns per capability, matched against the live inventory. */
const CAPABILITY_PATTERNS: Record<JiraCapability, RegExp[]> = {
  search: [/searchJiraIssuesUsingJql/i, /search.*\bjql\b/i],
  getIssue: [/^getJiraIssue$/, /get.*issue(?!s)/i],
  addComment: [/addCommentToJiraIssue/, /add.*comment/i],
  transition: [/transitionJiraIssue/, /^transitionIssue$/],
  getTransitions: [/getTransitionsForJiraIssue/, /get.*transitions/i],
  user: [/^getAccessibleAtlassianResources$/, /^atlassianUserInfo$/, /user.*info/i]
}

export class JiraMcp {
  private client: Client | undefined
  private tools: ToolDef[] = []
  private capMap = new Map<JiraCapability, string>()
  private cloudId: string | undefined
  private cachedAccountId: string | null | undefined

  get connected(): boolean {
    return !!this.client
  }

  async connect(): Promise<void> {
    const token = await jiraAuth.accessToken()
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
    const client = new Client({ name: 'revva', version: '0.0.1' })
    await client.connect(transport)
    const listed = await client.listTools()
    this.client = client
    this.tools = listed.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined
    }))
    this.capMap = buildCapabilityMap(this.tools)
    // Dev aid: dump the live contract so argument names can be verified, not guessed.
    try {
      const { app } = await import('electron')
      const { writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      writeFileSync(join(app.getPath('userData'), 'jira-tools.json'), JSON.stringify(this.tools, null, 2))
    } catch {
      /* ignore */
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.close().catch(() => undefined)
    this.client = undefined
    this.capMap.clear()
    this.cloudId = undefined
  }

  /** Re-auth + reconnect (token rotated or stream died). */
  async reconnect(): Promise<void> {
    await this.disconnect()
    await this.connect()
  }

  private tool(cap: JiraCapability): string {
    const name = this.capMap.get(cap)
    if (!name) throw new Error(`Your Atlassian site does not expose the "${cap}" capability via MCP.`)
    return name
  }

  /** Every Jira MCP tool requires cloudId; resolve once from accessible resources. */
  private async resolveCloudId(): Promise<string> {
    if (this.cloudId) return this.cloudId
    const res = await this.call<unknown>('user', {})
    const list = Array.isArray(res)
      ? res
      : ((res as { data?: unknown[] })?.data ?? (Array.isArray((res as { resources?: unknown[] })?.resources) ? (res as { resources: unknown[] }).resources : []))
    const first = list[0] as { id?: string; url?: string } | undefined
    const id = first?.id ?? (first?.url ? new URL(first.url).host : undefined)
    if (!id) throw new Error('No accessible Atlassian site for this account.')
    this.cloudId = id
    return id
  }

  private async call<T>(cap: JiraCapability, args: Record<string, unknown>): Promise<T> {
    if (!this.client) throw new Error('Jira not connected.')
    try {
      const res = await this.client.callTool({ name: this.tool(cap), arguments: args })
      return parseToolResult<T>(res)
    } catch (err) {
      // One transparent retry after re-auth covers token rotation.
      try {
        await this.reconnect()
        const res = await this.client!.callTool({ name: this.tool(cap), arguments: args })
        return parseToolResult<T>(res)
      } catch (err2) {
        throw err2 instanceof Error && err2.message.includes('not connected') ? err : err2
      }
    }
  }

  /** JQL search returning raw-ish issue records (mapped later by board.ts). */
  async search(jql: string, fields?: string[]): Promise<unknown> {
    const cloudId = await this.resolveCloudId()
    return this.call('search', {
      cloudId,
      jql,
      maxResults: 50,
      ...(fields ? { fields } : {}),
      responseContentFormat: 'markdown'
    })
  }

  async getIssue(key: string): Promise<unknown> {
    const cloudId = await this.resolveCloudId()
    return this.call('getIssue', { cloudId, issueIdOrKey: key, responseContentFormat: 'markdown' })
  }

  async addComment(key: string, body: string): Promise<unknown> {
    const cloudId = await this.resolveCloudId()
    return this.call('addComment', { cloudId, issueIdOrKey: key, commentBody: body, contentFormat: 'markdown' })
  }

  async listTransitions(key: string): Promise<unknown> {
    const cloudId = await this.resolveCloudId()
    return this.call('getTransitions', { cloudId, issueIdOrKey: key })
  }

  /** Comments from getIssue (there is no list-comments tool on this MCP). */
  async comments(key: string): Promise<Array<{ id?: string; author?: { displayName?: string; accountId?: string }; body?: unknown; created?: string }>> {
    const raw = (await this.getIssue(key)) as { fields?: Record<string, unknown> } | { issue?: { fields?: Record<string, unknown> } }
    const fields = (raw as { fields?: Record<string, unknown> })?.fields ?? (raw as { issue?: { fields?: Record<string, unknown> } })?.issue?.fields
    const comments = (fields?.comment as { comments?: unknown[] })?.comments
    return Array.isArray(comments) ? (comments as Array<{ id?: string; author?: { displayName?: string; accountId?: string }; body?: unknown; created?: string }>) : []
  }

  /** Our own account id, so we can skip comments revva itself posted. */
  async myAccountId(): Promise<string | undefined> {
    if (this.cachedAccountId !== undefined) return this.cachedAccountId ?? undefined
    try {
      const raw = (await this.call('user', {})) as { accountId?: string; user?: { accountId?: string } }
      this.cachedAccountId = raw?.accountId ?? raw?.user?.accountId ?? null
    } catch {
      this.cachedAccountId = null
    }
    return this.cachedAccountId ?? undefined
  }

  async transitionIssue(key: string, transitionId: string): Promise<unknown> {
    const cloudId = await this.resolveCloudId()
    return this.call('transition', { cloudId, issueIdOrKey: key, transition: { id: transitionId } })
  }

  inventory(): ToolDef[] {
    return this.tools
  }

  capabilities(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {}
    for (const cap of Object.keys(CAPABILITY_PATTERNS) as JiraCapability[]) {
      out[cap] = this.capMap.get(cap)
    }
    return out
  }
}

function buildCapabilityMap(tools: ToolDef[]): Map<JiraCapability, string> {
  const map = new Map<JiraCapability, string>()
  for (const [cap, regs] of Object.entries(CAPABILITY_PATTERNS)) {
    for (const re of regs) {
      const hit = tools.find((t) => re.test(t.name))
      if (hit) {
        map.set(cap as JiraCapability, hit.name)
        break
      }
    }
  }
  return map
}

/** MCP results come back as content blocks; JSON payloads arrive as text. */
export function parseToolResult<T>(res: unknown): T {
  const r = res as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
  const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  if (r.isError) throw new Error(text || 'Atlassian MCP tool error')
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

export const jiraMcp = new JiraMcp()
