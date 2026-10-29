import type { ModelRef, RevvaApi } from '@shared/types'
import { eventBus, type RawEvent } from './bus'
import { openCodeService } from './service'
import { performanceMeter } from './performance'
import { pushToWindows } from '../push'

type Session = Awaited<ReturnType<typeof openCodeService.api.session.get>>
type Models = Awaited<ReturnType<typeof openCodeService.api.model.list>>
type Usage = Awaited<ReturnType<RevvaApi['session']['contextUsage']>>
const metadata = new Map<string, { expires: number; promise: Promise<Session> }>()
const inventory = new Map<string, { expires: number; promise: Promise<Models> }>()
const usage = new Map<string, { value: Usage; cold?: Promise<Usage> }>()
const steps = new Map<string, ModelRef>()
let generation = 0
let wired = false

function bound<T>(cache: Map<string, T>, max = 500): void {
  while (cache.size > max) cache.delete(cache.keys().next().value!)
}

export function sessionMetadata(sessionID: string): Promise<Session> {
  const cached = metadata.get(sessionID)
  if (cached && cached.expires > Date.now()) return cached.promise
  const entry = { expires: Date.now() + 2000, promise: performanceMeter.request('metadata', () => openCodeService.api.session.get({ sessionID }, { signal: AbortSignal.timeout(15_000) })) }
  metadata.set(sessionID, entry)
  bound(metadata)
  void entry.promise.catch(() => { if (metadata.get(sessionID) === entry) metadata.delete(sessionID) })
  return entry.promise
}

export function locationModels(directory: string): Promise<Models> {
  const cached = inventory.get(directory)
  if (cached && cached.expires > Date.now()) return cached.promise
  const entry = { expires: Date.now() + 5 * 60_000, promise: performanceMeter.request('models', () => openCodeService.api.model.list({ location: { directory } }, { signal: AbortSignal.timeout(15_000) })) }
  inventory.set(directory, entry)
  bound(inventory, 64)
  void entry.promise.catch(() => { if (inventory.get(directory) === entry) inventory.delete(directory) })
  return entry.promise
}

function tokenCount(tokens: unknown): number | undefined {
  const value = tokens as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined
  if (!value) return undefined
  const total = Number(value.input) + Number(value.output) + Number(value.reasoning) + Number(value.cache?.read) + Number(value.cache?.write)
  return Number.isFinite(total) && total > 0 ? total : undefined
}

export async function contextUsage(sessionID: string): Promise<Usage> {
  const version = generation
  let entry = usage.get(sessionID)
  if (!entry) {
    entry = { value: null }
    usage.set(sessionID, entry)
    bound(usage)
    const current = entry
    const version = generation
    current.cold = (async () => {
      // A small page cannot prove the active compaction/revert boundary. This is
      // a cold-open/reset fallback only, not a running-session heartbeat.
      const [messages, session] = await Promise.all([
        performanceMeter.request('context.cold', () => openCodeService.api.session.context({ sessionID }, { signal: AbortSignal.timeout(15_000) })),
        sessionMetadata(sessionID)
      ])
      const boundary = session.revert?.messageID
      const end = boundary ? messages.findIndex((message) => message.id === boundary) : messages.length
      const last = end < 0 ? undefined : messages.slice(0, end).findLast((message) => message.type === 'assistant' && message.tokens !== undefined)
      if (usage.get(sessionID) !== current || version !== generation) return null
      // A step event received during the cold request is newer than its snapshot.
      if (!current.value && last?.type === 'assistant') {
        const tokens = tokenCount(last.tokens)
        if (tokens) current.value = { tokens, providerID: last.model.providerID, modelID: last.model.id }
      }
      return current.value
    })().finally(() => { current.cold = undefined })
    void current.cold.catch(() => { if (usage.get(sessionID) === current) usage.delete(sessionID) })
  }
  const value = entry.cold ? await entry.cold : entry.value
  if (!value) return null
  const session = await sessionMetadata(sessionID)
  const models = await locationModels(session.location.directory).catch(() => undefined)
  // Revert/reconnect/model changes can invalidate this entry while metadata or
  // limits are loading. Never let a stale invocation restore old usage.
  if (generation !== version || usage.get(sessionID) !== entry) return null
  const latest = entry.value
  if (!latest) return null
  const limit = models?.data.find((model) => model.providerID === latest.providerID && (model.id === latest.modelID || model.modelID === latest.modelID))?.limit?.context
  return { ...latest, limit: limit && limit > 0 ? limit : undefined }
}

export function wireSessionMetrics(): void {
  if (wired) return
  wired = true
  eventBus.on('stream:reconnect', () => {
    generation++
    metadata.clear(); inventory.clear(); usage.clear(); steps.clear()
  })
  eventBus.on('event', (event: RawEvent) => {
    if (['config.updated', 'model.updated', 'provider.updated', 'models-dev.refreshed', 'credential.switched'].includes(event.type)) {
      inventory.clear()
      pushToWindows({ kind: 'inventory.models' })
    }
    const data = event.data ?? {}
    const sessionID = data.sessionID
    if (typeof sessionID !== 'string') return
    if (['session.model.selected', 'session.agent.selected', 'session.moved', 'session.revert.committed', 'session.revert.cleared', 'session.compaction.ended', 'session.message.content.updated'].includes(event.type)) metadata.delete(sessionID)
    if (['session.model.selected', 'session.revert.committed', 'session.revert.cleared', 'session.compaction.ended', 'session.message.content.updated'].includes(event.type)) {
      usage.delete(sessionID)
      if (event.type !== 'session.model.selected') for (const key of steps.keys()) if (key.startsWith(`${sessionID}:`)) steps.delete(key)
      pushToWindows({ kind: 'session.metrics', sessionId: sessionID })
    }
    if (event.type === 'session.moved') pushToWindows({ kind: 'session.metrics', sessionId: sessionID })
    const key = `${sessionID}:${String(data.assistantMessageID)}`
    if (event.type === 'session.step.started') {
      const model = data.model as ModelRef | undefined
      if (model) { steps.set(key, model); bound(steps) }
    }
    if (event.type === 'session.step.ended' || event.type === 'session.step.failed') {
      const model = steps.get(key)
      const tokens = tokenCount(data.tokens)
      if (model && tokens) {
        const current = usage.get(sessionID)
        const value = { tokens, providerID: model.providerID, modelID: model.id }
        if (current) current.value = value
        else usage.set(sessionID, { value })
        bound(usage)
      } else if (tokens) usage.delete(sessionID)
      steps.delete(key)
      pushToWindows({ kind: 'session.metrics', sessionId: sessionID })
    }
  })
}
