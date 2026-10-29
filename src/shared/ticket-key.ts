/** Extract a single unambiguous Jira key from a PR title or branch. */
export function ticketKeyFromText(...texts: string[]): string | undefined {
  const keys = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(/(?:^|[^a-z0-9])([a-z][a-z0-9]+)-(\d+)(?![a-z0-9])/gi)) {
      keys.add(`${match[1]!.toUpperCase()}-${match[2]!.replace(/^0+(?=\d)/, '')}`)
    }
    for (const match of text.matchAll(/(?:^|[^a-z0-9])(cln)0+(\d{5,})(?![a-z0-9])/gi)) {
      keys.add(`${match[1]!.toUpperCase()}-${match[2]!.replace(/^0+(?=\d)/, '')}`)
    }
  }
  return keys.size === 1 ? [...keys][0] : undefined
}
