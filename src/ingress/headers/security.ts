// src/ingress/headers/security.ts — baked-path security header merge
//
// Merges the structured `options.security` (SecurityHeadersOptions) with raw
// `runtime.securityHeaders` pairs into the ordered entries the pre-baked
// handler prepends to every response variant. Raw pairs win on name conflicts;
// names are lowercased for the template merge.

import type { SecurityHeadersOptions } from './hsts'
import { buildSecurityPairs } from './hsts'

/**
 * Merge structured `options.security` with raw `runtime.securityHeaders` pairs
 * into the ordered entries the baked templates prepend to every response
 * variant. Raw pairs win on name conflicts; names are lowercased for the
 * template merge.
 *
 * The structured defaults (nosniff/DENY/no-referrer) are ONLY applied when the
 * user explicitly opted into security on this path (`security !== undefined`) —
 * the baked path's long-standing default is no security headers, and silently
 * adding them would change every response.
 *
 * @param security structured `SecurityHeadersOptions` from `options.security`
 *   (the same shape `createIngress` honors)
 * @param https   whether HTTPS is pinned (drives HSTS defaults)
 * @param raw     raw `runtime.securityHeaders` pairs (names lowercased)
 * @returns ordered `[name, value]` entries for the baked header templates
 */
export function buildBakedSecurityEntries(
  security: SecurityHeadersOptions | undefined,
  https: boolean | undefined,
  raw: ReadonlyArray<[string, string]> | undefined,
): Array<[string, string]> {
  const structured = security === undefined ? [] : buildSecurityPairs(security, https, true)

  if (raw === undefined || raw.length === 0) return structured

  const byName = new Map<string, string>()
  for (const [k, v] of structured) byName.set(k, v)
  for (const [k, v] of raw) byName.set(k.toLowerCase(), v)
  return [...byName.entries()]
}
