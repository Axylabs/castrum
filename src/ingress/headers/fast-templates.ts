// src/ingress/headers/fast-templates.ts — Header-template system (fast path).
//
// Precomputes, per ingress handler, the full cross product of header variants
// (HV_* bits) → header pairs, plus the per-request builder that applies the
// dynamic parts (origin echo, rate-limit counters, dynamic HSTS, request-id).
//
// NOTE: this is the fast-path (x-ratelimit-* / {"error":{...}}) template
// builder. The pre-baked path has its own builder (./baked-templates.ts) with
// a different wire format — do not unify them (see AGENTS.md).

import {
  HV_CORS_PREFLIGHT,
  HV_CORS_SIMPLE,
  HV_COUNT,
  HV_RATE_ACTIVE,
  HV_RATE_LIMITED,
} from '../constants'
import { secondsFromMs } from '../shared'
import { buildCorsStaticStrings, type CorsOptions, type CorsStaticStrings } from './cors'
import { buildHstsValue, buildSecurityPairs, type SecurityHeadersOptions } from './hsts'

/** A single precomputed header-variant template. */
export interface HeaderTemplate {
  readonly entries: ReadonlyArray<readonly [string, string]>
  readonly needsOriginEcho: boolean
  readonly needsRateDynamic: boolean
  readonly needsRetryAfter: boolean
  readonly needsDynamicHsts: boolean
}

/**
 * Fallback used only when a variant template is unexpectedly absent. All 32
 * variants are always built, so this never serves a real response.
 */
const EMPTY_HEADER_TEMPLATE: HeaderTemplate = Object.freeze({
  entries: [],
  needsOriginEcho: false,
  needsRateDynamic: false,
  needsRetryAfter: false,
  needsDynamicHsts: false,
})

/** Precomputed per-handler response context. */
export interface ResponseBuildContext {
  readonly templates: HeaderTemplate[]
  readonly corsStatic: CorsStaticStrings | null
  readonly hstsValue: string | null
}

/**
 * Build the full response context (header templates + static CORS strings +
 * HSTS value) for a handler configuration.
 */
export function buildResponseContext(options: {
  cors?: CorsOptions
  security?: SecurityHeadersOptions
  https?: boolean
  enableSecurityHeaders?: boolean
  rateLimit?: { limit?: number }
}): ResponseBuildContext {
  const templates = buildHeaderTemplates(options)
  const corsStatic = buildCorsStaticStrings(options.cors)
  const hstsValue = buildHstsValue(options.security ?? {})

  return { templates, corsStatic, hstsValue }
}

