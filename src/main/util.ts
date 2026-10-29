/**
 * Small free functions shared by main-process modules that were copy-pasted
 * per module (ADF text walking, last-assistant-text, conflict detection,
 * prompt image mapping). Keep dependencies minimal: no imports from feature
 * modules other than the OpenCode service wrapper.
 */
import { latestAssistantText } from './opencode/transcript-requests'
import type { PromptImage } from '@shared/types'

/** Depth-first collect of ADF/markdown-ish `{text, content}` nodes into plain text. */
export function collectAdfText(node: unknown): string[] {
  const texts: string[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return void n.forEach(walk)
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      if (typeof o.text === 'string') texts.push(o.text)
      if (o.content) walk(o.content)
    }
  }
  walk(node)
  return texts
}

/** Concatenated text parts of a session's last assistant message ('' when none).
 *  Lives here so review + rework share one implementation. */
export async function fetchLastAssistantText(sessionID: string): Promise<string> {
  return latestAssistantText(sessionID, AbortSignal.timeout(30_000))
}

/** The SDK error for "session busy" / conflicts carries status 409. */
export function isConflict(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown } | undefined
  if (e?.status === 409) return true
  const msg = String(e?.message ?? err ?? '')
  return msg.includes('409') || /conflict|busy|already running/i.test(msg)
}

/** Prompt images → OpenCode `files` payloads (data URIs). */
export function promptImageFiles(images: PromptImage[]): { uri: string; name?: string }[] {
  return images.map((img) => {
    const base64 = img.data.startsWith('data:') ? img.data.slice(img.data.indexOf(',') + 1) : img.data
    return { uri: `data:${img.mime};base64,${base64}`, name: img.name }
  })
}
