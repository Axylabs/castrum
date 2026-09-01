// src/ingress/headers/baked-templates.ts — Header-template builder (pre-baked
// path).
//
// Precomputes the 32 header-variant templates used by the pre-baked handler
// path (`ratelimit-*` header names, benchmark wire format).
//
// NOTE: this is the pre-baked-path template builder. The fast path has its own
// builder (./fast-templates.ts) with a different wire format (x-ratelimit-*) —
// do not unify them (see AGENTS.md).

import { HV_CORS_PREFLIGHT, HV_CORS_SIMPLE, HV_JSON, HV_RATE_ACTIVE } from '../constants'

/** Inputs needed to build the pre-baked header templates. */
export interface BakedTemplateParams {
  securityEntries: ReadonlyArray<[string, string]>
  cors?: {
    allowOrigin?: string[]
    allowMethods?: string[]
    allowHeaders?: string[]
    exposeHeaders?: string[]
    allowCredentials?: boolean
    maxAge?: number
  }
  corsAllowMethods: string
  corsAllowHeaders: string
  corsExposeHeaders: string
  corsMaxAge: string
  rateLimitStr: string
}

/**
 * Build the frozen, variant-indexed header templates.
 *
 * Returns two 32-entry sets:
 * - `regular`: the base templates.
 * - `terminal`: every regular template with `cache-control: no-store` appended
 *   (the header set used for terminal/error responses). Baking it in means the
 *   steady-state error path can return a frozen array with no per-response
 *   allocation or copy.
 */
export function buildBakedHeaderTemplates(params: BakedTemplateParams): {
  regular: ReadonlyArray<ReadonlyArray<[string, string]>>
  terminal: ReadonlyArray<ReadonlyArray<[string, string]>>
} {
  const {
    securityEntries,
    cors,
    corsAllowMethods,
    corsAllowHeaders,
    corsExposeHeaders,
    corsMaxAge,
    rateLimitStr,
  } = params

  const regular = Object.freeze(
    Array.from({ length: 32 }, (_, variant) => {
      const entries: [string, string][] = [...securityEntries]

      if ((variant & HV_JSON) !== 0) {
        entries.push(['content-type', 'application/json'])
      }

      if ((variant & HV_CORS_SIMPLE) !== 0) {
        entries.push(['vary', 'Origin'])
        if (cors?.allowCredentials) {
          entries.push(['access-control-allow-credentials', 'true'])
        }
        if (corsExposeHeaders.length > 0) {
          entries.push(['access-control-expose-headers', corsExposeHeaders])
        }
      }

      if ((variant & HV_CORS_PREFLIGHT) !== 0) {
        entries.push([
          'vary',
          'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        ])
        if (cors?.allowCredentials) {
          entries.push(['access-control-allow-credentials', 'true'])
        }
        entries.push(['access-control-allow-methods', corsAllowMethods])
        entries.push(['access-control-allow-headers', corsAllowHeaders])
        entries.push(['access-control-max-age', corsMaxAge])
      }

      if ((variant & HV_RATE_ACTIVE) !== 0) {
        entries.push(['ratelimit-limit', rateLimitStr])
      }

      return Object.freeze(entries)
    }),
  )

  const terminal = Object.freeze(
    regular.map((t) => {
      const entries: [string, string][] = [...t, ['cache-control', 'no-store']]
      return Object.freeze(entries)
    }),
  )

  return { regular, terminal }
}
