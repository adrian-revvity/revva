/** AbortSignal stays in the renderer; only generated request IDs cross IPC. */
export async function transcriptRequest<T>(signal: AbortSignal, run: (requestId: string) => Promise<T>): Promise<T> {
  if (signal.aborted) throw signal.reason
  const requestId = crypto.randomUUID()
  const cancel = (): void => { void window.revva.session.cancelRequest(requestId).catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const result = await run(requestId)
    if (signal.aborted) throw signal.reason
    return result
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
