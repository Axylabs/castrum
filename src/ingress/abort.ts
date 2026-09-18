// src/ingress/abort.ts — PURE request-cancellation helpers.
//
// The async ingress reads `Request.signal` (fired when the client disconnects)
// at its genuine async boundaries. A body read or a route wrapper that observes
// an abort returns the cancelled-client response instead of running more work.
// PURE: no addon / pool imports — safe for the route factories.

/**
 * The `err.code` value a body read carries when it is rejected because the
 * client disconnected (`Request.signal` aborted).
 */
export const ABORT_CODE = 'REQUEST_ABORTED'

/**
 * Whether a thrown value is the cancellation error produced when `req.signal`
 * aborts during a body read (see `readBodyWithLimit` in `./body`).
 *
 * @param err - The caught value.
 * @returns `true` when `err.code === 'REQUEST_ABORTED'`.
 * @example
 * ```ts
 * try {
 *   await readBodyWithLimit(req, 1 << 20, true)
 * } catch (err) {
 *   if (isAbortError(err)) return abortResponse()
 *   throw err
 * }
 * ```
 */
export function isAbortError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === ABORT_CODE
}

/**
 * Build the cancelled-client response: status **499** ("Client Closed
 * Request", a de-facto nginx status) with no body. This is the only new
 * outcome added by cancellation — it never replaces an existing success or
 * error status.
 *
 * @returns A bodyless `Response` with status 499.
 * @example
 * ```ts
 * if (req.signal?.aborted) return abortResponse()
 * ```
 */
export function abortResponse(): Response {
  return new Response(null, { status: 499 })
}
