/**
 * AI-written PR descriptions.
 *
 * Everything is read through the user's `gh` CLI, so this works for any PR the
 * menu can see — no local checkout of the PR head required. The generated text
 * replaces only Revva's own marked section of the body; anything the user wrote
 * outside those markers survives verbatim.
 *
 * The model comes from the `prDescription` role default (Setup → Role defaults),
 * never a hardcoded ID; with no role default the OpenCode service default is used.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openCodeService } from './opencode/service'
import { eventBus, type RawEvent } from './opencode/bus'
import { getDb, roleConfigGet, settingGet } from './db'
import { parsePrRef } from '@shared/pr-ref'
import { mergeRevvaSection, stripRevvaMarkers, unwrapMarkdownFence } from '@shared/pr-description'
import { renderPrompt, DEFAULT_PR_DESCRIPTION_PROMPT } from '@shared/prompts'
import type { PrDescriptionDraft } from '@shared/types'

const exec = promisify(execFile)

/** Model calls outlive the default 60s gh timeout; the diff fetch does not. */
const GENERATE_TIMEOUT_MS = 120_000
/** Diff budget for the prompt — big PRs are summarised from file lists instead. */
const DIFF_BUDGET = 24_000
/** Guards against a model that will not stop writing. */
const MAX_DESCRIPTION_CHARS = 6_000

async function gh(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const res = await exec('gh', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
    return { ok: true, out: res.stdout, err: res.stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: e.stdout ?? '', err: e.stderr ?? e.message ?? String(err) }
  }
}

interface PrFacts {
  number: number
  title: string
  body: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  headRefOid: string
  additions: number
  deletions: number
  changedFiles: number
  reviewDecision: string | null
  commits: Array<{ messageHeadline: string; messageBody: string }>
  files: Array<{ path: string; additions: number; deletions: number; changeType: string }>
}

/** Repo context that only Revva's own database knows. */
interface LinkedContext {
  ticketKey?: string
  ticketSummary?: string
  gates: Array<{ role: string; status: string }>
}

function contextForPr(prUrl: string): LinkedContext {
  const work = getDb()
    .prepare('SELECT ticket_key FROM work WHERE pr_url = ? LIMIT 1')
    .get(prUrl) as { ticket_key: string } | undefined
  if (!work) return { gates: [] }
  const ticket = getDb().prepare('SELECT summary FROM ticket WHERE key = ?').get(work.ticket_key) as { summary: string } | undefined
  const latest = getDb()
    .prepare('SELECT MAX(round) AS round FROM review WHERE work_id = (SELECT id FROM work WHERE pr_url = ?) AND role != \'fixer\'')
    .get(prUrl) as { round: number | null }
  const gates =
    latest.round == null
      ? []
      : (getDb()
          .prepare(
            "SELECT role, status FROM review WHERE work_id = (SELECT id FROM work WHERE pr_url = ?) AND round = ? AND role != 'fixer' ORDER BY id"
          )
          .all(prUrl, latest.round) as Array<{ role: string; status: string }>)
  return {
    ticketKey: work.ticket_key,
    ticketSummary: ticket?.summary,
    gates
  }
}

/** Long patches are clipped with the omission stated, never silently cut. */
function capDiff(patch: string): string {
  if (patch.length <= DIFF_BUDGET) return patch
  const head = patch.slice(0, DIFF_BUDGET)
  const lastFile = head.lastIndexOf('\ndiff --git ')
  const cut = lastFile > DIFF_BUDGET / 2 ? lastFile : DIFF_BUDGET
  return `${patch.slice(0, cut)}\n\n[… diff truncated by Revva — ${patch.length - cut} characters omitted …]`
}

function fallbackDescription(pr: PrFacts, ctx: LinkedContext): string {
  const lines = [
    '## Summary',
    '',
    ctx.ticketKey ? `${ctx.ticketKey}: ${ctx.ticketSummary ?? pr.title}` : pr.title,
    '',
    '## Changes',
    ...(pr.commits.length ? pr.commits.map((c) => `- ${c.messageHeadline}`) : [`- ${pr.changedFiles} file(s) changed on ${pr.headRefName}.`]),
    ...(ctx.gates.length
      ? ['', '## Review gates', ...ctx.gates.map((g) => `- **${g.role}**: ${g.status}`)]
      : [])
  ]
  return lines.join('\n')
}

