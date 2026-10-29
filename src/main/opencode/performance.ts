import { randomUUID } from 'node:crypto'

/** Content-free, bounded aggregates. Disabled diagnostics allocate no timer. */
const enabled = process.env.REVVA_DEBUG_PERF === '1'
const totals = new Map<string, number>()
const gauges = new Map<string, number>([['registry.active', 0], ['subscriptions.sessions', 0], ['subscriptions.visible', 0]])
let concurrent = 0
let peak = 0
let recoveryConcurrent = 0
let recoveryPeak = 0
if (enabled) {
  setInterval(() => {
    console.log('[perf]', JSON.stringify({ ...Object.fromEntries(totals), ...Object.fromEntries(gauges), concurrent, peak, recoveryConcurrent, recoveryPeak }))
    totals.clear()
    peak = concurrent
    recoveryPeak = recoveryConcurrent
  }, 5000).unref()
}
export const performanceMeter = {
  enabled,
  gauge(name: string, value: number): void { if (enabled) gauges.set(name, value) },
  add(name: string, amount = 1): void {
    if (enabled) totals.set(name, (totals.get(name) ?? 0) + amount)
  },
  async request<T>(kind: string, run: () => Promise<T>): Promise<T> {
    if (!enabled) return run()
    const correlation = randomUUID()
    const start = performance.now()
    concurrent++
    const recovery = kind === 'inbox.forms' || kind === 'inbox.permissions'
    if (recovery) { recoveryConcurrent++; recoveryPeak = Math.max(recoveryPeak, recoveryConcurrent) }
    peak = Math.max(peak, concurrent)
    this.add(`${kind}.requests`)
    try { return await run() } finally {
      concurrent--
      if (recovery) recoveryConcurrent--
      this.add(`${kind}.ms`, performance.now() - start)
      // IDs are generated locally; never log session IDs or request contents.
      this.add('correlations', correlation ? 1 : 0)
    }
  }
}
