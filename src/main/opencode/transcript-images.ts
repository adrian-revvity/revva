/** Image bytes never travel with transcript IPC. Browser loads only visible images. */
import { protocol } from 'electron'
import { openCodeService } from './service'
import { sessionIndex } from './session-index'

const SCHEME = 'revva-image'
const MAX_BYTES = 32 * 1024 * 1024
const images = new Map<string, { mime: string; bytes: Buffer }>()
const loading = new Map<string, Promise<{ mime: string; bytes: Buffer } | undefined>>()
let cachedBytes = 0

export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

function remember(url: string, mime: string, data: string): void {
  if (images.has(url)) return
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > MAX_BYTES) return
  while (cachedBytes + bytes.length > MAX_BYTES && images.size) {
    const oldest = images.keys().next().value!
    cachedBytes -= images.get(oldest)!.bytes.length
    images.delete(oldest)
  }
  images.set(url, { mime, bytes })
  cachedBytes += bytes.length
}

export function transcriptImage(sessionId: string, messageId: string, index: number, mime: string, data: string): string {
  const url = `${SCHEME}://attachment/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/${index}`
  remember(url, mime, data)
  return url
}

export function handleTranscriptImages(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const [sessionId, messageId, rawIndex] = url.pathname.slice(1).split('/').map(decodeURIComponent)
    const index = Number(rawIndex)
    if (url.hostname !== 'attachment' || !sessionId || !sessionIndex.kindOf(sessionId) || !messageId || !rawIndex || !Number.isInteger(index) || index < 0) {
      return new Response(null, { status: 404 })
    }
    let image = images.get(request.url)
    if (image) {
      // LRU: scrolling back to an image keeps it warm.
      images.delete(request.url)
      images.set(request.url, image)
    } else {
      let pending = loading.get(request.url)
      if (!pending) {
        pending = (async () => {
          const message = await openCodeService.api.session.message.get({ sessionID: sessionId, messageID: messageId })
          const file = message.type === 'user' ? message.files?.[index] : undefined
          if (!file?.data || !/^image\/(png|jpeg|gif|webp)$/.test(file.mime)) return undefined
          remember(request.url, file.mime, file.data)
          return { mime: file.mime, bytes: Buffer.from(file.data, 'base64') }
        })()
        loading.set(request.url, pending)
      }
      try { image = await pending } catch { return new Response(null, { status: 404 }) }
      finally { loading.delete(request.url) }
    }
    if (!image || !/^image\/(png|jpeg|gif|webp)$/.test(image.mime)) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(image.bytes), {
      headers: { 'Content-Type': image.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }
    })
  })
}
