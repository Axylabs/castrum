// src/ingress/headers/memoized-headers.ts — memoized `Headers` for baked header arrays.
//
// `new Response(body, { headers })` copies its headers either way, but Bun
// re-parses an array-of-pairs on every construction whereas a persistent
// `Headers` instance is copied directly — measured ~1.4 µs cheaper per response
// with the full security + CORS set (398 ns vs 1832 ns), the single largest
// per-request JS cost on the success path.
//
// The arrays the ingress builds are themselves cached (the pre-baked templates
// and the per-origin cache return the SAME array instance across requests), so
// this memo hits on the steady state. Fresh per-request arrays (rate-limit /
// request-id extras) are simply never retained — a `WeakMap` lets them be
// collected, so the cache cannot grow without bound.
//
// The returned `Headers` is treated as IMMUTABLE: it is only ever handed to a
// `Response` constructor, which copies it. Verified: mutating the source array
// after construction, or one served response's headers, never leaks into
// another response.

/** Memoized `Headers` keyed by the identity of the baked header array. */
const CACHE = new WeakMap<readonly [string, string][], Headers>()

/**
 * Return a memoized `Headers` for a baked header array.
 *
 * @param entries Header pairs from a handler header builder (baked template,
 *   per-origin cache, or a fresh extras array).
 * @returns A `Headers` instance safe to pass to a `Response` constructor.
 * @example
 * ```ts
 * new Response(body, { status: 200, headers: memoizedHeaders(pairs) })
 * ```
 */
export function memoizedHeaders(entries: readonly [string, string][]): Headers {
  const existing = CACHE.get(entries)
  if (existing !== undefined) return existing
  const built = new Headers(entries as [string, string][])
  CACHE.set(entries, built)
  return built
}
