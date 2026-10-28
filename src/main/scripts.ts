/**
 * User scripts: one-click shell commands (aliases included) from the sidebar.
 * Definitions and run history live in Revva's sqlite DB. Commands run through
 * the platform's shell — zsh on unix (so aliases/functions from rc files work),
 * PowerShell on Windows (profile aliases unavailable; plain commands are) —
 * Revva ships no knowledge of what the scripts do.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { IPC, type ScriptDef, type ScriptInput, type ScriptRunRow, type ScriptStatus } from '@shared/types'
import { openCodeService } from './opencode/service'

const OUTPUT_TAIL_LIMIT = 16_384
const OUTPUT_CHUNK_CAP = 4096

interface Running {
  proc: ChildProcess
  startedAt: number
  runId: number
  tail: string
}

class ScriptManager {
  private running = new Map<string, Running>()
  private wired = false

  wire(): void {
    if (this.wired) return
    this.wired = true
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS script (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL,
        cwd TEXT, interactive INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS script_run (
        id INTEGER PRIMARY KEY AUTOINCREMENT, script_id TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, output_tail TEXT
      );
    `)
  }

  list(): ScriptDef[] {
    const rows = getDb().prepare('SELECT * FROM script ORDER BY created_at').all() as Array<{
      id: string
      name: string
      command: string
      cwd: string | null
      interactive: number
      created_at: number
    }>
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      command: r.command,
      cwd: r.cwd ?? undefined,
      interactive: r.interactive === 1,
      createdAt: r.created_at
    }))
  }

  save(input: ScriptInput): ScriptDef {
    const db = getDb()
    const id = input.id ?? randomUUID()
    const existing = db.prepare('SELECT created_at FROM script WHERE id = ?').get(id) as { created_at: number } | undefined
    const createdAt = existing?.created_at ?? Date.now()
    db.prepare(
      `INSERT INTO script(id, name, command, cwd, interactive, created_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, command=excluded.command, cwd=excluded.cwd, interactive=excluded.interactive`
    ).run(id, input.name.trim(), input.command, input.cwd ?? null, input.interactive ? 1 : 0, createdAt)
    return this.list().find((s) => s.id === id)!
  }

  remove(id: string): void {
    this.kill(id)
    getDb().prepare('DELETE FROM script WHERE id = ?').run(id)
    this.pushStatus()
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  /** Fire-and-forget; progress arrives via script.output / script.status pushes. */
  run(id: string): { ok: boolean } {
    if (this.running.has(id)) return { ok: false }
    const def = this.list().find((s) => s.id === id)
    if (!def) throw new Error('Script not found.')

    const isWin = process.platform === 'win32'
    const [shell, args] = isWin
      ? ['powershell.exe', def.interactive ? ['-Command', def.command] : ['-NoProfile', '-Command', def.command]]
      : ['/bin/zsh', def.interactive ? ['-ic', def.command] : ['-c', def.command]]
    const proc = spawn(shell, args, {
      cwd: def.cwd || undefined,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so kill() takes down children (e.g. a proxy).
      // On Windows the tree is killed via taskkill /T instead.
      detached: !isWin
    })

    const runId = getDb()
      .prepare('INSERT INTO script_run(script_id, started_at) VALUES(?, ?)')
      .run(id, Date.now()).lastInsertRowid as number
    const state: Running = { proc, startedAt: Date.now(), runId, tail: '' }
    this.running.set(id, state)

    const onData = (buf: Buffer): void => {
      const text = buf.toString('utf8')
      state.tail = (state.tail + text).slice(-OUTPUT_TAIL_LIMIT)
      this.push({ kind: 'script.output', scriptId: id, chunk: text.slice(0, OUTPUT_CHUNK_CAP) })
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', (err: Error) => {
      onData(Buffer.from(`\n[revva] failed to start: ${err.message}\n`))
      this.finish(id, -1)
    })
    proc.on('close', (code) => this.finish(id, code ?? -1))

    this.pushStatus()
    return { ok: true }
  }

  kill(id: string): void {
    const st = this.running.get(id)
    if (!st) return
    const pid = st.proc.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      // No process groups; kill the whole child tree the shell spawned.
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
      return
    }
    // zsh -ic spawns children; kill the group.
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      st.proc.kill('SIGTERM')
    }
  }

  status(): ScriptStatus[] {
    const db = getDb()
    return this.list().map((s) => {
      const last = db
        .prepare(
          `SELECT exit_code, started_at, ended_at FROM script_run
           WHERE script_id = ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1`
        )
        .get(s.id) as { exit_code: number | null; started_at: number; ended_at: number } | undefined
      return {
        id: s.id,
        running: this.running.has(s.id),
        lastExit: last?.exit_code ?? null,
        lastRunAt: last?.ended_at ?? null,
        lastDurationMs: last ? last.ended_at - last.started_at : null
      }
    })
  }

  history(id: string): ScriptRunRow[] {
    const rows = getDb()
      .prepare(
        `SELECT id, script_id, started_at, ended_at, exit_code, output_tail FROM script_run
         WHERE script_id = ? ORDER BY id DESC LIMIT 20`
      )
      .all(id) as Array<{ id: number; script_id: string; started_at: number; ended_at: number | null; exit_code: number | null; output_tail: string | null }>
    return rows.map((r) => ({
      id: r.id,
      scriptId: r.script_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      exitCode: r.exit_code,
      outputTail: r.output_tail ?? ''
    }))
  }

  /**
   * Providers that call a loopback endpoint (e.g. a local proxy) plus whether
   * that port is currently listening. Drives model gating and the Scripts
   * "ready" hint — without Revva knowing anything specific about AWS/Bedrock.
   */
  async providerNeeds(): Promise<{ providerID: string; baseURL: string; port: number; up: boolean }[]> {
    if (!openCodeService.connected) return []
    try {
      const res = await openCodeService.api.provider.list()
      const out: { providerID: string; baseURL: string; port: number; up: boolean }[] = []
      for (const p of res.data) {
        const base = (p.settings as Record<string, unknown> | undefined)?.baseURL
        if (typeof base === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(base)) {
          const url = new URL(base)
          const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
          out.push({ providerID: p.id, baseURL: base, port, up: await portListening(port) })
        }
      }
      return out
    } catch {
      return []
    }
  }

  private finish(id: string, exitCode: number): void {
    const st = this.running.get(id)
    if (!st) return
    this.running.delete(id)
    getDb()
      .prepare('UPDATE script_run SET ended_at = ?, exit_code = ?, output_tail = ? WHERE id = ?')
      .run(Date.now(), exitCode, st.tail.slice(-OUTPUT_TAIL_LIMIT), st.runId)
    this.pushStatus()
  }

  private push(event: { kind: 'script.output'; scriptId: string; chunk: string } | { kind: 'script.status'; status: ScriptStatus[] }): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.eventPush, event)
    }
  }

  private pushStatus(): void {
    this.push({ kind: 'script.status', status: this.status() })
  }
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host: '127.0.0.1', port })
    const done = (up: boolean): void => {
      sock.destroy()
      resolve(up)
    }
    sock.setTimeout(1000, () => done(false))
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
  })
}

export const scriptManager = new ScriptManager()
