// src/ingress/routes/json-write.ts — Pre-baked JSON-write handler
// (POST/PUT/PATCH).

import { decodeUtf8 } from '../../shared/codec'
import { abortResponse, isAbortError } from '../abort'
import { readBodyWithLimit } from '../body'
import { DEFAULT_BODY_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES } from '../shared'
import type { OptimizedIngressHandler } from '../types'
import { type BakedHandlerOptions, buildSuccessInit, resolveIp } from './common'

/**
 * Pure JSON-validity fallback used ONLY for hand-rolled
 * `OptimizedIngressHandler` mocks that carry no native `jsonValid` capability.
 * Real handlers from `createIngressHandler` always provide the zero-DOM native
 * check (`ingress.jsonValid`), so this never runs on the hot path — it exists
 * to keep the security property (invalid JSON must be rejected) for mocks.
 */
function defaultJsonValid(bytes: Uint8Array): boolean {
  try {
    JSON.parse(decodeUtf8(bytes))
    return true
  } catch {
    return false
  }
}

/**
 * Whether a `Content-Type` header denotes JSON: the media type (the part before
 * any parameters) is exactly `application/json`, or a `+json` structured suffix
 * (e.g. `application/vnd.api+json`). A plain substring test would wrongly
 * accept `text/plain; application/json`.
 */
function isJsonContentType(contentType: string): boolean {
  const semi = contentType.indexOf(';')
  const mediaType = (semi >= 0 ? contentType.slice(0, semi) : contentType).trim().toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

/**
 * Pre-baked JSON-write handler (POST/PUT/PATCH): enforces Content-Type,
 * content-length/body-size limits, JSON validity and (optionally) schema
 * validation, then returns the ingress body JSON on success.
 */
export function jsonWriteHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Promise<Response> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const fallback = opts.fallback ?? ingress
  const copyBody = opts.copyBody !== false
  // Non-zero default: protect against slowloris / trickling bodies. Set
  // `bodyTimeoutMs: 0` to disable.
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS
  // JSON-validity check via DI across the purity boundary: an explicit option
  // wins, otherwise the handler's own native capability (from
  // `createIngressHandler`), otherwise the pure mock fallback.
  const jsonValid = opts.jsonValid ?? ingress.jsonValid ?? defaultJsonValid

  return async (req, srv) => {
    const ip = resolveIp(req, srv, opts)

    // Client already gone: do no work (no content-type check, no body read,
    // no native run). A disconnect DURING the body read is handled below.
    if (req.signal?.aborted) return abortResponse()

    const contentType = req.headers.get('content-type') ?? ''
    if (!isJsonContentType(contentType)) {
      // Always 415 for an unsupported media type. Do NOT short-circuit on the
      // native terminal first: running with no body yields a "body required"
      // 400, which previously masked the 415 (the native pipeline still applied
      // rate limiting / CORS headers to this run).
      return fallback.run(req, ip, null, (result, ctx) =>
        fallback.errorResponse(
          req,
          result,
          415,
          'unsupported_media_type',
          'Content-Type must be application/json',
          ctx,
        ),
      )
    }

    // Content-Length / body-size enforcement happens INSIDE readBodyWithLimit
    // (guard on): the declared length is checked before reading and re-checked
    // after, so a client lying about Content-Length still gets a 413. Not
    // re-reading the header here saves a per-POST headers.get on the hot path.
    let bodyBytes: Uint8Array
    try {
      // Stream-read with the limit enforced WHILE reading — a body that
      // exceeds maxBodyBytes is rejected as soon as the limit is crossed,
      // never fully buffered first.
      bodyBytes = await readBodyWithLimit(req, maxBodyBytes, true, bodyTimeoutMs)
    } catch (err) {
      // Client disconnect is NOT a bad request / timeout: return the cancelled
      // response without running the native pipeline.
      if (isAbortError(err)) return abortResponse()
      const code = (err as { code?: string } | null)?.code
      const isTooLarge = code === 'BODY_TOO_LARGE'
      return fallback.run(req, ip, null, (result, ctx) => {
        const terminal = fallback.terminalResponse(req, result, ctx)
        if (terminal) return terminal

        return fallback.errorResponse(
          req,
          result,
          isTooLarge ? 413 : 408,
          isTooLarge ? 'body_too_large' : 'request_timeout',
          isTooLarge ? 'Request body is too large' : 'Request body read timed out',
          ctx,
        )
      })
    }

    // The client may have disconnected while the body was streaming in.
    if (req.signal?.aborted) return abortResponse()

    return ingress.run(req, ip, bodyBytes, (result, ctx) => {
      const terminal = ingress.terminalResponse(req, result, ctx)
      if (terminal) return terminal

      if (result.bodyTruncated) {
        return ingress.internalErrorResponse(ctx, result)
      }

      // `bodyValidJson`/`schemaValid` are only computed when the pipeline ran
      // JSON validation — i.e. when `requireJsonBody` is set or a `schema` is
      // configured on the ingress. When `bodyValidJson` is false here,
      // validation was skipped entirely (a genuine validation failure already
      // short-circuits as a terminal 400 above). In that case enforce validity
      // with the same zero-DOM native check, and schema validation trivially
      // passes because no schema was configured (had one been, the pipeline
      // would have run and set the flags).
      if (result.bodyValidJson) {
        if (!result.schemaValid) {
          return ingress.errorResponse(
            req,
            result,
            422,
            'schema_validation_failed',
            'Request body failed schema validation',
            ctx,
          )
        }
      } else if (!jsonValid(bodyBytes)) {
        return ingress.errorResponse(req, result, 400, 'invalid_json', 'Invalid JSON body', ctx)
      }

      const init = buildSuccessInit(ingress, result, ctx)

      return copyBody
        ? new Response(result.bodyJson(true), init)
        : ingress.zeroCopyResponse(result, ctx, init)
    })
  }
}
