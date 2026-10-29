/**
 * Repo workflow skills (e.g. a checked-in `.claude/skills/jiraWork`) gate
 * themselves on plugins the OpenCode service cannot enable, and the agent
 * activates them the moment it sees a Jira key or PR number in a prompt. Revva
 * owns those workflows itself, so every Revva-created session hard-denies the
 * skills the repository ships — skills whose SKILL.md lives inside the
 * session's directory. Global/user skills stay usable (the reviewer roles
 * deliberately use them), and the OpenCode TUI outside Revva is untouched.
 *
 * `session.create` permissions outrank the service default `{*,*,allow}` and
 * hold even when the model activates the skill itself (verified against the
 * running service: a denied activation is silently dropped while an
 * unmentioned sibling still activates). The ruleset is fixed when the session
 * is created, so attaching a denied repo skill mid-conversation stays blocked
 * in Revva — run it outside Revva, e.g. the OpenCode TUI. Discovery failures
 * fall back to the last good listing and then to no rules — a flaky service
 * must never lock agents out; the prompt-side WORKFLOW_SKILL_GUARD remains as
 * guidance either way.
 */
import { realpathSync } from 'node:fs'
import { openCodeService } from './service'

export type SkillGuardRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }

const TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; rules: SkillGuardRule[] }>()

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

async function rulesFor(dir: string): Promise<SkillGuardRule[]> {
  const res = await openCodeService.api.skill.list({ location: { directory: dir } })
  const root = real(dir).replace(/\/+$/, '') + '/'
  return res.data
    .filter((s) => real(s.path).startsWith(root))
    .map((s) => ({ action: 'skill', resource: s.id, effect: 'deny' as const }))
}

/** Deny rules for the skills this repository ships; empty when none or unknown. */
export async function skillGuardRules(directory: string): Promise<SkillGuardRule[]> {
  const hit = cache.get(directory)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rules
  let rules: SkillGuardRule[] = []
  try {
    rules = await rulesFor(directory)
  } catch {
    if (hit) rules = hit.rules // stale-but-better-than-nothing
  }
  cache.set(directory, { at: Date.now(), rules })
  return rules
}
