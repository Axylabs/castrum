// src/ingress/fast.ts — High-performance ingress handler (fast packed-input
// path).
//
// Thin factory module. The fast-path pipeline is decomposed into task-focused
// submodules:
//   - packing/header-packing.ts   binary header packing (zero intermediate strings)
//   - packing/input-packer.ts     packed-input buffer builder
//   - decode/fast-result.ts       FastIngressResult (zero-alloc lazy decode)
//   - headers/fast-templates.ts   header-template system
//   - response/terminal.ts        buildTerminalResponse
//   - status.ts / errors.ts / options.ts / shared.ts
//
// This module keeps `createIngressFast` and re-exports the full fast-path API
// so existing importers keep working.

import { getAddon } from '../native'
import { getBunFFI } from '../native/ffi'
import { OUT_DATA_START } from './constants'
import { FastIngressResult } from './decode/fast-result'
import type { IngressFastHandler, IngressFastOptions } from './options'
import {
  assertIngressOptionValues,
  assertKnownIngressOptions,
  warnTrustProxyDeprecated,
} from './options'
import { packHeaders } from './packing/header-packing'
import { IngressInputPacker } from './packing/input-packer'
import {
  assertSyncCallback,
  buildHeaderPlan,
  clampIngressBufferSize,
  DEFAULT_FAST_OUTPUT_BUFFER_SIZE,
  DEFAULT_MAX_BODY_BYTES,
  type HeaderPlan,
  METHOD_KIND,
  METHOD_KIND_UNKNOWN,
} from './shared'

export { generateRequestId } from '../shared/request-id'
export { FastIngressResult } from './decode/fast-result'
export { errorCodeName, errorMessage } from './errors'
export type { CorsOptions, CorsStaticStrings } from './headers/cors'
export type {
  HeaderTemplate,
  ResponseBuildContext,
} from './headers/fast-templates'
export {
  buildResponseContext,
  headersForResult,
} from './headers/fast-templates'
export type { SecurityHeadersOptions } from './headers/hsts'
export type { IngressFastHandler, IngressFastOptions } from './options'
export { buildTerminalResponse } from './response/terminal'
export type { HeaderPlan } from './shared'
export { DEFAULT_MAX_BODY_BYTES, METHOD_KIND } from './shared'
// ── Re-exports (back-compat: preserve fast.ts's original public surface) ──
export {
  isValidResponseStatus,
  normalizeResponseStatus,
  safeTerminalStatus,
  statusForErrorCode,
} from './status'

// ── Local constants ───────────────────────────────────────────
const EMPTY_BODY = new Uint8Array(0)

// ── Fast ingress factory ─────────────────────────────

/**
 * Create a fast packed-input ingress handler (path 1).
 *
 * JS packs the request headers into a binary buffer (`IngressInputPacker`) and
 * the native `Ingress.handleRequestPacked` decodes them. Responses use the
 * `{"error":{...}}` wire format with `x-ratelimit-*` headers.
 *
 * Prefer this when you want the lowest-overhead pipeline and will call `run()`
 * yourself with a **synchronous** callback. For ready-made route handlers and a
 * server builder, use `createIngressHandler` (path 2).
 */
