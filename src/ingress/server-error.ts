// src/ingress/server-error.ts — request-handler fault containment.
//
// User-supplied route handlers (a raw `spec.read`, a `responder`, a `native`
// responder) run OUTSIDE the native pipeline. On Bun a sync throw / async
// rejection would otherwise escape to Bun's default handler (which is not
// castrum-controlled and may surface stack/internal detail); on Node it hit a
// local generic-500 construction. This module provides ONE masked-500 responder
// shared by both runtimes plus a guard that contains sync throws and async
// rejections. The response body is the pre-encoded internal error body — the
// thrown message/stack is NEVER placed on the wire (info-leak rule).

import { memoizedHeaders } from './headers/memoized-headers'
import { ERROR_BODIES } from './response/error-bodies'
import type { RouteHandler } from './server'

/** Options for {@link createServerErrorHandler}. */
export interface ServerErrorOptions {
  /**
   * Observability hook for an escaped handler error. Receives the real `Error`
   * (unmasked — server-side only). Never throws: a failing hook is swallowed so
   * it cannot break the masked response.
   */
  onError?: (info: { error: Error; request?: Request }) => void
  /**
   * Structured-log sink: one JSON line per escaped error (message only, no
   * stack, no response leak). Never throws.
   */
  logger?: (line: string) => void
}

/** Coerce an unknown thrown value to an `Error` for the hook/logger. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

const INTERNAL_HEADERS: readonly [string, string][] = [
  ['content-type', 'application/json; charset=utf-8'],
]

/**
 * Build a masked-500 responder. The returned function never throws, always
 * answers with the pre-encoded internal error body, and runs the optional
 * `onError`/`logger` hooks in a contained way.
 *
 * @param opts - Optional observability hooks.
 * @returns A `(error, req?) => Response` responder for escaped handler errors.
 * @example
 * ```ts
 * const onServerError = createServerErrorHandler({ onError: console.error })
 * onServerError(new Error('boom')) // Response(500)
 * ```
 */
export function createServerErrorHandler(
  opts: ServerErrorOptions,
): (error: unknown, req?: Request) => Response {
  const headers = memoizedHeaders(INTERNAL_HEADERS)
  return (error, req) => {
    const err = toError(error)
    if (opts.onError) {
      try {
        opts.onError({ error: err, request: req })
      } catch {
        // Observability must never break the response.
      }
    }
    if (opts.logger) {
      try {
        opts.logger(
          JSON.stringify({
            level: 'error',
            msg: 'unhandled_handler_error',
            error: err.message,
          }),
        )
      } catch {
        // Logging must never break the response.
      }
    }
    return new Response(ERROR_BODIES.internal, { status: 500, headers })
  }
}

/**
 * Wrap a route handler so a sync throw or an async rejection is contained and
 * turned into the shared masked 500. The success path is passed through
 * unchanged.
 *
 * @param handler - The route handler to guard.
 * @param onServerError - The masked-500 responder (see
 *   {@link createServerErrorHandler}).
 * @returns A `RouteHandler` with the same signature and success semantics.
 */
export function guardRouteHandler(
  handler: RouteHandler,
  onServerError: (error: unknown, req?: Request) => Response,
): RouteHandler {
  return (req, srv, params) => {
    try {
      const out = handler(req, srv, params)
      // Duck-type thenables (cross-realm Promises/custom thenables fail
      // `instanceof Promise`). A `Response` never exposes `then`.
      const thenable = out as Promise<Response> | null | undefined
      if (thenable !== null && thenable !== undefined && typeof thenable.then === 'function') {
        return thenable.catch((e) => onServerError(e, req))
      }
      return out
    } catch (e) {
      return onServerError(e, req)
    }
  }
}
