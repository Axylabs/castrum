// src/ingress/headers/hsts.ts — Strict-Transport-Security value builder
// (fast path).

/** User-facing security-headers configuration. */
export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string;
  hsts?: boolean;
  hstsMaxAge?: number;
  hstsIncludeSubdomains?: boolean;
  hstsPreload?: boolean;
  frameOptions?: string;
  nosniff?: boolean;
  referrerPolicy?: string;
  coep?: string;
  coop?: string;
  corp?: string;
  xssProtection?: string;
}

/** Build the HSTS header value, or `null` when HSTS is not configured. */
export function buildHstsValue(sec: SecurityHeadersOptions): string | null {
  const wantHsts =
    sec.hsts === true ||
    sec.hstsMaxAge !== undefined ||
    sec.hstsIncludeSubdomains === true ||
    sec.hstsPreload === true;

  if (!wantHsts) return null;

  const maxAge = sec.hstsMaxAge ?? 31_536_000;
  let value = `max-age=${maxAge}`;

  if (sec.hstsIncludeSubdomains) value += "; includeSubDomains";
  if (sec.hstsPreload) value += "; preload";

  return value;
}
