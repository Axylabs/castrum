// src/ingress/options.ts — IngressFast option types + fail-fast validation.
//
// Options are forwarded to the native addon as a plain object; a misspelled
// key would otherwise be silently ignored. Validation against the known key
// set makes misconfiguration fail loudly at construction time.

/** Options accepted by `createIngressFast` / `createIngress`. */
export interface IngressFastOptions {
  trustProxy?: boolean;
  trustedProxies?: { enabled?: boolean; networks?: string[] };
  parseCookies?: boolean;
  parseQuery?: boolean;
  requireJsonBody?: boolean;
  schema?: Uint8Array;
  cors?: CorsOptions;
  rateLimit?: { limit?: number; windowMs?: number; maxEntries?: number };
  security?: SecurityHeadersOptions;
  https?: boolean;
  maxBodyBytes?: number;
  enableSecurityHeaders?: boolean;
  enableRequestIds?: boolean;
  enableBodySizeGuard?: boolean;
  emitMetadataJson?: boolean;
  readBody?: boolean;
  outputBufferSize?: number;
  /**
   * Invoked when the native pipeline throws (the request becomes a 500).
   * Native failures are otherwise silent in the fast path. Never throws.
   */
  onError?: (error: Error) => void;
  limits?: {
    maxUrlBytes?: number;
    maxQueryBytes?: number;
    maxCookieBytes?: number;
    maxHeadersBytes?: number;
    maxHeaders?: number;
    maxPairs?: number;
  };
}

/** The zero-alloc sync handler returned by `createIngressFast`. */
export interface IngressFastHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    requestId: string,
    fn: (result: FastIngressResult) => T,
  ): T;
}

import type { CorsOptions } from "./headers/cors";
import type { SecurityHeadersOptions } from "./headers/hsts";
import type { FastIngressResult } from "./decode/fast-result";

const KNOWN_INGRESS_OPTION_KEYS: ReadonlySet<string> = new Set([
  "trustProxy",
  "trustedProxies",
  "parseCookies",
  "parseQuery",
  "requireJsonBody",
  "schema",
  "cors",
  "rateLimit",
  "security",
  "https",
  "maxBodyBytes",
  "enableSecurityHeaders",
  "enableRequestIds",
  "enableBodySizeGuard",
  "emitMetadataJson",
  "readBody",
  "outputBufferSize",
  "limits",
]);

/** Throw if `options` contains a key the ingress pipeline does not know. */
export function assertKnownIngressOptions(options: IngressFastOptions): void {
  for (const key of Object.keys(options)) {
    if (!KNOWN_INGRESS_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `createIngressFast: unknown option '${key}'. ` +
          `Known options: ${[...KNOWN_INGRESS_OPTION_KEYS].sort().join(", ")}`,
      );
    }
  }
}

let trustProxyWarned = false;

/**
 * Warn once (per process) when the legacy `trustProxy: true` boolean is used.
 *
 * `trustProxy: true` makes the pipeline trust EVERY hop of
 * `X-Forwarded-For`/`X-Real-IP`, so a client can forge its IP and bypass
 * IP-based rate limiting. Prefer the `trustedProxies` network-list API and
 * only enable proxy trust behind a trusted edge.
 */
export function warnTrustProxyDeprecated(): void {
  if (trustProxyWarned) return;
  trustProxyWarned = true;
  console.warn(
    "[castrum] WARN: `trustProxy: true` is deprecated and trusts EVERY hop — " +
      "clients can spoof X-Forwarded-For / X-Real-IP to bypass IP-based rate " +
      "limiting. Use `trustedProxies: { enabled: true, networks: [...] }` and " +
      "only enable proxy trust behind a trusted edge.",
  );
}
