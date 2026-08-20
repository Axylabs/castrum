// src/ingress/sync.ts — Sync + async convenience factories (path 1 wrappers)
//
// `createIngressSync` and `createIngress` wrap `createIngressFast` (path 1)
// with the synchronous-callback guard / automatic body reading + error
// contexts. Kept OUT of index.ts so the public barrel stays a pure re-export
// hub. Runtime/server selection lives in src/runtime/server.ts — NOT here.

import { decoder } from '../shared/bytes'
import { generateRequestId } from '../shared/request-id'
import { readRequestBodyOnce } from './body'
import { ERR_CODE_BODY_TOO_LARGE, ERR_CODE_REQUEST_TIMEOUT } from './constants'
import { internalContext, snapshotResult, syntheticContext } from './context'
import { createIngressFast } from './fast'
import { buildResponseContext } from './headers/fast-templates'
import { buildTerminalResponse } from './response/terminal'
import { assertSyncCallback, DEFAULT_BODY_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES } from './shared'
import type { IngressContext, IngressHandler, IngressOptions, SyncIngressHandler } from './types'

/**
 * Synchronous convenience wrapper over `createIngressFast` (path 1).
 *
 * The callback runs on the fast-path result and MUST be synchronous. Use
 * {@link createIngress} when you want automatic body reading + error contexts.
 *
 * @param options fast-path ingress options
 * @returns a sync handler (callback must be synchronous)
 */
export function createIngressSync(options: IngressOptions = {}): SyncIngressHandler {
  const fast = createIngressFast(options)

  return {
    run(req, ip, body, requestId, fn) {
      return fast.run(req, ip, body, requestId, (result) => {
        const out = fn(result)
        assertSyncCallback(out, 'createIngressSync().run()')
        return out
      })
    },
  }
}

/**
 * Return a copy of `options` without the security-header keys.
 *
 * `createIngress` applies security headers itself (via `buildResponseContext`),
 * so they must not be forwarded to the underlying fast handler, which rejects
 * them (see `createIngressFast`).
 */
function stripSecurityOptions(options: IngressOptions): IngressOptions {
  const copy = { ...options }
  delete copy.security
  delete copy.enableSecurityHeaders
  return copy
}

/**
 * Async ingress factory: reads the request body (size guard + deadline) and
 * returns a snapshot `IngressContext` with a terminal `Response`.
 *
 * Recommended default for serverless/edge-style `fetch` handlers. For maximum
 * throughput use `createIngressFast` / `createIngressSync` directly.
 *
 * @param options fast-path ingress options (security applied here, not forwarded)
 * @returns an async handler returning a snapshot context
 */
export function createIngress(options: IngressOptions = {}): IngressHandler {
  const sync = createIngressSync(stripSecurityOptions(options))

  const guard = options.enableBodySizeGuard !== false
  const max = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS

  const wantsBody =
    options.readBody === true ||
    options.requireJsonBody === true ||
    options.schema != null ||
    (options.readBody !== false && guard)

  const responseCtx = buildResponseContext(options)

  return async function ingressAsync(req: Request, ip?: string): Promise<IngressContext> {
    const requestId = options.enableRequestIds === false ? '' : decoder.decode(generateRequestId())
    options.onRequest?.(req, requestId, ip)

    // Every terminal outcome (success, 413, 408, 500) flows through here so a
    // hook consumer sees exactly one onResponse per request.
    const emitResponse = (context: IngressContext): IngressContext => {
      options.onResponse?.(req, context, context.status, requestId)
      return context
    }

    try {
      if (guard) {
        const rawLen = req.headers.get('content-length')
        const contentLength = Number(rawLen ?? '0')

        if (Number.isFinite(contentLength) && contentLength > max) {
          return emitResponse(
            syntheticContext(req, requestId, options, responseCtx, 413, ERR_CODE_BODY_TOO_LARGE),
          )
        }
      }

      let body: Uint8Array | null = null

      if (wantsBody && req.body !== null) {
        try {
          body = await readRequestBodyOnce(req, max, guard, bodyTimeoutMs)
        } catch (err) {
          const code = (err as { code?: string } | null)?.code

          if (code === 'BODY_TOO_LARGE') {
            return emitResponse(
              syntheticContext(req, requestId, options, responseCtx, 413, ERR_CODE_BODY_TOO_LARGE),
            )
          }

          if (code === 'REQUEST_TIMEOUT') {
            // Match the pre-baked route factories: a body-read deadline is a
            // 408, not a 500 (was silently swallowed as 500 before).
            return emitResponse(
              syntheticContext(req, requestId, options, responseCtx, 408, ERR_CODE_REQUEST_TIMEOUT),
            )
          }

          // Unknown body-read failure: surface to onError, then fall through
          // to the internal-error context below.
          options.onError?.(err instanceof Error ? err : new Error(String(err)))
          throw err
        }
      }

      return emitResponse(
        sync.run(req, ip, body, requestId, (r) => {
          const snapshot = snapshotResult(r)
          const response = buildTerminalResponse(responseCtx, snapshot, req, requestId)

          return {
            ...snapshot,
            response,
          }
        }),
      )
    } catch (err) {
      // Native/other failures: never silent — report to onError and emit a
      // structured 500 context so the request still completes observably.
      options.onError?.(err instanceof Error ? err : new Error(String(err)))
      return emitResponse(internalContext(req, requestId, options, responseCtx))
    }
  }
}