function buildHeaderTemplates(options: {
  cors?: CorsOptions
  security?: SecurityHeadersOptions
  https?: boolean
  enableSecurityHeaders?: boolean
  rateLimit?: { limit?: number }
}): HeaderTemplate[] {
  const templates: HeaderTemplate[] = new Array(HV_COUNT)

  const sec = options.security ?? {}
  const securityEnabled = options.enableSecurityHeaders !== false
  const corsStatic = buildCorsStaticStrings(options.cors)
  const hstsValue = buildHstsValue(sec)
  const hstsIsDynamic = options.https === undefined && hstsValue !== null

  // Single source of truth for security-option → header pairs (shared with the
  // pre-baked handlers.ts path — see buildSecurityPairs in ./hsts.ts), so a
  // security option can never be honored on one path and ignored on the other.
  const securityPairs = buildSecurityPairs(sec, options.https, securityEnabled)

  const corsVaryPairs: Array<[string, string]> = []

  if (corsStatic) {
    corsVaryPairs.push(['vary', 'Origin'])

    if (!corsStatic.isWildcard) {
      corsVaryPairs.push(['vary', 'Access-Control-Request-Method'])
      corsVaryPairs.push(['vary', 'Access-Control-Request-Headers'])
    }
  }

  const corsPolicyPairs: Array<[string, string]> = []

  if (corsStatic) {
    if (corsStatic.credentials) {
      corsPolicyPairs.push(['access-control-allow-credentials', 'true'])
    }

    if (corsStatic.exposeHeadersJoined) {
      corsPolicyPairs.push(['access-control-expose-headers', corsStatic.exposeHeadersJoined])
    }
  }

  const corsPreflightPairs: Array<[string, string]> = []

  if (corsStatic) {
    corsPreflightPairs.push(['access-control-allow-methods', corsStatic.allowMethodsJoined])

    if (corsStatic.allowHeadersJoined) {
      corsPreflightPairs.push(['access-control-allow-headers', corsStatic.allowHeadersJoined])
    }

    if (corsStatic.maxAgeString) {
      corsPreflightPairs.push(['access-control-max-age', corsStatic.maxAgeString])
    }
  }

  const rateLimitCeiling: Array<[string, string]> = []

  if (options.rateLimit?.limit && options.rateLimit.limit > 0) {
    rateLimitCeiling.push(['x-ratelimit-limit', String(options.rateLimit.limit)])
  }

  for (let variant = 0; variant < HV_COUNT; variant++) {
    const isCorsSimple = (variant & HV_CORS_SIMPLE) !== 0
    const isCorsPreflight = (variant & HV_CORS_PREFLIGHT) !== 0
    const isRateActive = (variant & HV_RATE_ACTIVE) !== 0
    const isRateLimited = (variant & HV_RATE_LIMITED) !== 0

    const entries: Array<[string, string]> = []

    if (securityEnabled) {
      for (const pair of securityPairs) {
        entries.push(pair)
      }
    }

    for (const pair of corsVaryPairs) {
      entries.push(pair)
    }

    if (isCorsSimple || isCorsPreflight) {
      for (const pair of corsPolicyPairs) {
        entries.push(pair)
      }
    }

    if (isCorsPreflight) {
      for (const pair of corsPreflightPairs) {
        entries.push(pair)
      }
    }

    if (isRateActive) {
      for (const pair of rateLimitCeiling) {
        entries.push(pair)
      }
    }

    templates[variant] = {
      entries,
      needsOriginEcho: isCorsSimple || isCorsPreflight,
      needsRateDynamic: isRateActive,
      needsRetryAfter: isRateLimited,
      needsDynamicHsts: hstsIsDynamic,
    }
  }

  return templates
}

/**
 * Build the response headers for a decoded result, applying the dynamic parts
 * (request-id, origin echo, rate-limit counters, retry-after, dynamic HSTS).
 */
export function headersForResult(
  ctx: ResponseBuildContext,
  r: {
    readonly headerVariant: number
    readonly corsAllowed: boolean
    readonly rateRemaining: number
    readonly rateResetMs: number
    readonly retryAfterMs: number
    readonly https: boolean
  },
  req: Request,
  requestId: string,
): Headers {
  const template =
    ctx.templates[r.headerVariant & 0x1f] ?? ctx.templates[0] ?? EMPTY_HEADER_TEMPLATE

  const headers = new Headers()

  for (const [name, value] of template.entries) {
    headers.append(name, value)
  }

  if (requestId) {
    headers.set('x-request-id', requestId)
  }

  if (template.needsOriginEcho && r.corsAllowed && ctx.corsStatic) {
    const origin = req.headers.get('origin')

    if (origin) {
      if (ctx.corsStatic.isWildcard && !ctx.corsStatic.credentials) {
        headers.set('access-control-allow-origin', '*')
      } else {
        headers.set('access-control-allow-origin', origin)
      }
    }
  }

  if (template.needsRateDynamic) {
    headers.set('x-ratelimit-remaining', String(Math.max(0, r.rateRemaining)))

    if (r.rateResetMs > 0) {
      headers.set('x-ratelimit-reset', String(secondsFromMs(r.rateResetMs)))
    }
  }

  if (template.needsRetryAfter && r.retryAfterMs > 0) {
    headers.set('retry-after', String(Math.max(1, secondsFromMs(r.retryAfterMs))))
  }

  if (template.needsDynamicHsts && r.https && ctx.hstsValue) {
    headers.set('strict-transport-security', ctx.hstsValue)
  }

  return headers
}
