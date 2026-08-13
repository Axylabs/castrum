// src/ingress/body.ts — Streaming request-body reading for the async ingress
// API.

const EMPTY_BODY = new Uint8Array(0)

/** Read the request body once, enforcing the size guard when enabled. */
export function readRequestBodyOnce(
  req: Request,
  maxBytes: number,
  guard: boolean,
  timeoutMs?: number,
): Promise<Uint8Array> {
  if (req.body === null) {
    return Promise.resolve(EMPTY_BODY)
  }

  return readBodyWithLimit(req, maxBytes, guard, timeoutMs)
}

function bodyTooLargeError(): Error & { code?: string } {
  const err = new Error('BODY_TOO_LARGE') as Error & { code?: string }
  err.code = 'BODY_TOO_LARGE'
  return err
}

/**
 * Stream-read the request body, enforcing the size guard when enabled and an
 * optional overall deadline.
 *
 * Errors carry `err.code`:
 * - `BODY_TOO_LARGE` when `guard` is on and the body exceeds `maxBytes`
 *   (thrown as soon as the limit is crossed — the body is never fully
 *   buffered first, which is the slowloris/large-body protection).
 * - `REQUEST_TIMEOUT` when `timeoutMs` elapses before the body completes.
 */
export async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
  guard: boolean,
  timeoutMs?: number,
): Promise<Uint8Array> {
  const body = req.body

  if (!body) {
    return EMPTY_BODY
  }

  const deadline = timeoutMs && timeoutMs > 0 ? timeoutMs : 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    if (deadline <= 0) return
    timer = setTimeout(() => reject(timeoutError()), deadline)
    // Don't let a pending body timeout keep the event loop alive once the
    // request has otherwise completed (Node; a no-op under Bun).
    timer.unref?.()
  })

  // Fast path: a declared Content-Length lets us PROVE the body fits the
  // guard before reading, so one native `arrayBuffer()` read replaces the
  // reader + per-chunk `Promise.race` + `concatUint8Arrays` churn (the bench
  // POSTs are single-shot bodies — this removes ~4-6 allocations per write
  // request). The deadline (when set) is still enforced with a single race,
  // not one per chunk. `req.arrayBuffer()` is bounded by the server's
  // `maxRequestBodySize`, and the post-read length re-check catches a client
  // that lies about Content-Length.
  const declared = req.headers.get('content-length')
  if (declared !== null) {
    const declaredLen = Number(declared)
    if (Number.isFinite(declaredLen)) {
      if (guard && declaredLen > maxBytes) {
        throw bodyTooLargeError()
      }
      try {
        const buf =
          deadline > 0 ? await Promise.race([req.arrayBuffer(), timeout]) : await req.arrayBuffer()
        const bytes = new Uint8Array(buf)
        if (guard && bytes.byteLength > maxBytes) {
          throw bodyTooLargeError()
        }
        return bytes
      } finally {
        clearTimeout(timer)
      }
    }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  // True when the stream was fully read to `done` — on that path the reader is
  // already closed, so the `cancel()` in `finally` is a wasted async round-trip
  // per request. It is still required when the loop exits early (timeout/error).
  let completed = false

  try {
    for (;;) {
      const { done, value } =
        deadline > 0 ? await Promise.race([reader.read(), timeout]) : await reader.read()

      if (done) {
        completed = true
        break
      }
      if (!value) continue

      total += value.byteLength

      if (guard && total > maxBytes) {
        throw bodyTooLargeError()
      }

      chunks.push(value)
    }
  } finally {
    clearTimeout(timer)
    // Release the underlying stream. Cancelling while a read() is still
    // pending (the timeout case) can resolve that pending read() as `done`
    // and RACE the timeout rejection — so reject first, cancel only AFTER
    // the loop has settled. The `.catch` keeps the cancel from masking a
    // thrown REQUEST_TIMEOUT / BODY_TOO_LARGE. On the normal `done` path the
    // stream is already closed, so skip the cancel entirely.
    if (!completed) {
      await reader.cancel().catch(() => {})
    }
  }

  return concatUint8Arrays(chunks, total)
}

function timeoutError(): Error & { code?: string } {
  const err = new Error('REQUEST_TIMEOUT') as Error & { code?: string }
  err.code = 'REQUEST_TIMEOUT'
  return err
}

function concatUint8Arrays(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 0) return EMPTY_BODY
  if (chunks.length === 1) return chunks[0] ?? EMPTY_BODY

  const out = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }

  return out
}
