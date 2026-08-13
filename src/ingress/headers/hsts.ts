// src/ingress/headers/hsts.ts — Strict-Transport-Security value builder
// (fast path).

/** User-facing security-headers configuration. */
export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string
  hsts?: boolean
  hstsMaxAge?: number
  hstsIncludeSubdomains?: boolean
  hstsPreload?: boolean
  frameOptions?: string
  nosniff?: boolean
  referrerPolicy?: string
  coep?: string
  coop?: string
  corp?: string
  xssProtection?: string
}

/** Build the HSTS header value, or `null` when HSTS is not configured. */
export function buildHstsValue(sec: SecurityHeadersOptions): string | null {
  const wantHsts =
    sec.hsts === true ||
    sec.hstsMaxAge !== undefined ||
    sec.hstsIncludeSubdomains === true ||
    sec.hstsPreload === true

  if (!wantHsts) return null

  const maxAge = sec.hstsMaxAge ?? 31_536_000
  let value = `max-age=${maxAge}`

  if (sec.hstsIncludeSubdomains) value += '; includeSubDomains'
  if (sec.hstsPreload) value += '; preload'

  return value
}

/**
 * Convert structured `security` options into ordered `[name, value][]` pairs.
 *
 * Shared by BOTH header-template paths (`fast-templates.ts` and the pre-baked
 * `handlers.ts`) so a security option is honored consistently — it can never
 * be applied on one path and silently ignored on the other (the historic
 * "security-preheat gotcha"). `https === true` gates the static HSTS pair
 * (dynamic HSTS — `https` undefined — is handled per-request by the fast-path
 * response builder); `enabled === false` yields no pairs.
 */
export function buildSecurityPairs(
  security: SecurityHeadersOptions | undefined,
  https: boolean | undefined,
  enabled: boolean,
): Array<[string, string]> {
  if (!enabled) return []
  const sec = security ?? {}
  const pairs: Array<[string, string]> = []

  if (sec.nosniff !== false) {
    pairs.push(['x-content-type-options', 'nosniff'])
  }
  pairs.push(['x-frame-options', sec.frameOptions ?? 'DENY'])
  pairs.push(['referrer-policy', sec.referrerPolicy ?? 'no-referrer'])
  if (sec.xssProtection) {
    pairs.push(['x-xss-protection', sec.xssProtection])
  }
  if (sec.contentSecurityPolicy) {
    pairs.push(['content-security-policy', sec.contentSecurityPolicy])
  }
  if (sec.coep) {
    pairs.push(['cross-origin-embedder-policy', sec.coep])
  }
  if (sec.coop) {
    pairs.push(['cross-origin-opener-policy', sec.coop])
  }
  if (sec.corp) {
    pairs.push(['cross-origin-resource-policy', sec.corp])
  }
  const hstsValue = buildHstsValue(sec)
  if (hstsValue !== null && https === true) {
    pairs.push(['strict-transport-security', hstsValue])
  }
  return pairs
}
