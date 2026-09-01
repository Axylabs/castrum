// src/ingress/options.ts — IngressFast option types + fail-fast validation.
//
// Options are forwarded to the native addon as a plain object; a misspelled
// key would otherwise be silently ignored. Validation against the known key
// set makes misconfiguration fail loudly at construction time.

/** Options accepted by `createIngressFast` / `createIngress`. */
export interface IngressFastOptions {
  trustProxy?: boolean
  trustedProxies?: { enabled?: boolean; networks?: string[] }
  parseCookies?: boolean
  parseQuery?: boolean
  requireJsonBody?: boolean
  schema?: Uint8Array
  cors?: CorsOptions
  rateLimit?: { limit?: number; windowMs?: number; maxEntries?: number }
  /**
   * Structured security-header options (CSP/HSTS) — honored by the fast/async
   * paths (`createIngressFast` throws on it; `createIngress` applies it via
   * `buildResponseContext`). The PRE-BAKED path (`createIngressHandler`)
   * instead takes raw `securityHeaders: [name, value][]` pairs. The two paths
   * intentionally use different option shapes (see docs/INGRESS.md).
   */
  security?: SecurityHeadersOptions
  https?: boolean
  maxBodyBytes?: number
  enableSecurityHeaders?: boolean
  enableRequestIds?: boolean
  enableBodySizeGuard?: boolean
  emitMetadataJson?: boolean
  readBody?: boolean
  outputBufferSize?: number
  /**
   * Overall deadline (ms) for reading a request body in the async
   * `createIngress` path. 0 disables. Default: `DEFAULT_BODY_TIMEOUT_MS` (30s).
   * Ignored by the sync `createIngressFast` (it does not read bodies).
   */
  bodyTimeoutMs?: number
  /**
   * Invoked when the native pipeline throws (the request becomes a 500).
   * Native failures are otherwise silent in the fast path. Never throws.
   */
  onError?: (error: Error) => void
  /**
   * When true, run one probe GET at construction so the `run()` closure,
   * packed pipeline and FFI ingress call are JIT-warmed before the first real
   * request (cuts cold-invocation tail latency in serverless-style
   * deployments). Opt-in; default false. Not forwarded to the native addon.
   */
  warmOnCreate?: boolean
  limits?: {
    maxUrlBytes?: number
    maxQueryBytes?: number
    maxCookieBytes?: number
    maxHeadersBytes?: number
    maxHeaders?: number
    maxPairs?: number
  }
}

/** The zero-alloc sync handler returned by `createIngressFast`. */
export interface IngressFastHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    requestId: string,
    fn: (result: FastIngressResult) => T,
  ): T
}

/**
 * Options accepted by `createIngressHandler` (path 2).
 *
 * Same native option surface as the fast path, minus `onError` — path 2
 * reports native failures through `BakedIngressRuntime.onError` instead of the
 * options bag.
 */
export type IngressHandlerOptions = Omit<IngressFastOptions, 'onError'>

import type { FastIngressResult } from './decode/fast-result'
import type { CorsOptions } from './headers/cors'
import type { SecurityHeadersOptions } from './headers/hsts'

const KNOWN_INGRESS_OPTION_KEYS: ReadonlySet<string> = new Set([
  'trustProxy',
  'trustedProxies',
  'parseCookies',
  'parseQuery',
  'requireJsonBody',
  'schema',
  'cors',
  'rateLimit',
  'security',
  'https',
  'maxBodyBytes',
  'enableSecurityHeaders',
  'enableRequestIds',
  'enableBodySizeGuard',
  'emitMetadataJson',
  'readBody',
  'outputBufferSize',
  'bodyTimeoutMs',
  'onError',
  'onRequest',
  'onResponse',
  'limits',
  'warmOnCreate',
])

/**
 * Throw if `options` contains a key the ingress pipeline does not know.
 *
 * `label` names the calling factory in the error so a typo is easy to map
 * back to the call site (both `createIngressFast` and `createIngressHandler`
 * validate the same option surface).
 */
export function assertKnownIngressOptions(
  options: IngressFastOptions,
  label = 'createIngressFast',
): void {
  for (const key of Object.keys(options)) {
    if (!KNOWN_INGRESS_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `${label}: unknown option '${key}'. ` +
          `Known options: ${[...KNOWN_INGRESS_OPTION_KEYS].sort().join(', ')}`,
      )
    }
  }
}

/** Numeric options that must be finite and non-negative (0 is meaningful, e.g.
 * `rateLimit.limit: 0` disables the limiter). Dotted = nested option. */
const NON_NEGATIVE_NUMBER_OPTIONS: ReadonlyArray<readonly [path: string, root: string]> = [
  ['maxBodyBytes', 'maxBodyBytes'],
  ['bodyTimeoutMs', 'bodyTimeoutMs'],
  ['outputBufferSize', 'outputBufferSize'],
  ['rateLimit.limit', 'rateLimit'],
  ['rateLimit.windowMs', 'rateLimit'],
  ['rateLimit.maxEntries', 'rateLimit'],
  ['limits.maxUrlBytes', 'limits'],
  ['limits.maxQueryBytes', 'limits'],
  ['limits.maxCookieBytes', 'limits'],
  ['limits.maxHeadersBytes', 'limits'],
  ['limits.maxHeaders', 'limits'],
  ['limits.maxPairs', 'limits'],
]

function assertNonNegativeNumber(value: unknown, path: string, label: string): void {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(
      `${label}: option '${path}' must be a finite, non-negative number (got ${value}).`,
    )
  }
}

/**
 * Fail-fast on non-finite / negative numeric option values. `assertKnownIngressOptions`
 * only checks the key set; a misconfigured negative value (e.g. `maxBodyBytes: -1`)
 * would otherwise silently corrupt the pipeline (a napi marshal error or an
 * always-rejecting limit).
 */
export function assertIngressOptionValues(
  options: IngressFastOptions,
  label = 'createIngressFast',
): void {
  for (const [path, root] of NON_NEGATIVE_NUMBER_OPTIONS) {
    if (path.includes('.')) {
      const [, inner] = path.split('.')
      const obj = (options as Record<string, unknown>)[root] as Record<string, unknown> | undefined
      assertNonNegativeNumber(obj?.[inner ?? ''], path, label)
    } else {
      assertNonNegativeNumber((options as Record<string, unknown>)[path], path, label)
    }
  }
}

let trustProxyWarned = false

/**
 * Warn once (per process) when the legacy `trustProxy: true` boolean is used.
 *
 * `trustProxy: true` makes the pipeline trust EVERY hop of
 * `X-Forwarded-For`/`X-Real-IP`, so a client can forge its IP and bypass
 * IP-based rate limiting. Prefer the `trustedProxies` network-list API and
 * only enable proxy trust behind a trusted edge.
 */
export function warnTrustProxyDeprecated(): void {
  if (trustProxyWarned) return
  trustProxyWarned = true
  console.warn(
    '[castrum] WARN: `trustProxy: true` is deprecated and trusts EVERY hop — ' +
      'clients can spoof X-Forwarded-For / X-Real-IP to bypass IP-based rate ' +
      'limiting. Use `trustedProxies: { enabled: true, networks: [...] }` and ' +
      'only enable proxy trust behind a trusted edge.',
  )
}
