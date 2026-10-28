/**
 * PR references are ambiguous across many GitHub projects, so the rule is:
 * full URL or owner/repo#n are always fine; a bare "#n"/n needs a repo context.
 * Pure helpers shared by main and renderer.
 */

export type PrRef = { repo?: string; number: number; url?: string }

/** Parse "url", "owner/repo#12", "#12", "12". repo/url may stay undefined (needs context). */
export function parsePrRef(raw: string): PrRef | undefined {
  const s = raw.trim()
  if (!s) return undefined
  const url = s.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  if (url) return { repo: url[1], number: Number(url[2]), url: s.startsWith('http') ? s : `https://github.com/${url[1]}/pull/${url[2]}` }
  const slash = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/)
  if (slash) return { repo: slash[1], number: Number(slash[2]) }
  const bare = s.match(/^#?(\d+)$/)
  if (bare) return { number: Number(bare[1]) }
  return undefined
}

/** owner/repo from a git remote URL (ssh or https). */
export function repoFromGitRemote(remoteUrl: string): string | undefined {
  const m = remoteUrl.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return m?.[1]
}

/** Fill a bare-number ref from a repo context; undefined when still ambiguous. */
export function resolvePrRef(ref: PrRef, contextRepo?: string): PrRef | undefined {
  const repo = ref.repo ?? contextRepo
  if (!repo) return undefined
  return {
    repo,
    number: ref.number,
    url: ref.url ?? `https://github.com/${repo}/pull/${ref.number}`
  }
}