function generationPrompt(pr: PrFacts, prUrl: string, ctx: LinkedContext, diff: string, instructions?: string): string {
  const facts = [
    `Repository pull request: #${pr.number} on branch ${pr.headRefName} → ${pr.baseRefName}${pr.isDraft ? ' (draft)' : ''}.`,
    `Title: ${pr.title}`,
    `Size: ${pr.changedFiles} changed files, +${pr.additions}/-${pr.deletions}.`,
    `Current description:\n${pr.body.trim() || '(empty)'}`,
    ...(ctx.ticketKey ? [`Jira ticket: ${ctx.ticketKey}${ctx.ticketSummary ? ` — ${ctx.ticketSummary}` : ''}`] : []),
    ...(ctx.gates.length ? [`Revva review gates: ${ctx.gates.map((g) => `${g.role}=${g.status}`).join(', ')}`] : [])
  ]
  const commits = pr.commits.length
    ? pr.commits.map((c) => (c.messageBody.trim() ? `- ${c.messageHeadline}\n  ${c.messageBody.trim().split('\n').slice(0, 3).join('\n  ')}` : `- ${c.messageHeadline}`))
    : ['- (no commits reported)']
  const files = pr.files.map((f) => `- ${f.changeType} ${f.path} (+${f.additions}/-${f.deletions})`)
  const template = settingGet<string>('prompt.description') || DEFAULT_PR_DESCRIPTION_PROMPT
  return [
    renderPrompt(template, {
      prUrl,
      prNumber: String(pr.number),
      repo: parsePrRef(prUrl)?.repo ?? '',
      title: pr.title,
      base: pr.baseRefName,
      head: pr.headRefName,
      ticketKey: ctx.ticketKey ?? '',
      summary: ctx.ticketSummary ?? ''
    }),
    '',
    ...facts,
    '',
    '--- Commits ---',
    ...commits,
    '--- End commits ---',
    '',
    '--- Changed files ---',
    ...files,
    '--- End changed files ---',
    '',
    '--- Diff ---',
    diff || '(no readable patch — describe from commits and file names only)',
    '--- End diff ---',
    ...(instructions?.trim()
      ? ['', '--- Extra instructions from the user (honour them) ---', instructions.trim(), '--- End extra instructions ---']
      : [])
  ].join('\n')
}

