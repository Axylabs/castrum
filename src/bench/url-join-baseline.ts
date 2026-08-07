// src/bench/url-join-baseline.ts — JS baselines for URL resolution + query build.
// WHATWG URL + encodeURIComponent (matches the Rust RFC 3986 output for the
// unreserved/space cases used). Bench-local only.

import { decoder, encoder } from "../shared/bytes";

/** Resolve a reference against a base using the WHATWG URL. */
export function nativeUrlResolve(
  base: Uint8Array,
  reference: Uint8Array,
): Uint8Array {
  const url = new URL(decoder.decode(reference), decoder.decode(base));
  return encoder.encode(url.href);
}

/** Build a percent-encoded query string (sorted keys, RFC 3986 style). */
export function nativeUrlEncodeQuery(
  params: Record<string, string>,
): Uint8Array {
  const keys = Object.keys(params).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(params[key] as string)}`,
    );
  }
  return encoder.encode(parts.join("&"));
}
