/**
 * Composer token → OpenCode prompt attachments. The renderer tokenizes the
 * message text and reports byte offsets; we pass them through as `mention` so
 * OpenCode links each `/skill` and `@file` token to its attachment.
 */
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import type { PromptRefs } from '@shared/types'

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s)

export function skillAttachments(refs: PromptRefs): Array<{ id: string; mention: { start: number; end: number; text: string } }> {
  return refs.skills.map((s) => ({ id: s.id, mention: { start: s.start, end: s.end, text: clip(s.text, 300) } }))
}

/** @file refs become file:// attachments rooted at the session's working directory. */
export function fileAttachments(refs: PromptRefs, directory: string): Array<{ uri: string; name: string; mention: { start: number; end: number; text: string } }> {
  return refs.files
    .map((f) => {
      const abs = f.path.startsWith('/') ? f.path : join(directory, f.path)
      return { f, abs }
    })
    // Typing is unvalidated: an email or a typo must not fail the whole prompt.
    .filter(({ abs }) => existsSync(abs))
    .map(({ f, abs }) => ({
      uri: `file://${encodeURI(abs).replace(/#/g, '%23').replace(/\?/g, '%3F')}`,
      name: basename(abs),
      mention: { start: f.start, end: f.end, text: clip(f.text, 300) }
    }))
}
