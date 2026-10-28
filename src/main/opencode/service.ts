/**
 * OpenCode local service attachment.
 *
 * `Service.ensure()` discovers a healthy local OpenCode service (registration file) or starts
 * one via `opencode serve --service`. We never rewrite the user's OpenCode config; we only
 * connect over HTTP with the advertised basic-auth headers.
 */
import { Service, type Endpoint } from '@opencode/client/service'
import { OpenCode } from '@opencode/client'
import { app } from 'electron'
import type { ServiceStatus } from '@shared/types'
import { pushToWindows } from '../push'

type Listener = (status: ServiceStatus) => void

export class OpenCodeService {
  private endpoint: Endpoint | undefined
  private client: ReturnType<typeof OpenCode.make> | undefined
  private status: ServiceStatus = { state: 'connecting', lastCheckedAt: 0 }
  private listeners = new Set<Listener>()
  private reconnectTimer: NodeJS.Timeout | undefined
  private stopped = false

  onStatus(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getStatus(): ServiceStatus {
    return this.status
  }

  /** Client for the current endpoint; throws a friendly error when not attached. */
  get api(): ReturnType<typeof OpenCode.make> {
    if (!this.client) {
      throw new Error(this.status.message ?? 'OpenCode service is not connected yet. Is `opencode` installed?')
    }
    return this.client
  }

  get connected(): boolean {
    return this.status.state === 'connected' && !!this.client
  }

  async ensure(): Promise<ServiceStatus> {
    this.setStatus({ state: 'connecting', lastCheckedAt: Date.now(), message: undefined })
    try {
      const endpoint = await Service.ensure({
        onStart: (reason) => {
          this.setStatus({
            state: 'connecting',
            lastCheckedAt: Date.now(),
            message: reason === 'missing' ? 'Starting local OpenCode service…' : 'Restarting OpenCode service (version mismatch)…'
          })
        }
      })
      this.endpoint = endpoint
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
      const info = await client.server.info()
      this.client = client
      this.setStatus({ state: 'connected', url: endpoint.url, version: info.version, lastCheckedAt: Date.now() })
      this.scheduleHealthCheck()
    } catch (err) {
      this.client = undefined
      this.endpoint = undefined
      const message = describeError(err)
      const missing = /ENOENT|not found|spawn/i.test(message)
      this.setStatus({
        state: missing ? 'missing' : 'error',
        lastCheckedAt: Date.now(),
        message: missing
          ? 'OpenCode was not found on this machine. Install it (https://opencode.ai) and retry.'
          : message
      })
      this.scheduleHealthCheck()
    }
    return this.status
  }

  /** Headless-safe DB path bootstrap note: userData is owned by app, no hardcoded homes. */
  get userDataDir(): string {
    return app.getPath('userData')
  }

  private scheduleHealthCheck(): void {
    if (this.stopped) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      void this.probeAndMaybeReensure()
    }, 15_000)
  }

  /** Cheap probe: if connected but the service died, drop to connecting and re-ensure. */
  private async probeAndMaybeReensure(): Promise<void> {
    if (this.stopped) return
    if (this.connected && this.endpoint) {
      try {
        const res = await fetch(`${this.endpoint.url}/api/server`, {
          headers: Service.headers(this.endpoint) as Record<string, string>,
          signal: AbortSignal.timeout(4000)
        })
        // Any HTTP answer (even 404) means the process is alive; only network failure retries.
        if (res.status >= 0) {
          this.scheduleHealthCheck()
          return
        }
      } catch {
        // fall through to re-ensure
      }
    }
    await this.ensure()
  }

  private setStatus(next: ServiceStatus): void {
    this.status = next
    for (const fn of this.listeners) fn(next)
    pushToWindows({ kind: 'service', status: next })
  }

  dispose(): void {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export const openCodeService = new OpenCodeService()
