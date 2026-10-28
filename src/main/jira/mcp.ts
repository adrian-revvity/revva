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

type ToolDef = { name: string; description?: string }

/** Preferred tool-name patterns per capability, matched against the live inventory. */
const CAPABILITY_PATTERNS: Record<JiraCapability, RegExp[]> = {
  search: [/^search$/, /\bsearch\b.*\b(jira|issue)/i, /jql/i],
  getIssue: [/^getIssue$/, /get.*\bissue\b(?!s)/i],
  addComment: [/^addComment$/, /add.*comment/i],
  transition: [/^transitionIssue$/, /do.*transition|set.*transition/i],
  getTransitions: [/^getTransitions$/, /get.*transitions/i],
  user: [/^getAccessibleAtlassianResources$/, /^atlassianUserInfo$/, /user.*info/i]
}

export class JiraMcp {
  private client: Client | undefined
  private tools: ToolDef[] = []
  private capMap = new Map<JiraCapability, string>()

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
    this.tools = listed.tools.map((t) => ({ name: t.name, description: t.description }))
    this.capMap = buildCapabilityMap(this.tools)
  }

  async disconnect(): Promise<void> {
    await this.client?.close().catch(() => undefined)
    this.client = undefined
    this.capMap.clear()
  }

  /** Re-auth + reconnect (token rotated or stream died). */
  async reconnect(): Promise<void> {
    await this.disconnect()
    await this.connect()
  }

  private tool(cap: JiraCapability | 'getTransitions'): string {
    const name = this.capMap.get(cap as JiraCapability)
    if (!name) throw new Error(`Your Atlassian site does not expose the "${cap}" capability via MCP.`)
    return name
  }

  private async call<T>(cap: JiraCapability | 'getTransitions', args: Record<string, unknown>): Promise<T> {
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
    return this.call('search', { jql, maxResults: 50, fields })
  }

  async getIssue(key: string): Promise<unknown> {
    return this.call('getIssue', { issueIdOrKey: key })
  }

  async addComment(key: string, body: string): Promise<unknown> {
    // text: a minimal ADF doc (paragraph with one text run) — accepted as markdown-ish too.
    return this.call('addComment', { issueIdOrKey: key, text: body })
  }

  async listTransitions(key: string): Promise<unknown> {
    return this.call('getTransitions', { issueIdOrKey: key })
  }

  async transitionIssue(key: string, transitionId: string): Promise<unknown> {
    return this.call('transition', { issueIdOrKey: key, transitionId })
  }

  inventory(): ToolDef[] {
    return this.tools
  }

  capabilities(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {}
    for (const cap of [...Object.keys(CAPABILITY_PATTERNS), 'getTransitions'] as JiraCapability[]) {
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