class PrDescriptionWriter {
  /** Read the PR, ask the model for a fresh section, keep the user's own text around it. */
  async describe(prUrl: string, instructions?: string): Promise<PrDescriptionDraft> {
    const view = await gh([
      'pr', 'view', prUrl,
      '--json', 'number,title,body,state,isDraft,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,reviewDecision,commits,files'
    ])
    if (!view.ok) throw new Error(`Could not read PR: ${(view.err || view.out).trim().split('\n')[0] ?? 'gh failed'}`)
    const pr = JSON.parse(view.out) as PrFacts
    const ctx = contextForPr(prUrl)

    const patch = await gh(['pr', 'diff', prUrl])
    const diff = patch.ok ? capDiff(patch.out) : ''

    const sel = roleConfigGet('prDescription')
    let generated = ''
    let note: string | undefined
    let source: PrDescriptionDraft['source'] = 'ai'
    if (!openCodeService.connected) {
      source = 'template'
      note = 'OpenCode is not connected, so this is the plain commit list.'
    } else {
      // One-shot generation the way the reviewer sessions work: throwaway session,
      // prompt, wait for completion on the event bus, read the final assistant
      // message. (Session-less generate/text is experimental and absent from the
      // service many installs still run — it 404s; session.generate can come back
      // empty when the model spends its turn on tool calls.)
      let sessionId: string | undefined
      try {
        const api = openCodeService.api
        const session = await api.session.create({
          title: `PR #${pr.number} · description`,
          model: sel?.model ? { id: sel.model.id, providerID: sel.model.providerID } : null,
          metadata: { revva: { kind: 'pr-description', prUrl } }
        })
        sessionId = session.id
        // Subscribe before prompting: the bus is live-only and a fast model could finish first.
        const { done, cancel } = this.completionWait(session.id)
        try {
          await api.session.prompt({ sessionID: session.id, text: generationPrompt(pr, prUrl, ctx, diff, instructions) })
          if (!await done) throw new Error(`the model did not finish within ${GENERATE_TIMEOUT_MS / 1000}s`)
        } finally {
          cancel()
        }
        const messages = await api.message.list({ sessionID: session.id, order: 'desc', limit: 200 })
        const lastAssistant = messages.data.find((m) => m.type === 'assistant')
        for (const part of (lastAssistant as { content?: unknown[] })?.content ?? []) {
          const p = part as Record<string, unknown>
          if (p.type === 'text' && typeof p.text === 'string') generated += p.text
        }
        generated = stripRevvaMarkers(unwrapMarkdownFence(generated)).slice(0, MAX_DESCRIPTION_CHARS).trim()
        if (!generated) throw new Error('the model returned no text')
      } catch (err) {
        source = 'template'
        const reason = err instanceof Error ? err.message : String(err)
        note = `The model could not write it (${reason.slice(0, 200)}), so this is the plain commit list.`
      } finally {
        if (sessionId) await openCodeService.api.session.remove({ sessionID: sessionId }).catch(() => undefined)
      }
    }

    return {
      original: pr.body,
      proposed: mergeRevvaSection(pr.body, generated || fallbackDescription(pr, ctx)),
      head: pr.headRefOid,
      source,
      note,
      model: sel?.model ? `${sel.model.providerID}/${sel.model.id}` : undefined,
      ticketKey: ctx.ticketKey
    }
  }

  /**
   * Wait for this session's run to end: resolves true on a terminal execution
   * event, false on timeout. The bus is live-only, so subscribe before the
   * prompt runs; cancel() unregisters early when the prompt itself failed.
   */
  private completionWait(sessionId: string): { done: Promise<boolean>; cancel: () => void } {
    let finish!: (finished: boolean) => void
    const done = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    const timer = setTimeout(() => finish(false), GENERATE_TIMEOUT_MS)
    const onEvent = (e: RawEvent): void => {
      const data = (e.data ?? {}) as Record<string, unknown>
      if (data.sessionID !== sessionId) return
      if (e.type === 'session.execution.succeeded' || e.type === 'session.execution.failed' || e.type === 'session.execution.interrupted') finish(true)
    }
    eventBus.on('event', onEvent)
    const cancel = (): void => {
      clearTimeout(timer)
      eventBus.off('event', onEvent)
    }
    return { done, cancel }
  }

  /** Save only when the body and head are still what the draft was built from. */
  async save(prUrl: string, original: string, head: string, body: string): Promise<void> {
    if (!body.trim()) throw new Error('The PR description cannot be empty.')
    const current = await gh(['pr', 'view', prUrl, '--json', 'body,headRefOid'])
    if (!current.ok) throw new Error(`Could not read PR: ${(current.err || current.out).slice(0, 400)}`)
    const data = JSON.parse(current.out) as { body?: string | null; headRefOid?: string }
    if ((data.body ?? '') !== original || data.headRefOid !== head) {
      throw new Error('The PR description or head changed since this draft was written. Close and reopen the dialog to refresh it.')
    }
    const result = await gh(['pr', 'edit', prUrl, '--body', body])
    if (!result.ok) throw new Error(`Could not update PR description: ${(result.err || result.out).slice(0, 400)}`)
    const work = getDb().prepare('SELECT id FROM work WHERE pr_url = ?').get(prUrl) as { id: string } | undefined
    if (work) {
      getDb()
        .prepare('INSERT INTO auto_decision(work_id, round, kind, detail, created_at) VALUES(?,?,?,?,?)')
        .run(work.id, null, 'pr-description-updated', prUrl, Date.now())
    }
  }
}

export const prDescriptionWriter = new PrDescriptionWriter()
