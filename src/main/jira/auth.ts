/**
 * Atlassian MCP OAuth owned by Revva (REQ: no dependence on another app's token cache).
 *
 * Verified 2026-10-28 against https://mcp.atlassian.com:
 *  - /.well-known/oauth-authorization-server → authorize/token/register endpoints
 *  - Dynamic client registration works: token_endpoint_auth_method "none" (public client, PKCE)
 *  - Unauthenticated MCP POST → 401 (endpoint reachable from Node with MCP headers)
 *
 * Flow: loopback listener on a random port → DCR bound to that redirect_uri →
 * system-browser authorize w/ PKCE → token exchange → tokens in Electron
 * safeStorage (OS keychain-backed). Refresh tokens extend silently.
 */
import { app, safeStorage, shell } from 'electron'
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

const ISSUER = 'https://mcp.atlassian.com'
const AUTHORIZE_URL = `${ISSUER}/v1/authorize`
const TOKEN_URL = `${ISSUER}/v1/token`
const REGISTER_URL = `${ISSUER}/v1/register`
export const MCP_URL = `${ISSUER}/v1/mcp`
const SCOPE = 'read:jira-work write:jira-work read:jira-user offline_access'
const CONNECT_TIMEOUT_MS = 300_000

type Tokens = { access_token: string; refresh_token?: string; expires_at: number }
type ClientReg = { client_id: string; client_secret?: string; redirect_uri: string }

export type JiraAuthStatus = { connected: boolean; expired: boolean; expiresAt?: number }

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

class JiraAuth {
  private tokens: Tokens | undefined
  private client: ClientReg | undefined

  private get secretsDir(): string {
    return join(app.getPath('userData'), 'secrets')
  }
  private get storePath(): string {
    return join(this.secretsDir, 'atlassian.bin')
  }
  private get clientPath(): string {
    return join(this.secretsDir, 'atlassian-client.json')
  }

  async load(): Promise<void> {
    try {
      if (existsSync(this.clientPath)) {
        this.client = JSON.parse(readFileSync(this.clientPath, 'utf8')) as ClientReg
      }
      if (existsSync(this.storePath) && safeStorage.isEncryptionAvailable()) {
        const json = safeStorage.decryptString(readFileSync(this.storePath))
        this.tokens = json ? (JSON.parse(json) as Tokens) : undefined
      }
    } catch {
      this.tokens = undefined
    }
  }

  private persist(): void {
    mkdirSync(this.secretsDir, { recursive: true })
    if (this.client) writeFileSync(this.clientPath, JSON.stringify(this.client))
    if (this.tokens && safeStorage.isEncryptionAvailable()) {
      writeFileSync(this.storePath, safeStorage.encryptString(JSON.stringify(this.tokens)))
    }
  }

  status(): JiraAuthStatus {
    if (!this.tokens) return { connected: false, expired: false }
    const live = Date.now() < this.tokens.expires_at - 30_000
    return { connected: live, expired: !live, expiresAt: this.tokens.expires_at }
  }

  /** Access token, refreshed when close to expiry. Throws when not connected. */
  async accessToken(): Promise<string> {
    if (!this.tokens) throw new Error('Jira is not connected. Connect it in Setup.')
    if (Date.now() > this.tokens.expires_at - 60_000 && this.tokens.refresh_token) {
      await this.refresh()
    }
    if (!this.tokens || Date.now() > this.tokens.expires_at) {
      throw new Error('Jira session expired — reconnect in Setup.')
    }
    return this.tokens.access_token
  }

  /** Opens the system browser for consent; waits on a loopback redirect (5-min budget). */
  async connect(): Promise<void> {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = randomUUID()

    // 1. Loopback listener on a random free port.
    const { server, port, codePromise } = await startListener(state)
    const redirectUri = `http://127.0.0.1:${port}/callback`

    try {
      // 2. Register a client bound to this exact redirect (cheap; also refreshes stale ones).
      const res = await fetch(REGISTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Revva',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        })
      })
      if (!res.ok) throw new Error(`Atlassian client registration failed: ${res.status} ${await res.text()}`)
      const data = (await res.json()) as ClientReg
      this.client = { client_id: data.client_id, client_secret: data.client_secret, redirect_uri: redirectUri }

      // 3. Authorize in the system browser.
      const authUrl = new URL(AUTHORIZE_URL)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', this.client.client_id)
      authUrl.searchParams.set('redirect_uri', redirectUri)
      authUrl.searchParams.set('scope', SCOPE)
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      await shell.openExternal(authUrl.toString())

      // 4. Wait for the redirect.
      const code = await Promise.race([
        codePromise,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('Jira sign-in timed out (5 minutes).')), CONNECT_TIMEOUT_MS)
        )
      ])

      // 5. Exchange.
      this.tokens = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier
      })
      this.persist()
    } finally {
      server.close()
    }
  }

  async refresh(): Promise<void> {
    if (!this.tokens?.refresh_token || !this.client) throw new Error('Nothing to refresh — reconnect Jira.')
    try {
      this.tokens = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refresh_token
      })
      this.persist()
    } catch (err) {
      this.tokens = undefined
      this.persist()
      throw err
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<Tokens> {
    if (!this.client) throw new Error('No Atlassian client registered.')
    const body = new URLSearchParams({ ...params, client_id: this.client.client_id })
    if (this.client.client_secret) body.set('client_secret', this.client.client_secret)
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!res.ok) throw new Error(`Atlassian token error ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number }
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? this.tokens?.refresh_token,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000
    }
  }

  async disconnect(): Promise<void> {
    this.tokens = undefined
    mkdirSync(this.secretsDir, { recursive: true })
    writeFileSync(this.storePath, '')
  }
}

function startListener(state: string): Promise<{ server: Server; port: number; codePromise: Promise<string> }> {
  return new Promise((resolve, reject) => {
    let deliver: (code: string) => void = () => undefined
    let fail: (err: Error) => void = () => undefined
    const codePromise = new Promise<string>((res, rej) => {
      deliver = res
      fail = rej
    })
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') return void res.writeHead(404).end()
      const err = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (err || !code || url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<h3>Revva sign-in failed.</h3>You can close this tab.')
        fail(new Error(err ?? 'missing code/state'))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h3>Revva is connected to Jira.</h3>You can close this tab and return to Revva.')
      deliver(code)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port, codePromise })
    })
  })
}

export const jiraAuth = new JiraAuth()
