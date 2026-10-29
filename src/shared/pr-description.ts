/**
 * The Revva-owned block inside a PR body. Everything outside the markers belongs
 * to the user (or another tool) and is preserved verbatim when Revva updates the
 * description. Dependency-free: both the ship pipeline and the AI writer use it.
 */

export const REVVA_DESC_START = '<!-- revva:description:start -->'
export const REVVA_DESC_END = '<!-- revva:description:end -->'

/** Replace (or append) Revva's section; text outside it is kept untouched. */
export function mergeRevvaSection(body: string, generated: string): string {
  const first = body.indexOf(REVVA_DESC_START)
  const last = body.indexOf(REVVA_DESC_END)
  if ((first < 0) !== (last < 0) || (first >= 0 && (last < first || body.indexOf(REVVA_DESC_START, first + REVVA_DESC_START.length) >= 0 || body.indexOf(REVVA_DESC_END, last + REVVA_DESC_END.length) >= 0))) {
    throw new Error('The existing Revva description markers are malformed. Fix them on GitHub before updating.')
  }
  const section = [REVVA_DESC_START, generated.trim(), REVVA_DESC_END].join('\n')
  return first >= 0 ? body.slice(0, first) + section + body.slice(last + REVVA_DESC_END.length) : [body.trimEnd(), section].filter(Boolean).join('\n\n')
}

/** Model output must never smuggle our markers in — that would corrupt the next merge. */
export function stripRevvaMarkers(text: string): string {
  return text.replaceAll(REVVA_DESC_START, '').replaceAll(REVVA_DESC_END, '')
}

/** Models love wrapping Markdown in a fence; unwrap a single whole-answer fence. */
export function unwrapMarkdownFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/)
  return (match?.[1] ?? trimmed).trim()
}