export function createIngressFast(options: IngressFastOptions = {}): IngressFastHandler {
  assertKnownIngressOptions(options)
  assertIngressOptionValues(options)
  if (options.trustProxy === true) {
    warnTrustProxyDeprecated()
  }
  // The raw fast path returns a decoded result, not a Response — it cannot
  // apply security headers. `security`/`enableSecurityHeaders` were previously
  // accepted and silently ignored here (a dead option). Fail loudly instead:
  // use `createIngress` (async) / `createIngressHandler` (pre-baked), or emit
  // the headers yourself via `buildResponseContext` + `headersForResult`.
  if (options.security !== undefined || options.enableSecurityHeaders !== undefined) {
    throw new TypeError(
      'createIngressFast: `security` / `enableSecurityHeaders` are not ' +
        'supported on the raw fast path (it returns a decoded result, not a ' +
        'Response). Use `createIngress` or `createIngressHandler` to apply ' +
        'security headers, or emit them yourself via `buildResponseContext` ' +
        'and `headersForResult`.',
    )
  }

  const rustOptions: Record<string, unknown> = {
    trustProxy: options.trustProxy,
    trustedProxies: options.trustedProxies
      ? {
          enabled: options.trustedProxies.enabled,
          networks: options.trustedProxies.networks,
        }
      : undefined,
    parseCookies: options.parseCookies,
    parseQuery: options.parseQuery,
    requireJsonBody: options.requireJsonBody,
    schema: options.schema,
    cors: options.cors
      ? {
          allowOrigin: options.cors.allowOrigin,
          allowMethods: options.cors.allowMethods,
          allowHeaders: options.cors.allowHeaders,
          exposeHeaders: options.cors.exposeHeaders,
          allowCredentials: options.cors.allowCredentials,
          maxAge: options.cors.maxAge,
        }
      : undefined,
    rateLimit: options.rateLimit
      ? {
          limit: options.rateLimit.limit,
          windowMs: options.rateLimit.windowMs,
          maxEntries: options.rateLimit.maxEntries,
        }
      : undefined,
    https: options.https,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    enableBodySizeGuard: options.enableBodySizeGuard !== false,
    emitMetadataJson: options.emitMetadataJson,
    limits: options.limits
      ? {
          maxUrlBytes: options.limits.maxUrlBytes,
          maxQueryBytes: options.limits.maxQueryBytes,
          maxCookieBytes: options.limits.maxCookieBytes,
          maxHeadersBytes: options.limits.maxHeadersBytes,
          maxHeaders: options.limits.maxHeaders,
          maxPairs: options.limits.maxPairs,
        }
      : undefined,
  }

  // Lazy: the native addon is only needed once a handler is created.
  const addon = getAddon()
  const NativeIngress = addon.Ingress
  const handler = new NativeIngress(rustOptions)

  // Bun fast path: run the native pipeline through `bun:ffi` (opaque inner
  // handle) to cut the per-request N-API crossing. The handle is valid only
  // while `handler` is alive — this closure holds it, so it can never dangle.
  // Falls back to napi when ffi is unavailable / the pointer method is absent.
  const bunFFI = getBunFFI()
  const ingressPtr =
    bunFFI !== null && typeof handler.ingressInnerPtr === 'function'
      ? handler.ingressInnerPtr()
      : 0n

  // Shared with the pre-baked handler path so cookie/cors/proxy/proto
  // extraction decisions can never silently diverge between the two paths.
  const headerPlan: HeaderPlan = buildHeaderPlan(options)

  const outputBufSize = clampIngressBufferSize(
    options.outputBufferSize ?? DEFAULT_FAST_OUTPUT_BUFFER_SIZE,
    OUT_DATA_START,
  )
  const outputBuf = new Uint8Array(outputBufSize)
  const inputPacker = new IngressInputPacker()
  const result = new FastIngressResult()

  return {
    run(req, ip, body, requestId, fn) {
      try {
        const methodKind = METHOD_KIND[req.method] ?? METHOD_KIND_UNKNOWN

        const headers = packHeaders(req, headerPlan)

        const input = inputPacker.packFromStrings(methodKind, req.url, ip, requestId, headers)

        // handleRequestPacked returns the number of bytes it wrote; decode only
        // the written prefix (mirrors handlers.ts) so stale bytes past `written`
        // in the reused buffer can never be misread. Under Bun with a live ffi
        // handle this runs the pipeline through `bun:ffi` instead of napi.
        const written =
          bunFFI !== null && ingressPtr !== 0n
            ? bunFFI.ingressHandlePacked(ingressPtr, input, body, outputBuf)
            : handler.handleRequestPacked(input, body, outputBuf)
        result.refresh(outputBuf.subarray(0, written), body ?? EMPTY_BODY, requestId)
      } catch (err) {
        result.setInternalError(requestId)
        if (options.onError) {
          try {
            options.onError(err instanceof Error ? err : new Error(String(err)))
          } catch {
            // hook must never crash the handler
          }
        }
      }

      try {
        const out = fn(result)
        assertSyncCallback(out, 'createIngressFast().run()')
        return out
      } finally {
        result.invalidate()
      }
    },
  }
}
